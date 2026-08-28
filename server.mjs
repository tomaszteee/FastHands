import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from "@modelcontextprotocol/node";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { windowsUiDirect } from './windows-ui-bridge.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(ROOT, 'runtime');
const RUNS = path.join(RUNTIME, 'runs');
const MACROS = path.join(ROOT, 'macros');
const OPERATOR = process.env.FAST_HANDS_LEGACY_UIA_OPERATOR || '';
const IS_WINDOWS = process.platform === 'win32';
const POWERSHELL_7 = 'C:/Program Files/PowerShell/7/pwsh.exe';
const WINDOWS_POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PERSISTENT_POWERSHELL = process.env.FAST_HANDS_PWSH || (IS_WINDOWS ? (fssync.existsSync(POWERSHELL_7) ? POWERSHELL_7 : (fssync.existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : 'pwsh.exe')) : 'pwsh');
const VENV_PYTHON = IS_WINDOWS ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
const PYTHON = process.env.FAST_HANDS_PYTHON || VENV_PYTHON;
const FASTWEB_SCRIPT = path.join(ROOT, 'integrations', 'fastweb', 'fast_web.py');
const YOUTUBE_SCRIPT = path.join(ROOT, 'integrations', 'youtube', 'research.py');
const POWERSHELL_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'powershell-host.ps1');
const TASKKILL = process.env.FAST_HANDS_TASKKILL || 'taskkill.exe';
const CONTROL_FILE = path.join(RUNTIME, 'control.json');
const EXECUTION_FILE = path.join(RUNTIME, 'execution.json');
const INBOX_FILE = path.join(RUNTIME, 'operator-inbox.jsonl');
const OUTBOX_FILE = path.join(RUNTIME, 'assistant-outbox.jsonl');
const EVENTS_FILE = path.join(RUNTIME, 'events.jsonl');
const DELIVERY_FILE = path.join(RUNTIME, 'delivery.json');
const HEARTBEAT_FILE = path.join(RUNTIME, 'monitor-heartbeat.json');
const VERSION = '0.6.7';
const MAX_UIA_BATCH = 8;

for (const dir of [RUNTIME, RUNS, MACROS]) await fs.mkdir(dir, { recursive: true });

