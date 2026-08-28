import fs from 'node:fs';
const tag = process.env.GITHUB_REF_NAME || process.argv[2] || '';
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Release tag must be vX.Y.Z, got: ${tag}`);
if (`v${pkg.version}` !== tag) throw new Error(`Tag ${tag} does not match package version v${pkg.version}`);
console.log(`Release tag verified: ${tag}`);
