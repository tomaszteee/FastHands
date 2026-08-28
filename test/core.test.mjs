import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(err => err ? reject(err) : resolve(port));
    });
  });
}

async function waitHealth(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (j.ok && j.mcpOnline) return j;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error(`Health timeout: ${url}`);
}

function toolText(result) {
  return (result.content || []).filter(x => x.type === 'text').map(x => x.text || '').join('\n');
}

async function callJson(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name + ' returned MCP error: ' + toolText(result));
  return JSON.parse(toolText(result));
}

test('core execution, degraded probe, interrupt/revise/resume', { timeout: 30000 }, async () => {
  await fs.rm(path.join(root, 'runtime'), { recursive: true, force: true });
  const monitorPort = await freePort();
  const mcpPort = await freePort();
  const env = {
    ...process.env,
    FAST_HANDS_MONITOR_PORT: String(monitorPort),
    FAST_HANDS_PORT: String(mcpPort),
    FAST_HANDS_WINDOWS_MCP: '__fast_hands_missing_windows_mcp__',
  };
  const child = spawn(process.execPath, [path.join(root, 'monitor-server.mjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', b => { stderr += b.toString(); });

  const client = new Client({ name: 'fast-hands-regression', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await waitHealth(`http://127.0.0.1:${monitorPort}/health`);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));

    const exec = await callJson(client, 'fast_exec', { command: '1+1' });
    assert.equal(exec.ok, true);
    assert.equal(exec.stdout.trim(), '2');

    const target = path.join(root, 'runtime', 'test-core.txt').replaceAll('\\', '/');
    const run = await callJson(client, 'fast_run', {
      label: 'regression-mixed',
      steps: [
        { kind: 'powershell', command: "'ps-ok'" },
        { kind: 'fs', op: 'write', path: target, content: 'fs-ok' },
        { kind: 'fs', op: 'read', path: target },
        { kind: 'exec', program: process.execPath, args: ['-e', 'process.stdout.write(\"exec-ok\\n\")'] },
        { kind: 'wait', ms: 20 },
      ],
    });
    assert.equal(run.status, 'COMPLETED');
    assert.deepEqual(new Set(run.pathsUsed), new Set(['POWERSHELL_PERSISTENT', 'NODE_FS', 'DIRECT_EXEC', 'WAIT']));

    const probe = await callJson(client, 'fast_probe', {});
    assert.equal(probe.ok, true);
    assert.equal(probe.coreOk, true);
    assert.equal(probe.degraded, process.platform === 'win32');
    assert.equal(probe.checks.windowsUiDirect.optional, true);
    if (process.platform === 'win32') assert.equal(probe.checks.windowsUiDirect.ok, false);
    else assert.equal(probe.checks.windowsUiDirect.disabled, true);

    const interruptedPromise = callJson(client, 'fast_run', {
      label: 'regression-interrupt',
      steps: [
        { kind: 'powershell', command: "'prefix-ok'" },
        { kind: 'wait', ms: 700 },
        { kind: 'powershell', command: "'ORIGINAL-TAIL-MUST-NOT-RUN'" },
      ],
    });
    const executionDeadline = Date.now() + 10000;
    let sawMiddleStep = false;
    while (Date.now() < executionDeadline) {
      const stateResponse = await fetch(`http://127.0.0.1:${monitorPort}/api/state`);
      if (stateResponse.ok) {
        const state = await stateResponse.json();
        if (state.execution?.status === 'RUNNING' && state.execution?.stepIndex === 1 && state.execution?.safePoint === 'CURRENT_ATOMIC_ACTION') {
          sawMiddleStep = true;
          break;
        }
      }
      await sleep(20);
    }
    assert.equal(sawMiddleStep, true, 'middle step never became active');
    const msg = await fetch(`http://127.0.0.1:${monitorPort}/api/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'replace remaining tail', interrupt: true }),
    });
    assert.equal(msg.status, 200);
    const interrupted = await interruptedPromise;
    assert.equal(interrupted.status, 'INTERRUPTED');
    assert.equal(interrupted.interruptReason, 'OPERATOR_MESSAGE');
    assert.equal(interrupted.nextStepIndex, 2);

    const revised = await callJson(client, 'fast_revise', {
      run_id: interrupted.runId,
      remaining_steps: [{ kind: 'powershell', command: "'REVISED-TAIL-OK'" }],
      note: 'regression replacement',
    });
    assert.equal(revised.nextStepIndex, 2);
    const resumed = await callJson(client, 'fast_resume', { run_id: interrupted.runId, acknowledge_uncertain: false });
    assert.equal(resumed.status, 'COMPLETED');
    assert.equal(resumed.results.at(-1).result.stdout.trim(), 'REVISED-TAIL-OK');
    assert.equal(JSON.stringify(resumed).includes('ORIGINAL-TAIL-MUST-NOT-RUN'), false);

    const control = async action => {
      const response = await fetch(`http://127.0.0.1:${monitorPort}/api/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      assert.equal(response.status, 200);
      return await response.json();
    };

    const pausePromise = callJson(client, 'fast_run', {
      label: 'regression-pause',
      steps: [{ kind: 'wait', ms: 500 }, { kind: 'powershell', command: "'PAUSE-RESUME-OK'" }],
    });
    await sleep(150);
    await control('pause');
    const paused = await pausePromise;
    assert.equal(paused.status, 'PAUSED');
    assert.equal(paused.interruptReason, 'OPERATOR_PAUSE');
    assert.equal(paused.nextStepIndex, 1);
    await control('resume');
    const pauseResumed = await callJson(client, 'fast_resume', { run_id: paused.runId, acknowledge_uncertain: false });
    assert.equal(pauseResumed.status, 'COMPLETED');
    assert.equal(pauseResumed.results.at(-1).result.stdout.trim(), 'PAUSE-RESUME-OK');

    const stopPromise = callJson(client, 'fast_run', {
      label: 'regression-emergency-stop',
      timeout_ms: 10000,
      steps: [{ kind: 'powershell', command: 'Start-Sleep -Seconds 5; "MUST-NOT-FINISH"' }],
    });
    await sleep(400);
    await control('stop');
    const stopped = await stopPromise;
    assert.equal(stopped.status, 'STOPPED');
    assert.equal(stopped.interruptReason, 'EMERGENCY_STOP');
    assert.equal(stopped.needsReview, true);
    assert.equal(stopped.nextStepIndex, 0);
    assert.equal(stopped.results[0].result.emergencyStopped, true);
    await control('reset');
    const blockedResume = await client.callTool({ name: 'fast_resume', arguments: { run_id: stopped.runId, acknowledge_uncertain: false } });
    assert.equal(blockedResume.isError, true);
  } finally {
    await client.close().catch(() => {});
    if (!child.killed) child.kill();
    await sleep(150);
    if (child.exitCode == null && process.platform === 'win32') {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
  assert.equal(stderr.includes('Unhandled'), false, stderr);
});

test('bundled macro uses shipped Windows UI Direct path', async () => {
  const macro = JSON.parse(await fs.readFile(path.join(root, 'macros', 'inspect_window.json'), 'utf8'));
  assert.equal(macro.steps.length > 0, true);
  assert.equal(macro.steps.every(s => s.kind === 'windows_ui'), true);
  assert.equal(macro.steps[0].tool, 'Snapshot');
});