const now = () => Date.now();
const iso = () => new Date().toISOString();
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || min));
const normalizeName = (name) => String(name || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
const defaultControl = () => ({ mode: 'RUN', revision: 0, messageSeq: 0, updatedAt: iso(), requestedBy: 'system', note: '' });
const defaultExecution = () => ({ status: 'IDLE', runId: null, label: null, stepIndex: null, totalSteps: null, stepKind: null, action: null, target: null, safePoint: 'IDLE', startedAt: null, updatedAt: iso(), detail: 'Fast Hands is idle.' });

async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  let lastError = null;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (error) {
        lastError = error;
        const retryable = ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
        if (!retryable || attempt === 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  throw lastError || new Error(`Failed to atomically write ${file}`);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return typeof fallback === 'function' ? fallback() : fallback; }
}
async function readJsonl(file, limit = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    let lines = text.split(/\r?\n/).filter(Boolean);
    if (limit) lines = lines.slice(-limit);
    const out = [];
    for (const line of lines) { try { out.push(JSON.parse(line)); } catch {} }
    return out;
  } catch { return []; }
}
async function appendJsonl(file, value) { await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8'); }
async function logEvent(type, data = {}) { await appendJsonl(EVENTS_FILE, { at: iso(), type, ...data }).catch(() => {}); }
async function setExecution(patch) {
  const current = await readJson(EXECUTION_FILE, defaultExecution);
  const next = { ...current, ...patch, updatedAt: iso() };
  await atomicJson(EXECUTION_FILE, next);
  return next;
}
if (!fssync.existsSync(CONTROL_FILE)) await atomicJson(CONTROL_FILE, defaultControl());
if (!fssync.existsSync(EXECUTION_FILE)) await atomicJson(EXECUTION_FILE, defaultExecution());
if (!fssync.existsSync(DELIVERY_FILE)) await atomicJson(DELIVERY_FILE, { lastDeliveredSeq: 0, updatedAt: iso() });

async function pendingOperatorMessages() {
  const [delivery, inbox] = await Promise.all([
    readJson(DELIVERY_FILE, { lastDeliveredSeq: 0 }),
    readJsonl(INBOX_FILE),
  ]);
  const last = Number(delivery.lastDeliveredSeq || 0);
  return inbox.filter(m => Number(m.seq || 0) > last).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}
async function markMessagesDelivered(messages) {
  if (!messages?.length) return;
  const maxSeq = Math.max(...messages.map(m => Number(m.seq || 0)));
  const current = await readJson(DELIVERY_FILE, { lastDeliveredSeq: 0 });
  if (maxSeq > Number(current.lastDeliveredSeq || 0)) await atomicJson(DELIVERY_FILE, { lastDeliveredSeq: maxSeq, updatedAt: iso() });
}

function stepMeta(step) {
  const kind = String(step?.kind || '').toLowerCase();
  const action = kind === 'uia' ? String(step.action || '')
    : kind === 'windows_ui' ? String(step.tool || '')
    : kind === 'fs' ? String(step.op || '')
    : kind === 'powershell' ? 'PowerShell'
    : (kind === 'exec' || kind === 'detached_exec') ? path.basename(String(step.program || ''))
    : kind === 'wait' ? 'wait' : '';
  const target = kind === 'uia' ? String(step.element || step.window || '')
    : kind === 'windows_ui' ? String(step.tool || '')
    : kind === 'fs' ? String(step.path || '')
    : kind === 'exec' ? String(step.program || '')
    : kind === 'powershell' ? String(step.cwd || '') : '';
  return { kind, action, target };
}

async function killProcessTree(pid) {
  if (!pid) return;
  if (IS_WINDOWS) {
    await new Promise(resolve => {
      const killer = spawn(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try { process.kill(-Number(pid), 'SIGKILL'); return; } catch {}
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
}

async function runProcess(program, args = [], options = {}) {
  const started = now();
  const timeoutMs = clamp(options.timeoutMs ?? 30000, 100, 600000);
  const maxBuffer = clamp(options.maxBuffer ?? 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let emergencyStopped = false;
  let pollBusy = false;
  let finished = false;

  return await new Promise((resolve) => {
    const child = spawn(program, args.map(String), {
      cwd: options.cwd || undefined,
      windowsHide: IS_WINDOWS,
      detached: !IS_WINDOWS,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const add = (which, chunk) => {
      const text = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + text).slice(-maxBuffer);
      else stderr = (stderr + text).slice(-maxBuffer);
    };
    child.stdout?.on('data', c => add('out', c));
    child.stderr?.on('data', c => add('err', c));

    const timeout = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid);
    }, timeoutMs);

    const poll = setInterval(async () => {
      if (finished || pollBusy) return;
      pollBusy = true;
      try {
        const control = await readJson(CONTROL_FILE, defaultControl);
        const pending = await pendingOperatorMessages();
        if (String(control.mode).toUpperCase() === 'STOP') {
          emergencyStopped = true;
          await setExecution({ status: 'STOPPING', safePoint: 'HARD_STOP', detail: 'Emergency stop requested; terminating current child process.' }).catch(() => {});
          await killProcessTree(child.pid);
        } else if (String(control.mode).toUpperCase() === 'PAUSE' || pending.some(m => m.interrupt !== false)) {
          await setExecution({ status: 'WAITING_SAFE_POINT', safePoint: 'CURRENT_ATOMIC_ACTION', detail: 'Operator interruption is waiting for the current atomic action to finish safely.' }).catch(() => {});
        }
      } finally { pollBusy = false; }
    }, 200);

    const done = (code, signal, error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(poll);
      const ok = !error && !timedOut && !emergencyStopped && code === 0;
      resolve({
        ok,
        elapsedMs: now() - started,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
        emergencyStopped,
        error: error?.message || (timedOut ? `Process timed out after ${timeoutMs} ms` : emergencyStopped ? 'Emergency stop terminated the process' : code === 0 ? null : `Process exited with code ${code}`),
      });
    };
    child.once('error', err => done(null, null, err));
    child.once('close', (code, signal) => done(code, signal));
  });
}

async function runPythonJson(script, args = [], timeoutMs = 120000) {
  if (!fssync.existsSync(script)) return { ok: false, error: `Integration script not found: ${script}` };
  const python = fssync.existsSync(PYTHON) ? PYTHON : (process.env.FAST_HANDS_PYTHON || 'python');
  const proc = await runProcess(python, [script, ...args], { timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  let parsed = null;
  try { parsed = JSON.parse(proc.stdout); } catch {}
  if (parsed) return { ...parsed, process: { exitCode: proc.exitCode, elapsedMs: proc.elapsedMs } };
  return { ok: false, error: proc.error || proc.stderr || 'Integration returned invalid JSON', stdout: proc.stdout, process: { exitCode: proc.exitCode, elapsedMs: proc.elapsedMs } };
}
class PersistentPowerShell {
  constructor() {
    this.child = null;
    this.current = null;
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  isAlive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start() {
    if (this.isAlive()) return { pid: this.child.pid, reused: true, generation: this.generation };
    this.generation += 1;
    const child = spawn(PERSISTENT_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', POWERSHELL_HOST], {
      windowsHide: IS_WINDOWS,
      detached: !IS_WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData('stdout', chunk));
    child.stderr.on('data', chunk => this.onData('stderr', chunk));
    child.once('error', error => this.onExit(null, null, error));
    child.once('close', (code, signal) => this.onExit(code, signal));
    this.child = child;
    return { pid: child.pid, reused: false, generation: this.generation };
  }

  onData(which, chunk) {
    const job = this.current;
    if (!job) return;
    const key = which === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    job[key] = (job[key] + String(chunk)).slice(-(job.maxBuffer + 4096));
    this.tryComplete(job);
  }

  tryComplete(job) {
    if (job.finished || this.current !== job) return;
    const outMatch = job.stdoutBuffer.match(job.stdoutPattern);
    const errIndex = job.stderrBuffer.indexOf(job.stderrMarker);
    if (!outMatch || errIndex < 0) return;
    const exitCode = Number(outMatch[1]);
    const stdout = job.stdoutBuffer.slice(0, outMatch.index);
    const stderr = job.stderrBuffer.slice(0, errIndex);
    this.finish(job, {
      ok: exitCode === 0,
      elapsedMs: now() - job.started,
      exitCode,
      signal: null,
      stdout,
      stderr,
      timedOut: false,
      emergencyStopped: false,
      error: exitCode === 0 ? null : `PowerShell command exited with code ${exitCode}`,
      shellPid: this.child?.pid ?? null,
      shellGeneration: this.generation,
      reusedShell: job.reused,
    });
  }

  onExit(code, signal, error = null) {
    const child = this.child;
    this.child = null;
    const job = this.current;
    if (job && !job.finished) {
      this.finish(job, {
        ok: false,
        elapsedMs: now() - job.started,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: job.stdoutBuffer,
        stderr: job.stderrBuffer,
        timedOut: job.timedOut,
        emergencyStopped: job.emergencyStopped,
        error: error?.message || (job.timedOut ? `Persistent PowerShell timed out after ${job.timeoutMs} ms` : job.emergencyStopped ? 'Emergency stop terminated persistent PowerShell' : `Persistent PowerShell exited unexpectedly${child?.pid ? ` (PID ${child.pid})` : ''}`),
        shellPid: child?.pid ?? null,
        shellGeneration: this.generation,
        reusedShell: job.reused,
      });
    }
  }

  finish(job, result) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timeout);
    clearInterval(job.poll);
    if (this.current === job) this.current = null;
    job.resolve(result);
  }

  async stopCurrent(reason) {
    const job = this.current;
    if (!job || job.finished) return;
    if (reason === 'timeout') job.timedOut = true;
    if (reason === 'emergency') job.emergencyStopped = true;
    await killProcessTree(this.child?.pid);
  }

  execute(command, options = {}) {
    const next = this.queue.catch(() => {}).then(() => this.executeQueued(command, options));
    this.queue = next;
    return next;
  }

  async executeQueued(command, options = {}) {
    const timeoutMs = clamp(options.timeoutMs ?? 30000, 100, 600000);
    const maxBuffer = clamp(options.maxBuffer ?? 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
    const shell = this.start();
    const id = crypto.randomUUID().replaceAll('-', '');
    const stdoutToken = `__FAST_HANDS_OUT_${id}__`;
    const stderrToken = `__FAST_HANDS_ERR_${id}__`;
    const requestLine = JSON.stringify({ id, command: String(command || ''), cwd: options.cwd || null });

    return await new Promise((resolve) => {
      const escapedToken = stdoutToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const job = {
        resolve,
        started: now(),
        timeoutMs,
        maxBuffer,
        reused: shell.reused,
        stdoutBuffer: '',
        stderrBuffer: '',
        stdoutPattern: new RegExp(`${escapedToken}:(-?\\d+):END`),
        stderrMarker: `${stderrToken}:END`,
        timedOut: false,
        emergencyStopped: false,
        finished: false,
        timeout: null,
        poll: null,
      };
      this.current = job;
      job.timeout = setTimeout(() => this.stopCurrent('timeout'), timeoutMs);
      job.poll = setInterval(async () => {
        if (job.finished) return;
        const control = await readJson(CONTROL_FILE, defaultControl);
        const pending = await pendingOperatorMessages();
        if (String(control.mode).toUpperCase() === 'STOP') {
          await setExecution({ status: 'STOPPING', safePoint: 'HARD_STOP', detail: 'Emergency stop requested; terminating persistent PowerShell.' }).catch(() => {});
          await this.stopCurrent('emergency');
        } else if (String(control.mode).toUpperCase() === 'PAUSE' || pending.some(message => message.interrupt !== false)) {
          await setExecution({ status: 'WAITING_SAFE_POINT', safePoint: 'CURRENT_ATOMIC_ACTION', detail: 'Operator interruption is waiting for the current PowerShell command to finish safely.' }).catch(() => {});
        }
      }, 100);
      this.child.stdin.write(`${requestLine}\r\n`, 'utf8', error => {
        if (error && !job.finished) {
          this.finish(job, {
            ok: false,
            elapsedMs: now() - job.started,
            exitCode: null,
            signal: null,
            stdout: job.stdoutBuffer,
            stderr: job.stderrBuffer,
            timedOut: false,
            emergencyStopped: false,
            error: error.message,
            shellPid: this.child?.pid ?? null,
            shellGeneration: this.generation,
            reusedShell: shell.reused,
          });
        }
      });
    });
  }

  dispose() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
    this.child = null;
  }
}

const persistentPowerShell = new PersistentPowerShell();

async function runUiaBlock(steps, failFast, timeoutMs) {
  const token = crypto.randomUUID();
  const file = path.join(RUNTIME, `uia-${token}.json`);
  await fs.writeFile(file, JSON.stringify({ failFast, steps }, null, 2), 'utf8');
  try {
    const proc = await runProcess(OPERATOR, ['batch', file], { timeoutMs: timeoutMs ?? 30000, maxBuffer: 32 * 1024 * 1024 });
    if (proc.emergencyStopped) return { ok: false, emergencyStopped: true, elapsedMs: proc.elapsedMs, error: proc.error, raw: proc.stdout };
    let parsed = null;
    try { parsed = JSON.parse(proc.stdout); } catch {}
    if (!proc.ok) return { ok: false, elapsedMs: proc.elapsedMs, error: proc.error || proc.stderr, raw: proc.stdout };
    return parsed || { ok: false, elapsedMs: proc.elapsedMs, error: 'UIA operator returned invalid JSON', raw: proc.stdout };
  } finally { await fs.rm(file, { force: true }).catch(() => {}); }
}

async function fsStep(step) {
  const op = String(step.op || '').toLowerCase();
  const p = step.path ? path.resolve(String(step.path)) : null;
  switch (op) {
    case 'read': {
      if (!p) throw new Error('fs.read requires path');
      const data = await fs.readFile(p, step.encoding || 'utf8');
      return { path: p, data: String(data).slice(0, clamp(step.maxChars ?? 2_000_000, 1, 8_000_000)) };
    }
    case 'write': {
      if (!p) throw new Error('fs.write requires path');
      await fs.mkdir(path.dirname(p), { recursive: true });
      if (step.append) await fs.appendFile(p, String(step.content ?? ''), step.encoding || 'utf8');
      else await fs.writeFile(p, String(step.content ?? ''), step.encoding || 'utf8');
      return { path: p, bytes: (await fs.stat(p)).size };
    }
    case 'mkdir':
      if (!p) throw new Error('fs.mkdir requires path');
      await fs.mkdir(p, { recursive: step.recursive !== false });
      return { path: p };
    case 'list': {
      if (!p) throw new Error('fs.list requires path');
      const entries = await fs.readdir(p, { withFileTypes: true });
      return { path: p, entries: entries.slice(0, clamp(step.limit ?? 500, 1, 5000)).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' })) };
    }
    case 'stat': {
      if (!p) throw new Error('fs.stat requires path');
      const s = await fs.stat(p);
      return { path: p, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtime: s.mtime.toISOString() };
    }
    case 'exists': return { path: p, exists: !!p && fssync.existsSync(p) };
    case 'copy': {
      if (!p || !step.destination) throw new Error('fs.copy requires path and destination');
      const dest = path.resolve(String(step.destination));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(p, dest, { recursive: step.recursive !== false, force: step.force !== false });
      return { from: p, to: dest };
    }
    case 'move': {
      if (!p || !step.destination) throw new Error('fs.move requires path and destination');
      const dest = path.resolve(String(step.destination));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try { await fs.rename(p, dest); }
      catch { await fs.cp(p, dest, { recursive: true, force: true }); await fs.rm(p, { recursive: true, force: true }); }
      return { from: p, to: dest };
    }
    case 'delete':
      if (!p) throw new Error('fs.delete requires path');
      await fs.rm(p, { recursive: !!step.recursive, force: !!step.force });
      return { path: p, deleted: true };
    default: throw new Error(`Unsupported fs op: ${op}`);
  }
}

function isUia(step) { return String(step?.kind || '').toLowerCase() === 'uia'; }
function toUiaStep(step) {
  const out = { action: step.action };
  for (const k of ['window', 'element', 'value', 'limit', 'ms']) if (step[k] !== undefined) out[k] = step[k];
  return out;
}

async function controlledWait(ms) {
  const until = now() + clamp(ms, 0, 60000);
  while (now() < until) {
    const control = await readJson(CONTROL_FILE, defaultControl);
    if (String(control.mode).toUpperCase() === 'STOP') return { stopped: true };
    await new Promise(r => setTimeout(r, Math.min(100, Math.max(1, until - now()))));
  }
  return { stopped: false, ms };
}

function runFile(id) { return path.join(RUNS, `${normalizeName(id)}.json`); }
async function saveRun(run) { run.updatedAt = iso(); await atomicJson(runFile(run.id), run); }
async function loadRun(id) { return JSON.parse(await fs.readFile(runFile(id), 'utf8')); }

async function fingerprintArtifact(file) {
  const resolved = path.resolve(String(file));
  let stat;
  try { stat = await fs.lstat(resolved); }
  catch (error) {
    if (error?.code === 'ENOENT') return { path: resolved, kind: 'missing' };
    throw error;
  }
  if (stat.isFile()) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fssync.createReadStream(resolved);
      stream.on('data', chunk => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    return { path: resolved, kind: 'file', size: stat.size, sha256: hash.digest('hex') };
  }
  if (stat.isSymbolicLink()) return { path: resolved, kind: 'symlink', target: await fs.readlink(resolved) };
  if (stat.isDirectory()) return { path: resolved, kind: 'directory' };
  return { path: resolved, kind: 'other', size: stat.size };
}

function fingerprintEqual(expected, actual) {
  if (!expected || !actual || expected.kind !== actual.kind) return false;
  if (expected.kind === 'file') return expected.size === actual.size && expected.sha256 === actual.sha256;
  if (expected.kind === 'symlink') return expected.target === actual.target;
  if (expected.kind === 'other') return expected.size === actual.size;
  return true;
}

function declaredArtifactPaths(step, result) {
  const out = new Set();
  const add = value => { if (typeof value === 'string' && value.trim()) out.add(path.resolve(value)); };
  if (String(step?.kind || '').toLowerCase() === 'fs') {
    add(step.path);
    add(step.destination);
    add(result?.path);
    add(result?.from);
    add(result?.to);
  }
  if (Array.isArray(step?.artifacts)) for (const value of step.artifacts) add(value);
  return [...out];
}

async function trackStepArtifacts(run, step, result) {
  const paths = new Set(Array.isArray(run.artifactPaths) ? run.artifactPaths : []);
  for (const file of declaredArtifactPaths(step, result)) paths.add(file);
  run.artifactPaths = [...paths].sort();
}

async function refreshArtifactSnapshot(run) {
  const snapshot = {};
  for (const file of Array.isArray(run.artifactPaths) ? run.artifactPaths : []) {
    snapshot[file] = await fingerprintArtifact(file);
  }
  run.artifactSnapshot = snapshot;
  return snapshot;
}

async function detectWorkspaceDrift(run) {
  const expected = run.artifactSnapshot && typeof run.artifactSnapshot === 'object' ? run.artifactSnapshot : {};
  const drift = [];
  for (const [file, before] of Object.entries(expected)) {
    const current = await fingerprintArtifact(file);
    if (!fingerprintEqual(before, current)) drift.push({ path: file, expected: before, current });
  }
  return drift;
}

async function createRun(steps, failFast, timeoutMs, label = null) {
  const id = `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const run = {
    id,
    version: VERSION,
    label: label || 'Fast Hands job',
    createdAt: iso(), updatedAt: iso(), startedAt: null, completedAt: null,
    status: 'READY', failFast, timeoutMs, steps, nextIndex: 0,
    results: [], pathsUsed: [], checkpoints: [{ at: iso(), nextIndex: 0, reason: 'RUN_CREATED' }],
    artifactPaths: [], artifactSnapshot: {}, workspaceDrift: [],
    needsReview: false, stopReason: null,
  };
  await saveRun(run);
  return run;
}

async function checkpoint(run, nextIndex, reason) {
  run.nextIndex = nextIndex;
  await refreshArtifactSnapshot(run);
  run.checkpoints.push({ at: iso(), nextIndex, reason, artifactCount: Object.keys(run.artifactSnapshot || {}).length });
  if (run.checkpoints.length > 200) run.checkpoints = run.checkpoints.slice(-200);
  await saveRun(run);
  await logEvent('checkpoint', { runId: run.id, stepIndex: nextIndex, message: reason });
}

async function safePoint(run, where) {
  const control = await readJson(CONTROL_FILE, defaultControl);
  const pending = await pendingOperatorMessages();
  const interrupting = pending.filter(m => m.interrupt !== false);
  const common = { runId: run.id, label: run.label, stepIndex: run.nextIndex, totalSteps: run.steps.length, safePoint: where };

  if (String(control.mode).toUpperCase() === 'STOP') {
    run.status = 'STOPPED'; run.stopReason = 'OPERATOR_STOP';
    await saveRun(run);
    await setExecution({ ...common, status: 'STOPPED', detail: 'Operator emergency stop is active.' });
    await logEvent('run_stopped', { runId: run.id, stepIndex: run.nextIndex, message: 'Operator STOP at safe point.' });
    return { interrupt: true, reason: 'OPERATOR_STOP', messages: pending };
  }
  if (String(control.mode).toUpperCase() === 'PAUSE') {
    run.status = 'PAUSED';
    await saveRun(run);
    await setExecution({ ...common, status: 'PAUSED', detail: 'Paused at a safe checkpoint. Resume will continue from nextIndex.' });
    await logEvent('run_paused', { runId: run.id, stepIndex: run.nextIndex, message: 'Manual pause at safe point.' });
    return { interrupt: true, reason: 'OPERATOR_PAUSE', messages: pending };
  }
  if (interrupting.length) {
    await markMessagesDelivered(pending);
    run.status = 'INTERRUPTED';
    await saveRun(run);
    await setExecution({ ...common, status: 'INTERRUPTED', detail: `Operator message interrupted at safe point; ${pending.length} message(s) delivered to the assistant.` });
    await logEvent('operator_interrupt', { runId: run.id, stepIndex: run.nextIndex, message: `Delivered ${pending.length} operator message(s).` });
    return { interrupt: true, reason: 'OPERATOR_MESSAGE', messages: pending };
  }
  return { interrupt: false, messages: pending };
}

function publicResult(run, extra = {}) {
  return {
    ok: run.status === 'COMPLETED',
    runId: run.id,
    label: run.label,
    status: run.status,
    elapsedMs: run.startedAt ? new Date(run.updatedAt).getTime() - new Date(run.startedAt).getTime() : 0,
    requestedSteps: run.steps.length,
    nextStepIndex: run.nextIndex,
    completedThroughIndex: run.nextIndex - 1,
    resumeAvailable: ['PAUSED', 'INTERRUPTED', 'FAILED', 'STOPPED', 'READY', 'DRIFTED'].includes(run.status),
    needsReview: !!run.needsReview,
    workspaceDrift: Array.isArray(run.workspaceDrift) ? run.workspaceDrift : [],
    trackedArtifactCount: Object.keys(run.artifactSnapshot || {}).length,
    pathsUsed: [...new Set(run.pathsUsed)],
    results: run.results,
    lastCheckpoint: run.checkpoints.at(-1) || null,
    ...extra,
  };
}

async function executeRun(run) {
  if (!run.startedAt) run.startedAt = iso();
  run.status = 'RUNNING';
  await saveRun(run);
  await setExecution({ status: 'RUNNING', runId: run.id, label: run.label, stepIndex: run.nextIndex, totalSteps: run.steps.length, stepKind: null, action: null, target: null, safePoint: 'BEFORE_STEP', startedAt: run.startedAt, detail: 'Run started.' });
  await logEvent('run_started', { runId: run.id, stepIndex: run.nextIndex, message: run.label });

  let i = run.nextIndex;
  while (i < run.steps.length) {
    run.nextIndex = i;
    const gate = await safePoint(run, 'BEFORE_STEP');
    if (gate.interrupt) return publicResult(run, { interrupted: true, interruptReason: gate.reason, operatorMessages: gate.messages });

    if (isUia(run.steps[i])) {
      const blockStart = i;
      const block = [];
      while (i < run.steps.length && isUia(run.steps[i]) && block.length < MAX_UIA_BATCH) {
        block.push(toUiaStep(run.steps[i]));
        i++;
        if (run.steps[i - 1]?.checkpoint === true) break;
      }
      const meta = stepMeta(run.steps[blockStart]);
      await setExecution({ status: 'RUNNING', runId: run.id, label: run.label, stepIndex: blockStart, totalSteps: run.steps.length, stepKind: `uia-batch:${block.length}`, action: meta.action, target: meta.target, safePoint: 'CURRENT_ATOMIC_ACTION', detail: `Executing ${block.length} UIA action(s) in one FlaUI batch.` });
      await logEvent('step_started', { runId: run.id, stepIndex: blockStart, message: `UIA batch x${block.length}` });
      const s = now();
      const r = await runUiaBlock(block, run.failFast, run.timeoutMs);
      run.pathsUsed.push('UIA_BATCH');
      run.results.push({ index: blockStart, kind: 'uia-block', stepCount: block.length, ok: !!r.ok, elapsedMs: now() - s, result: r });
      if (r.emergencyStopped) {
        run.status = 'STOPPED'; run.needsReview = true; run.stopReason = 'HARD_STOP_DURING_UIA'; run.nextIndex = blockStart;
        await saveRun(run);
        await setExecution({ status: 'STOPPED', runId: run.id, label: run.label, stepIndex: blockStart, totalSteps: run.steps.length, stepKind: 'uia-block', safePoint: 'UNCERTAIN_AFTER_HARD_STOP', detail: 'UIA batch was hard-stopped; partial execution is possible. Review before resume.' });
        await logEvent('hard_stop_uncertain', { runId: run.id, stepIndex: blockStart, message: 'UIA block may be partially applied.' });
        return publicResult(run, { interrupted: true, interruptReason: 'EMERGENCY_STOP', operatorMessages: await pendingOperatorMessages() });
      }
      await logEvent(r.ok ? 'step_completed' : 'step_failed', { runId: run.id, stepIndex: blockStart, message: `UIA batch x${block.length}` });
      if (!r.ok && run.failFast) {
        run.status = 'FAILED'; run.nextIndex = blockStart; await saveRun(run);
        await setExecution({ status: 'FAILED', runId: run.id, label: run.label, stepIndex: blockStart, totalSteps: run.steps.length, stepKind: 'uia-block', safePoint: 'FAILED_STEP', detail: r.error || 'UIA batch failed.' });
        return publicResult(run, { interrupted: false, error: r.error || 'UIA batch failed' });
      }
      await checkpoint(run, i, 'UIA_BLOCK_COMPLETED');
      const after = await safePoint(run, 'AFTER_UIA_BLOCK');
      if (after.interrupt) return publicResult(run, { interrupted: true, interruptReason: after.reason, operatorMessages: after.messages });
      continue;
    }

    const step = run.steps[i];
    const meta = stepMeta(step);
    const s = now();
    await setExecution({ status: 'RUNNING', runId: run.id, label: run.label, stepIndex: i, totalSteps: run.steps.length, stepKind: meta.kind, action: meta.action, target: meta.target, safePoint: 'CURRENT_ATOMIC_ACTION', detail: 'Executing atomic action.' });
    await logEvent('step_started', { runId: run.id, stepIndex: i, message: `${meta.kind}:${meta.action}` });

    let result;
    try {
      if (meta.kind === 'detached_exec') {
        if (!step.program) throw new Error('detached_exec requires program');
        run.pathsUsed.push('DETACHED_EXEC');
        const child = spawn(String(step.program), Array.isArray(step.args) ? step.args.map(String) : [], {
          cwd: step.cwd || undefined,
          windowsHide: IS_WINDOWS && step.windows_hide !== false,
          env: { ...process.env, ...(step.env || {}) },
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        result = { ok: true, pid: child.pid, detached: true };
      } else if (meta.kind === 'exec') {
        if (!step.program) throw new Error('exec requires program');
        run.pathsUsed.push('DIRECT_EXEC');
        result = await runProcess(String(step.program), Array.isArray(step.args) ? step.args : [], { cwd: step.cwd, timeoutMs: step.timeout_ms ?? run.timeoutMs, env: step.env });
        if (result.emergencyStopped) {
          run.results.push({ index: i, kind: meta.kind, ok: false, elapsedMs: now() - s, result });
          run.status = 'STOPPED'; run.needsReview = true; run.stopReason = 'HARD_STOP_DURING_PROCESS'; run.nextIndex = i;
          await saveRun(run);
          await setExecution({ status: 'STOPPED', runId: run.id, label: run.label, stepIndex: i, totalSteps: run.steps.length, stepKind: meta.kind, safePoint: 'UNCERTAIN_AFTER_HARD_STOP', detail: 'Child process was terminated by emergency stop. Review before retry.' });
          await logEvent('hard_stop_uncertain', { runId: run.id, stepIndex: i, message: 'Child process terminated.' });
          return publicResult(run, { interrupted: true, interruptReason: 'EMERGENCY_STOP', operatorMessages: await pendingOperatorMessages() });
        }
        if (!result.ok) throw new Error(result.error || result.stderr || 'process failed');
      } else if (meta.kind === 'powershell') {
        run.pathsUsed.push('POWERSHELL_PERSISTENT');
        result = await persistentPowerShell.execute(String(step.command || ''), { cwd: step.cwd, timeoutMs: step.timeout_ms ?? run.timeoutMs, maxBuffer: step.max_output_bytes });
        if (result.emergencyStopped) {
          run.results.push({ index: i, kind: meta.kind, ok: false, elapsedMs: now() - s, result });
          run.status = 'STOPPED'; run.needsReview = true; run.stopReason = 'HARD_STOP_DURING_PROCESS'; run.nextIndex = i;
          await saveRun(run);
          await setExecution({ status: 'STOPPED', runId: run.id, label: run.label, stepIndex: i, totalSteps: run.steps.length, stepKind: meta.kind, safePoint: 'UNCERTAIN_AFTER_HARD_STOP', detail: 'PowerShell was terminated by emergency stop. Review before retry.' });
          await logEvent('hard_stop_uncertain', { runId: run.id, stepIndex: i, message: 'PowerShell terminated.' });
          return publicResult(run, { interrupted: true, interruptReason: 'EMERGENCY_STOP', operatorMessages: await pendingOperatorMessages() });
        }
        if (!result.ok) throw new Error(result.error || result.stderr || 'powershell failed');
      } else if (meta.kind === 'windows_ui') {
        if (!IS_WINDOWS) throw new Error('windows_ui is available only on Windows');
        if (!step.tool) throw new Error('windows_ui requires tool');
        run.pathsUsed.push('WINDOWS_UI_DIRECT');
        result = await windowsUiDirect.call(String(step.tool), step.arguments && typeof step.arguments === 'object' ? step.arguments : {});
        if (result?.isError) {
          const detail = (result.content || []).filter(x => x?.type === 'text').map(x => x.text || '').join('\n').trim();
          throw new Error(detail || `Windows UI tool failed: ${step.tool}`);
        }
      } else if (meta.kind === 'fs') {
        run.pathsUsed.push('NODE_FS');
        result = await fsStep(step);
      } else if (meta.kind === 'wait') {
        run.pathsUsed.push('WAIT');
        result = await controlledWait(step.ms ?? 100);
        if (result.stopped) {
          run.status = 'STOPPED'; run.nextIndex = i; await saveRun(run);
          return publicResult(run, { interrupted: true, interruptReason: 'OPERATOR_STOP', operatorMessages: await pendingOperatorMessages() });
        }
      } else throw new Error(`Unsupported step kind: ${meta.kind}`);

      run.results.push({ index: i, kind: meta.kind, ok: true, elapsedMs: now() - s, result });
      await trackStepArtifacts(run, step, result);
      await logEvent('step_completed', { runId: run.id, stepIndex: i, message: `${meta.kind}:${meta.action}` });
      i++;
      await checkpoint(run, i, 'STEP_COMPLETED');
    } catch (error) {
      run.results.push({ index: i, kind: meta.kind, ok: false, elapsedMs: now() - s, error: error?.message || String(error), result });
      await logEvent('step_failed', { runId: run.id, stepIndex: i, message: error?.message || String(error) });
      if (run.failFast) {
        run.status = 'FAILED'; run.nextIndex = i; await saveRun(run);
        await setExecution({ status: 'FAILED', runId: run.id, label: run.label, stepIndex: i, totalSteps: run.steps.length, stepKind: meta.kind, action: meta.action, target: meta.target, safePoint: 'FAILED_STEP', detail: error?.message || String(error) });
        return publicResult(run, { interrupted: false, error: error?.message || String(error) });
      }
      i++;
      await checkpoint(run, i, 'FAILED_STEP_SKIPPED_FAIL_FAST_FALSE');
    }

    const after = await safePoint(run, 'AFTER_STEP');
    if (after.interrupt) return publicResult(run, { interrupted: true, interruptReason: after.reason, operatorMessages: after.messages });
  }

  run.status = run.results.every(r => r.ok) ? 'COMPLETED' : 'COMPLETED_WITH_ERRORS';
  run.completedAt = iso(); run.nextIndex = run.steps.length;
  await saveRun(run);
  const pending = await pendingOperatorMessages();
  if (pending.length) await markMessagesDelivered(pending);
  await setExecution({ status: run.status, runId: run.id, label: run.label, stepIndex: run.steps.length ? run.steps.length - 1 : null, totalSteps: run.steps.length, stepKind: null, action: null, target: null, safePoint: 'RUN_COMPLETE', detail: `Run finished: ${run.status}.` });
  await logEvent('run_completed', { runId: run.id, stepIndex: run.steps.length, message: run.status });
  return publicResult(run, { interrupted: false, operatorMessages: pending });
}

function substitute(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => vars?.[k] === undefined ? `{{${k}}}` : String(vars[k]));
  if (Array.isArray(value)) return value.map(v => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

async function captureScreenshot(target = 'all') {
  if (!IS_WINDOWS) throw new Error('fast_screenshot desktop capture is available only on Windows');
  const id = crypto.randomUUID();
  const out = path.join(RUNTIME, `screen-${id}.png`);
  const rectExpr = target === 'primary' ? '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds' : '[System.Windows.Forms.SystemInformation]::VirtualScreen';
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=${rectExpr}; $b=New-Object System.Drawing.Bitmap $r.Width,$r.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.Left,$r.Top,0,0,$b.Size); $b.Save('${out.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`;
  const proc = await runProcess(PERSISTENT_POWERSHELL, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script], { timeoutMs: 15000 });
  if (!proc.ok) throw new Error(proc.error || proc.stderr);
  const data = await fs.readFile(out);
  return { path: out, data: data.toString('base64') };
}

function createMcpServer() {
const server = new McpServer({ name: 'fast-hands', version: VERSION });

function compactPowerShellResult(runResult) {
  const entry = runResult.results?.at(-1) || null;
  const result = entry?.result || {};
  return {
    ok: !!entry?.ok,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode ?? null,
    elapsedMs: entry?.elapsedMs ?? result.elapsedMs ?? runResult.elapsedMs,
    shellPid: result.shellPid ?? null,
    shellGeneration: result.shellGeneration ?? null,
    reusedShell: !!result.reusedShell,
    timedOut: !!result.timedOut,
    emergencyStopped: !!result.emergencyStopped,
    error: entry?.error || result.error || null,
    runId: runResult.runId,
    status: runResult.status,
    interrupted: !!runResult.interrupted,
    interruptReason: runResult.interruptReason || null,
    operatorMessages: runResult.operatorMessages || [],
  };
}

const uiTargetShape = {
  automation_id: z.string().optional(),
  control_type: z.string().optional(),
  label: z.number().int().optional(),
  loc: z.array(z.number().int()).length(2).optional(),
  name: z.string().optional(),
  name_match: z.enum(['exact','contains','matches']).optional(),
  nth: z.number().int().optional(),
  occurrence: z.string().optional(),
};

server.registerTool('fast_ui_tools', { description: 'List the complete Windows UI Direct tool surface currently available behind Fast Hands.', inputSchema: z.object({ refresh: z.boolean().default(false) }) }, async ({ refresh }) => {
  const tools = await windowsUiDirect.listTools(refresh);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, bridge: windowsUiDirect.status(), count: tools.length, tools: tools.map(t => ({ name: t.name, description: t.description })) }, null, 2) }] };
});

server.registerTool('fast_ui_call', { description: 'FULL Windows UI Direct passthrough via Fast Hands. Calls any tool exposed by windows-mcp-server, preserving its guardrails and result content.', inputSchema: z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.any()).default({}) }) }, async ({ tool, arguments: args }) => {
  return await windowsUiDirect.call(tool, args);
});

