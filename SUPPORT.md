# Support

Fast Hands is an early open-source project.

For reproducible bugs, open a GitHub issue using the bug-report template and include only sanitized diagnostics.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and do not disclose sensitive details in a public issue.

Before reporting a bug, run:

```powershell
npm ci
npm run check
npm test
npm run pack:check
```

If the issue concerns an optional backend, state clearly which backend and version is configured. Do not include private paths, tokens, screenshots, or logs unless they have been sanitized.
