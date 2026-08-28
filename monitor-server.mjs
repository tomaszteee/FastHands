import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(ROOT, 'runtime');
const CONTROL_FILE = path.join(RUNTIME, 'control.json');
const EXECUTION_FILE = path.join(RUNTIME, 'execution.json');
const INBOX_FILE = path.join(RUNTIME, 'operator-inbox.jsonl');
const OUTBOX_FILE = path.join(RUNTIME, 'assistant-outbox.jsonl');
const EVENTS_FILE = path.join(RUNTIME, 'events.jsonl');
const DELIVERY_FILE = path.join(RUNTIME, 'delivery.json');
const HEARTBEAT_FILE = path.join(RUNTIME, 'monitor-heartbeat.json');
const UI_FILE = path.join(ROOT, 'monitor.html');
const HOST = '127.0.0.1';
const PORT = Number(process.env.FAST_HANDS_MONITOR_PORT || 8796);
const MCP_PORT = Number(process.env.FAST_HANDS_PORT || 8797);
const MCP_SERVER_FILE = path.join(ROOT, 'server.mjs');

let mcpChild = null;
let mcpRestartTimer = null;
let shuttingDown = false;

function mcpHealth() {
  return new Promise(resolve => {
    const request = http.get({ hostname: HOST, port: MCP_PORT, path: '/health', timeout: 750 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function launchMcpServer() {
  if (shuttingDown || mcpChild) return;
  mcpChild = spawn(process.execPath, [MCP_SERVER_FILE, '--http'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
  });
  mcpChild.once('close', () => {
    mcpChild = null;
    if (!shuttingDown) mcpRestartTimer = setTimeout(launchMcpServer, 2000);
  });
}

async function ensureMcpServer() {
  if (!await mcpHealth()) launchMcpServer();
}

await fs.mkdir(RUNTIME, { recursive: true });

const defaultControl = () => ({
  mode: 'RUN',
  revision: 0,
  messageSeq: 0,
  updatedAt: new Date().toISOString(),
  requestedBy: 'system',
  note: '',
});

const defaultExecution = () => ({
  status: 'IDLE',
  runId: null,
  label: null,
  stepIndex: null,
  totalSteps: null,
  stepKind: null,
  action: null,
  target: null,
  safePoint: 'IDLE',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  detail: 'Fast Hands is idle.',
});

async function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return typeof fallback === 'function' ? fallback() : fallback; }
}

async function readJsonl(file, limit = 100) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

async function appendJsonl(file, value) {
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

if (!fssync.existsSync(CONTROL_FILE)) await atomicJson(CONTROL_FILE, defaultControl());
if (!fssync.existsSync(EXECUTION_FILE)) await atomicJson(EXECUTION_FILE, defaultExecution());
if (!fssync.existsSync(DELIVERY_FILE)) await atomicJson(DELIVERY_FILE, { lastDeliveredSeq: 0, updatedAt: new Date().toISOString() });

async function setControl(patch) {
  const current = await readJson(CONTROL_FILE, defaultControl);
  const next = {
    ...current,
    ...patch,
    revision: Number(current.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    requestedBy: patch.requestedBy || 'operator',
  };
  await atomicJson(CONTROL_FILE, next);
  return next;
}

async function sendOperatorMessage(text, interrupt = true) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Message is empty');
  const control = await readJson(CONTROL_FILE, defaultControl);
  const seq = Number(control.messageSeq || 0) + 1;
  const message = {
    seq,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    text: clean.slice(0, 12000),
    interrupt: interrupt !== false,
    source: 'monitor',
  };
  await appendJsonl(INBOX_FILE, message);
  await setControl({ messageSeq: seq, requestedBy: 'operator', note: interrupt ? 'Operator message requested a safe-point interrupt.' : 'Operator message queued.' });
  return message;
}

async function snapshot() {
  const [control, execution, delivery, inbox, outbox, events, heartbeat] = await Promise.all([
    readJson(CONTROL_FILE, defaultControl),
    readJson(EXECUTION_FILE, defaultExecution),
    readJson(DELIVERY_FILE, { lastDeliveredSeq: 0 }),
    readJsonl(INBOX_FILE, 80),
    readJsonl(OUTBOX_FILE, 80),
    readJsonl(EVENTS_FILE, 120),
    readJson(HEARTBEAT_FILE, null),
  ]);
  return {
    now: new Date().toISOString(),
    control,
    execution,
    delivery,
    inbox,
    outbox,
    events,
    heartbeat,
    pendingMessages: inbox.filter(x => Number(x.seq || 0) > Number(delivery.lastDeliveredSeq || 0)),
  };
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function bodyJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const sseClients = new Set();
let cachedUi = null;
async function sendSseState() {
  if (!sseClients.size) return;
  const data = `event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(data); }
    catch { sseClients.delete(res); }
  }
}

setInterval(async () => {
  await atomicJson(HEARTBEAT_FILE, { pid: process.pid, port: PORT, at: new Date().toISOString() }).catch(() => {});
  await sendSseState().catch(() => {});
}, 500).unref();

// Re-check the worker even when this monitor did not create the currently
// running instance (for example after a monitor restart or Windows logon race).
// The child close handler remains the fast recovery path; this interval closes
// the adoption gap without changing operator Pause/Stop/checkpoint semantics.
setInterval(() => {
  ensureMcpServer().catch(() => {});
}, 2000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/monitor')) {
      cachedUi ??= await fs.readFile(UI_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': cachedUi.length,
        'Cache-Control': 'no-store',
      });
      res.end(cachedUi);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await snapshot());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/control') {
      const body = await bodyJson(req);
      const action = String(body.action || '').toLowerCase();
      if (action === 'pause') json(res, 200, { ok: true, control: await setControl({ mode: 'PAUSE', note: 'Manual pause requested.' }) });
      else if (action === 'resume') json(res, 200, { ok: true, control: await setControl({ mode: 'RUN', note: 'Manual resume requested.' }) });
      else if (action === 'stop') json(res, 200, { ok: true, control: await setControl({ mode: 'STOP', note: 'EMERGENCY STOP requested.' }) });
      else if (action === 'reset') json(res, 200, { ok: true, control: await setControl({ mode: 'RUN', note: 'Stop state cleared.' }) });
      else json(res, 400, { ok: false, error: 'Unknown action' });
      await sendSseState();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await bodyJson(req);
      const message = await sendOperatorMessage(body.text, body.interrupt !== false);
      json(res, 200, { ok: true, message });
      await sendSseState();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reload-ui') {
      cachedUi = null;
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, name: 'fast-hands-monitor', version: '0.6.0', pid: process.pid, port: PORT, mcpPort: MCP_PORT, mcpOnline: await mcpHealth() });
      return;
    }

    json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    json(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, async () => {
  await atomicJson(HEARTBEAT_FILE, { pid: process.pid, port: PORT, at: new Date().toISOString() }).catch(() => {});
  await ensureMcpServer();
  console.log(`Fast Hands Monitor: http://${HOST}:${PORT}`);
});

function shutdown() {
  shuttingDown = true;
  if (mcpRestartTimer) clearTimeout(mcpRestartTimer);
  try { mcpChild?.kill(); } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