server.registerTool('fast_ui_guardrail', { description: 'Read Windows UI Direct guardrail/device posture through Fast Hands.', inputSchema: z.object({}) }, async () => await windowsUiDirect.call('GuardrailStatus', {}));
server.registerTool('fast_ui_snapshot', { description: 'Capture Windows UI Direct accessibility-tree snapshot through Fast Hands.', inputSchema: z.object({ all_windows: z.boolean().default(false) }) }, async ({ all_windows }) => await windowsUiDirect.call('Snapshot', { all_windows }));
server.registerTool('fast_ui_capture_evidence', { description: 'Capture Windows UI Direct screenshot + labeled UI tree evidence through Fast Hands.', inputSchema: z.object({ label: z.string().optional() }) }, async (args) => await windowsUiDirect.call('CaptureEvidence', args));
server.registerTool('fast_ui_screenshot', { description: 'Capture the complete virtual desktop through Windows UI Direct.', inputSchema: z.object({}) }, async () => await windowsUiDirect.call('Screenshot', {}));
server.registerTool('fast_ui_click', { description: 'Click/hover a Windows UI element using Windows UI Direct.', inputSchema: z.object({ ...uiTargetShape, button: z.enum(['left','right','middle']).optional(), clicks: z.number().int().min(0).max(2).optional() }) }, async (args) => await windowsUiDirect.call('Click', args));
server.registerTool('fast_ui_type', { description: 'Type text into a Windows UI element using Windows UI Direct.', inputSchema: z.object({ ...uiTargetShape, text: z.string(), clear: z.boolean().optional(), press_enter: z.boolean().optional() }) }, async (args) => await windowsUiDirect.call('Type', args));
server.registerTool('fast_ui_invoke', { description: 'Act via a native UI Automation control pattern using Windows UI Direct.', inputSchema: z.object({ ...uiTargetShape, action: z.enum(['invoke','set_value','toggle','select','expand','collapse']).optional(), value: z.string().optional() }) }, async (args) => await windowsUiDirect.call('Invoke', args));
server.registerTool('fast_ui_get_text', { description: 'Read a Windows UI element name/value through Windows UI Direct.', inputSchema: z.object({ ...uiTargetShape }) }, async (args) => await windowsUiDirect.call('GetText', args));
server.registerTool('fast_ui_wait', { description: 'Wait for the Windows UI to settle using Windows UI Direct.', inputSchema: z.object({ duration: z.number().int().min(0).max(60) }) }, async ({ duration }) => await windowsUiDirect.call('Wait', { duration }));
server.registerTool('fast_web_search', { description: 'Search the public web locally through the optional FastWeb integration.', inputSchema: z.object({ query: z.string().min(1), top: z.number().int().min(1).max(25).default(10) }) }, async ({ query, top }) => ({ content: [{ type: 'text', text: JSON.stringify(await runPythonJson(FASTWEB_SCRIPT, ['search', query, '--top', String(top)], 60000), null, 2) }] }));
server.registerTool('fast_web_read', { description: 'Read and extract a public web page locally, with browser fallback when configured.', inputSchema: z.object({ url: z.string().url(), max_chars: z.number().int().min(500).max(200000).default(20000), force_browser: z.boolean().default(false), no_browser: z.boolean().default(false) }) }, async ({ url, max_chars, force_browser, no_browser }) => { const args=['read',url,'--max-chars',String(max_chars)]; if(force_browser) args.push('--force-browser'); if(no_browser) args.push('--no-browser'); return { content: [{ type: 'text', text: JSON.stringify(await runPythonJson(FASTWEB_SCRIPT,args,90000), null, 2) }] }; });
server.registerTool('fast_web_deep', { description: 'Search multiple public web sources and read the top results locally through FastWeb.', inputSchema: z.object({ query: z.string().min(1), top: z.number().int().min(1).max(10).default(5), max_chars: z.number().int().min(500).max(50000).default(12000) }) }, async ({ query, top, max_chars }) => ({ content: [{ type: 'text', text: JSON.stringify(await runPythonJson(FASTWEB_SCRIPT,['deep',query,'--top',String(top),'--max-chars',String(max_chars)],120000), null, 2) }] }));
server.registerTool('youtube_research', { description: 'Search YouTube, inspect metadata, fetch transcripts, optionally use local Whisper, and optionally extract frames.', inputSchema: z.object({ input: z.string().min(1), top: z.number().int().min(1).max(25).default(8), transcripts: z.number().int().min(0).max(25).default(0), whisper: z.boolean().default(false), force_whisper: z.boolean().default(false), frames: z.number().int().min(0).max(12).default(0) }) }, async ({ input, top, transcripts, whisper, force_whisper, frames }) => { const args=[input,'--top',String(top),'--transcripts',String(transcripts),'--frames',String(frames)]; if(whisper) args.push('--whisper'); if(force_whisper) args.push('--force-whisper'); return { content: [{ type: 'text', text: JSON.stringify(await runPythonJson(YOUTUBE_SCRIPT,args,300000), null, 2) }] }; });
server.registerTool('fast_exec', { description: 'ULTRA-LOW-LATENCY execute-and-return path. Runs one command in a persistent hidden PowerShell process and returns clean stdout, stderr and exitCode while preserving Fast Hands checkpoints and operator Pause/Stop/errata safety.', inputSchema: z.object({
          command: z.string(),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(100).max(600000).default(30000),
          max_output_bytes: z.number().int().min(65536).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
        }) }, async ({ command, cwd, timeout_ms, max_output_bytes }) => {
          const run = await createRun([{ kind: 'powershell', command, cwd, timeout_ms, max_output_bytes }], true, timeout_ms, 'fast_exec');
          const result = await executeRun(run);
          return { content: [{ type: 'text', text: JSON.stringify(compactPowerShellResult(result), null, 2) }] };
        });

