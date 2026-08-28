# Security Policy

Fast Hands can execute commands and control desktop applications. Treat it like a local high-privilege automation component even when it runs as a normal user.

## Defaults

- HTTP MCP and the operator monitor bind to `127.0.0.1` only.
- Runtime state is local and ignored by Git.
- Fast Hands core does not require credentials or a paid API.
- Optional desktop backends are launched locally over MCP stdio.

## Remote access

Do not bind Fast Hands directly to a public or untrusted LAN interface. Put authentication, authorization and TLS in front of any remote transport and run the service with the least Windows privileges required for the task.

## Reporting vulnerabilities

Use GitHub private vulnerability reporting when available. Never attach real tokens, credentials, private logs or screenshots to a public issue.
