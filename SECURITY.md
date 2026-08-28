# Security Policy

Fast Hands can execute commands and control desktop applications. Treat it like a local high-privilege automation component even when it runs as a normal user.

## Supported versions

Security fixes currently target the latest `0.6.x` release line.

## Defaults

- HTTP MCP and the operator monitor bind to `127.0.0.1` only.
- Runtime state is local and ignored by Git/package allowlists.
- Fast Hands core does not require credentials, telemetry, or a paid API.
- Optional desktop backends are launched locally over MCP stdio.
- Optional Windows UI availability does not fail core health unless `FAST_HANDS_REQUIRE_WINDOWS_UI=1` is set.

## Security invariants

A regression includes behavior where Fast Hands:

- binds publicly by default,
- loses or replays completed work across interrupt/revise/resume,
- ignores Pause at the next safe point,
- reports a hard-stopped atomic action as certainly safe,
- resumes an uncertain hard-stop without explicit acknowledgement,
- silently bundles runtime state, private paths, credentials, logs, screenshots, or third-party executables,
- makes an optional backend mandatory without explicit configuration.

See [THREAT_MODEL.md](THREAT_MODEL.md) for the full boundary.

## Remote access

Do not bind Fast Hands directly to a public or untrusted LAN interface. Put authentication, authorization and TLS in front of any remote transport and run the service with the least Windows privileges required for the task.

## Reporting vulnerabilities

Prefer GitHub private vulnerability reporting. Never attach real tokens, credentials, private logs, screenshots, transcripts, commands, or machine paths to a public issue.