server.registerTool('fast_batch', { description: 'Execute 1-200 PowerShell commands in one tool call through one persistent hidden process. Each command keeps a durable safe-point checkpoint and returns separate stdout, stderr and exitCode.', inputSchema: z.object({
          commands: z.array(z.union([
            z.string(),
            z.object({
              command: z.string(),
              cwd: z.string().optional(),
              timeout_ms: z.number().int().min(100).max(600000).optional(),
              max_output_bytes: z.number().int().min(65536).max(64 * 1024 * 1024).optional(),
            }),
          ])).min(1).max(200),
          fail_fast: z.boolean().default(true),
          timeout_ms: z.number().int().min(100).max(600000).default(30000),
          label: z.string().max(160).optional(),
        }) }, async ({ commands, fail_fast, timeout_ms, label }) => {
          const steps = commands.map(item => typeof item === 'string'
            ? { kind: 'powershell', command: item, timeout_ms }
            : { kind: 'powershell', timeout_ms, ...item });
          const run = await createRun(steps, fail_fast, timeout_ms, label || `fast_batch x${steps.length}`);
          const result = await executeRun(run);
          const results = result.results.map(entry => ({
            index: entry.index,
            ok: entry.ok,
            elapsedMs: entry.elapsedMs,
            stdout: entry.result?.stdout || '',
            stderr: entry.result?.stderr || '',
            exitCode: entry.result?.exitCode ?? null,
            shellPid: entry.result?.shellPid ?? null,
            shellGeneration: entry.result?.shellGeneration ?? null,
            reusedShell: !!entry.result?.reusedShell,
            timedOut: !!entry.result?.timedOut,
            emergencyStopped: !!entry.result?.emergencyStopped,
            error: entry.error || entry.result?.error || null,
          }));
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: result.ok,
            runId: result.runId,
            status: result.status,
            elapsedMs: result.elapsedMs,
            requestedCommands: steps.length,
            completedCommands: results.length,
            interrupted: !!result.interrupted,
            interruptReason: result.interruptReason || null,
            operatorMessages: result.operatorMessages || [],
            results,
          }, null, 2) }] };
        });

