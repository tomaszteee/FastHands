#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cmd = String(process.argv[2] || 'stdio').toLowerCase();
if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(pkg.version); process.exit(0); }
if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`Fast Hands ${pkg.version}\n\nUsage:\n  fast-hands              Start MCP over stdio\n  fast-hands stdio        Start MCP over stdio\n  fast-hands server       Start loopback HTTP MCP server\n  fast-hands monitor      Start operator monitor + supervised HTTP MCP\n  fast-hands --version    Print version\n\nPlatforms: Windows, Linux, macOS\nCore requirement: Node.js 20+ and PowerShell 7 (pwsh).\nWindows UI Direct and desktop screenshot capture are Windows-only optional features.`);
  process.exit(0);
}
if (cmd === 'stdio') await import('../server.mjs');
else if (cmd === 'server' || cmd === 'http') { if (!process.argv.includes('--http')) process.argv.push('--http'); await import('../server.mjs'); }
else if (cmd === 'monitor') await import('../monitor-server.mjs');
else { console.error(`Unknown command: ${cmd}. Run "fast-hands --help".`); process.exit(2); }
