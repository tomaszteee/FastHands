import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
const forbidden = [
  /D:\\AlitaTool/i,
  /D:\/AlitaTool/i,
  /C:\\Users\\/i,
  /C:\/Users\//i,
  /Projekt Imi/i,
  /DESKTOP-(?=[A-Z0-9-]*\\d)[A-Z0-9-]{5,}/i,
  /gho_[A-Za-z0-9_]+/,
  /github_pat_[A-Za-z0-9_]+/,
  /-----BEGIN [^-]*PRIVATE KEY-----/,
];
const findings = [];
for (const rel of files) {
  const full = path.join(root, rel);
  const stat = await fs.stat(full);
  if (stat.size > 1024 * 1024) findings.push(`${rel}: tracked file exceeds 1 MiB (${stat.size})`);
  if (rel === 'scripts/repo-audit.mjs') continue;
  let text;
  try { text = await fs.readFile(full, 'utf8'); } catch { continue; }
  for (const re of forbidden) if (re.test(text)) findings.push(`${rel}: ${re}`);
}
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, trackedFiles: files.length, findings: 0 }, null, 2));