server.registerTool('fast_run', { description: 'PRIMARY FAST PATH with live operator control. Executes many actions, persists a checkpoint after every safe unit, and returns immediately to the calling assistant when the operator sends an interrupting errata or presses Pause. Emergency Stop terminates child processes and marks uncertain work for review.', inputSchema: z.object({
          steps: z.array(z.any()).min(1).max(200),
          fail_fast: z.boolean().default(true),
          timeout_ms: z.number().int().min(100).max(600000).default(30000),
          label: z.string().max(160).optional(),
        }) }, async ({ steps, fail_fast, timeout_ms, label }) => {
          const run = await createRun(steps, fail_fast, timeout_ms, label);
          return { content: [{ type: 'text', text: JSON.stringify(await executeRun(run), null, 2) }] };
        });

server.registerTool('fast_resume', { description: 'Resume a paused/interrupted/failed Fast Hands run from its durable nextStepIndex checkpoint. Before continuing, verifies tracked file artifacts with SHA-256 + size and blocks on workspace drift. Hard-stopped uncertain runs require acknowledge_uncertain=true after review.', inputSchema: z.object({
          run_id: z.string().min(1),
          acknowledge_uncertain: z.boolean().default(false),
        }) }, async ({ run_id, acknowledge_uncertain }) => {
          const run = await loadRun(run_id);
          if (run.status === 'RUNNING') throw new Error('Run is already RUNNING');
          if (run.needsReview && !acknowledge_uncertain) throw new Error('Run was hard-stopped during an atomic action. Review state first, then resume with acknowledge_uncertain=true only if retrying from nextStepIndex is safe.');
          const drift = await detectWorkspaceDrift(run);
          if (drift.length) {
            run.status = 'DRIFTED';
            run.stopReason = 'WORKSPACE_DRIFT_DETECTED';
            run.workspaceDrift = drift;
            await saveRun(run);
            await setExecution({ status: 'DRIFTED', runId: run.id, label: run.label, stepIndex: run.nextIndex, totalSteps: run.steps.length, stepKind: null, action: null, target: null, safePoint: 'WORKSPACE_DRIFT_DETECTED', detail: `Resume blocked: ${drift.length} tracked artifact(s) changed since the last checkpoint.` });
            await logEvent('workspace_drift', { runId: run.id, stepIndex: run.nextIndex, message: `${drift.length} tracked artifact(s) changed since checkpoint.` });
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'WORKSPACE_DRIFT_DETECTED', status: run.status, runId: run.id, nextStepIndex: run.nextIndex, drift, message: 'Resume blocked because tracked workspace artifacts no longer match the last checkpoint.' }, null, 2) }] };
          }
          run.workspaceDrift = [];
          if (run.stopReason === 'WORKSPACE_DRIFT_DETECTED') run.stopReason = null;
          if (run.needsReview && acknowledge_uncertain) run.needsReview = false;
          run.status = 'READY';
          await saveRun(run);
          return { content: [{ type: 'text', text: JSON.stringify(await executeRun(run), null, 2) }] };
        });

