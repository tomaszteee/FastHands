import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WINDOWS_MCP_EXE = process.env.FAST_HANDS_WINDOWS_MCP || 'windows-mcp-server';
export const WINDOWS_MCP_LOG = path.join(HERE, 'runtime', 'windows-mcp-fast-hands.log');

class WindowsUiDirectBridge {
  constructor() {
    this.client = null;
    this.transport = null;
    this.connecting = null;
    this.tools = null;
    this.startedAt = null;
    this.lastError = null;
  }

  async connect() {
    if (process.platform !== 'win32') throw new Error('Windows UI Direct is available only on Windows');
    if (this.client && this.transport) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async _connect() {
    await this.close().catch(() => {});
    const transport = new StdioClientTransport({
      command: WINDOWS_MCP_EXE,
      args: ['stdio', '--toolsets', 'all', '--log-file', WINDOWS_MCP_LOG],
      cwd: path.isAbsolute(WINDOWS_MCP_EXE) ? path.dirname(WINDOWS_MCP_EXE) : HERE,
      stderr: 'ignore',
      maxBufferSize: 32 * 1024 * 1024,
    });
    const client = new Client(
      { name: 'fast-hands-windows-ui-direct', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' }, defaultCacheTtlMs: 5000 }
    );
    transport.onerror = (err) => { this.lastError = err?.message || String(err); };
    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = null;
        this.transport = null;
        this.tools = null;
      }
    };
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
    this.tools = listed.tools || [];
    return client;
  }

  async call(name, args = {}, { retry = true } = {}) {
    try {
      const client = await this.connect();
      const result = await client.callTool({ name, arguments: args || {} });
      return result;
    } catch (error) {
      this.lastError = error?.message || String(error);
      if (!retry) throw error;
      await this.close().catch(() => {});
      const client = await this.connect();
      return await client.callTool({ name, arguments: args || {} });
    }
  }

  async listTools(refresh = false) {
    const client = await this.connect();
    const result = await client.listTools(undefined, { cacheMode: refresh ? 'refresh' : 'use' });
    this.tools = result.tools || [];
    return this.tools;
  }

  status() {
    return {
      connected: !!this.client,
      pid: this.transport?.pid ?? null,
      startedAt: this.startedAt,
      toolCount: this.tools?.length ?? null,
      lastError: this.lastError,
      executable: WINDOWS_MCP_EXE,
    };
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.tools = null;
    if (client) await client.close().catch(() => {});
    else if (transport) await transport.close().catch(() => {});
  }
}

export const windowsUiDirect = new WindowsUiDirectBridge();

function textPreview(result, max = 1200) {
  const text = (result?.content || []).filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
  return text.slice(0, max);
}

if (process.argv.includes('--self-test')) {
  try {
    const tools = await windowsUiDirect.listTools(true);
    const guard = await windowsUiDirect.call('GuardrailStatus', {});
    const snap = await windowsUiDirect.call('Snapshot', { all_windows: false });
    console.log(JSON.stringify({
      ok: !guard?.isError && !snap?.isError,
      bridge: windowsUiDirect.status(),
      tools: tools.map(t => t.name),
      guardrail: { isError: !!guard?.isError, preview: textPreview(guard) },
      snapshot: { isError: !!snap?.isError, preview: textPreview(snap) },
    }, null, 2));
    await windowsUiDirect.close();
    process.exit(guard?.isError || snap?.isError ? 2 : 0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error) }));
    await windowsUiDirect.close().catch(() => {});
    process.exit(1);
  }
}