server.registerTool('fast_revise', { description: 'After an operator errata, replace only the NOT-YET-EXECUTED tail of a paused/interrupted run while preserving completed results/checkpoints. Then use fast_resume.', inputSchema: z.object({
          run_id: z.string().min(1),
          remaining_steps: z.array(z.any()).max(200),
          note: z.string().max(500).optional(),
        }) }, async ({ run_id, remaining_steps, note }) => {
          const run = await loadRun(run_id);
          if (run.status === 'RUNNING') throw new Error('Cannot revise a RUNNING run');
          if (run.needsReview) throw new Error('Cannot revise until uncertain hard-stop state is reviewed');
          const prefix = run.steps.slice(0, run.nextIndex);
          run.steps = [...prefix, ...remaining_steps];
          run.status = 'READY';
          run.completedAt = null;
          await saveRun(run);
          await logEvent('run_revised', { runId: run.id, stepIndex: run.nextIndex, message: note || `Replaced remaining tail with ${remaining_steps.length} step(s).` });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, runId: run.id, preservedCompletedSteps: run.nextIndex, newRemainingSteps: remaining_steps.length, totalSteps: run.steps.length, nextStepIndex: run.nextIndex, note: note || null }, null, 2) }] };
        });

server.registerTool('run_state', { description: 'Read durable Fast Hands run state/checkpoint without executing it.', inputSchema: z.object({
          run_id: z.string().min(1),
          include_steps: z.boolean().default(false),
        }) }, async ({ run_id, include_steps }) => {
          const run = await loadRun(run_id);
          const out = { ...publicResult(run), checkpoints: run.checkpoints, stopReason: run.stopReason };
          if (include_steps) out.steps = run.steps;
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        });

server.registerTool('operator_state', { description: 'Read live monitor/control state, current execution, pending operator messages and recent events.', inputSchema: z.object({
          recent_events: z.number().int().min(0).max(200).default(50),
        }) }, async ({ recent_events }) => {
          const [control, execution, delivery, pending, events, heartbeat] = await Promise.all([
            readJson(CONTROL_FILE, defaultControl), readJson(EXECUTION_FILE, defaultExecution), readJson(DELIVERY_FILE, { lastDeliveredSeq: 0 }), pendingOperatorMessages(), readJsonl(EVENTS_FILE, recent_events), readJson(HEARTBEAT_FILE, null),
          ]);
          const heartbeatAgeMs = heartbeat?.at ? now() - new Date(heartbeat.at).getTime() : null;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, control, execution, delivery, pendingMessages: pending, events, monitor: { heartbeat, heartbeatAgeMs, online: heartbeatAgeMs !== null && heartbeatAgeMs < 3000 } }, null, 2) }] };
        });

server.registerTool('operator_inbox', { description: 'Read messages/errata typed by the operator in Fast Hands Monitor. ack=true marks returned messages delivered so they do not interrupt again.', inputSchema: z.object({
          ack: z.boolean().default(false),
        }) }, async ({ ack }) => {
          const messages = await pendingOperatorMessages();
          if (ack) await markMessagesDelivered(messages);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: messages.length, messages, acknowledged: ack }, null, 2) }] };
        });

server.registerTool('operator_reply', { description: 'Write an assistant response into the local Fast Hands Monitor chat panel.', inputSchema: z.object({
          text: z.string().min(1).max(12000),
          in_reply_to_seq: z.number().int().min(0).optional(),
        }) }, async ({ text, in_reply_to_seq }) => {
          const item = { id: crypto.randomUUID(), at: iso(), text, source: 'assistant', inReplyToSeq: in_reply_to_seq ?? null };
          await appendJsonl(OUTBOX_FILE, item);
          await logEvent('assistant_reply', { message: in_reply_to_seq == null ? 'Assistant replied in monitor.' : `Assistant replied to operator message #${in_reply_to_seq}.` });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, reply: item }, null, 2) }] };
        });

server.registerTool('fast_screenshot', { description: 'Visual fallback only. Capture primary or all displays when direct CLI/UIA is insufficient.', inputSchema: z.object({
          target: z.enum(['primary','all']).default('all'),
        }) }, async ({ target }) => {
          const shot = await captureScreenshot(target);
          return { content: [
            { type: 'text', text: JSON.stringify({ ok: true, path: shot.path, strategy: 'VISUAL_FALLBACK' }) },
            { type: 'image', data: shot.data, mimeType: 'image/png' },
          ] };
        });

server.registerTool('macro_manage', { description: 'Save, inspect, list or delete reusable fast_run workflows.', inputSchema: z.object({
          action: z.enum(['save','get','list','delete']), name: z.string().optional(), steps: z.array(z.any()).optional(), fail_fast: z.boolean().default(true),
        }) }, async ({ action, name, steps, fail_fast }) => {
          if (action === 'list') {
            const files = (await fs.readdir(MACROS)).filter(x => x.endsWith('.json')).sort();
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, macros: files.map(x => x.slice(0, -5)) }, null, 2) }] };
          }
          const safe = normalizeName(name);
          if (!safe) throw new Error('name is required');
          const file = path.join(MACROS, `${safe}.json`);
          if (action === 'save') {
            if (!Array.isArray(steps) || !steps.length) throw new Error('steps are required for save');
            await fs.writeFile(file, JSON.stringify({ name: safe, failFast: fail_fast, steps }, null, 2), 'utf8');
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, saved: safe, stepCount: steps.length }) }] };
          }
          if (action === 'get') return { content: [{ type: 'text', text: JSON.stringify({ ok: true, macro: JSON.parse(await fs.readFile(file, 'utf8')) }, null, 2) }] };
          await fs.rm(file, { force: true });
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deleted: safe }) }] };
        });

server.registerTool('macro_run', { description: 'Run a saved workflow with Fast Hands checkpoints/operator interrupts. String placeholders like {{name}} are substituted from vars.', inputSchema: z.object({
          name: z.string().min(1), vars: z.record(z.string(), z.any()).default({}), timeout_ms: z.number().int().min(100).max(600000).default(30000), label: z.string().max(160).optional(),
        }) }, async ({ name, vars, timeout_ms, label }) => {
          const safe = normalizeName(name);
          const macro = JSON.parse(await fs.readFile(path.join(MACROS, `${safe}.json`), 'utf8'));
          const run = await createRun(substitute(macro.steps, vars), macro.failFast !== false, timeout_ms, label || `Macro: ${safe}`);
          return { content: [{ type: 'text', text: JSON.stringify(await executeRun(run), null, 2) }] };
        });

server.registerTool('fast_probe', { description: 'Measure Fast Hands paths and verify operator, monitor daemon and runtime availability.', inputSchema: z.object({}) }, async () => {
          const started = now();
          const checks = {};
          checks.legacyUiaConfigured = !!OPERATOR && fssync.existsSync(OPERATOR);
          checks.nodeFs = await fsStep({ op: 'exists', path: ROOT });
          if (checks.legacyUiaConfigured) {
            const uiaStart = now();
            const uia = await runUiaBlock([{ action: 'windows' }], true, 15000);
            checks.legacyUia = { ok: !!uia.ok, elapsedMs: now() - uiaStart, windowCount: uia?.results?.[0]?.result?.windows?.length ?? null };
          } else checks.legacyUia = { ok: null, disabled: true };
          const psStart = now();
          const ps = await persistentPowerShell.execute('$PSVersionTable.PSVersion.ToString()', { timeoutMs: 10000 });
          checks.powershell = { ok: ps.ok, elapsedMs: now() - psStart, version: ps.stdout.trim(), pid: ps.shellPid, reused: ps.reusedShell };
          const windowsUiStart = now();
          if (!IS_WINDOWS) {
            checks.windowsUiDirect = { ok: null, disabled: true, platform: process.platform, elapsedMs: now() - windowsUiStart, bridge: windowsUiDirect.status() };
          } else try {
            const guard = await windowsUiDirect.call('GuardrailStatus', {});
            const tools = await windowsUiDirect.listTools(false);
            checks.windowsUiDirect = { ok: !guard?.isError, elapsedMs: now() - windowsUiStart, toolCount: tools.length, bridge: windowsUiDirect.status() };
          } catch (error) {
            checks.windowsUiDirect = { ok: false, elapsedMs: now() - windowsUiStart, error: error?.message || String(error), bridge: windowsUiDirect.status() };
          }
          const hb = await readJson(HEARTBEAT_FILE, null);
          const hbAge = hb?.at ? now() - new Date(hb.at).getTime() : null;
          checks.monitor = { online: hbAge !== null && hbAge < 3000, heartbeatAgeMs: hbAge, port: hb?.port ?? 8796 };
          const requireWindowsUi = String(process.env.FAST_HANDS_REQUIRE_WINDOWS_UI || '').trim() === '1';
          const coreOk = !!checks.nodeFs?.exists && !!checks.powershell?.ok;
          const windowsUiOk = !IS_WINDOWS ? !requireWindowsUi : !!checks.windowsUiDirect?.ok;
          checks.windowsUiDirect.required = requireWindowsUi;
          checks.windowsUiDirect.optional = !requireWindowsUi;
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: coreOk && (!requireWindowsUi || windowsUiOk),
            coreOk,
            degraded: coreOk && IS_WINDOWS && !windowsUiOk,
            version: VERSION,
            platform: process.platform,
            arch: process.arch,
            elapsedMs: now() - started,
            priority: ['DIRECT_EXEC/NODE_FS','WINDOWS_UI_DIRECT','LEGACY_UIA_OPTIONAL','WEB_RESEARCH_OPTIONAL','YOUTUBE_RESEARCH_OPTIONAL','MACRO','VISUAL_FALLBACK'],
            safety: ['SAFE_POINT_BEFORE_AND_AFTER_EACH_STEP','DURABLE_RESUME_CHECKPOINT','WORKSPACE_DRIFT_SHA256','OPERATOR_MESSAGE_INTERRUPT','MANUAL_PAUSE','EMERGENCY_STOP','WINDOWS_UI_DIRECT_GUARDRAILS'],
            checks,
          }, null, 2) }] };
        });

return server;
}

async function readHttpJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('MCP request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

if (process.argv.includes('--http')) {
  const host = '127.0.0.1';
  const port = Number(process.env.FAST_HANDS_PORT || 8797);
  const handler = createMcpHandler(() => createMcpServer(), { legacy: 'reject' });
  const nodeMcpHandler = toNodeHandler(handler);
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const body = Buffer.from(JSON.stringify({ ok: true, name: 'fast-hands-mcp', version: VERSION, protocol: '2026-07-28-modern-only', pid: process.pid, port, persistentPowerShellPid: persistentPowerShell.child?.pid ?? null }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      await nodeMcpHandler(req, res);
    } catch (error) {
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: error?.message || String(error) }, id: null }));
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
        res.end(body);
      }
    }
  });
  httpServer.listen(port, host);
  const shutdown = async () => {
    persistentPowerShell.dispose();
    await windowsUiDirect.close().catch(() => {});
    httpServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => { persistentPowerShell.dispose(); windowsUiDirect.close().catch(() => {}); });
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', () => { persistentPowerShell.dispose(); windowsUiDirect.close().catch(() => {}); });
  process.once('exit', () => { persistentPowerShell.dispose(); windowsUiDirect.close().catch(() => {}); });
}
