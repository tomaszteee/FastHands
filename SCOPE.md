# Scope

Fast Hands is a **local-first cross-platform execution and research layer for MCP-capable AI clients**.

## In scope

- persistent PowerShell execution,
- deterministic mixed-step workflows,
- durable safe-point checkpoints and resume,
- operator Pause, Emergency Stop, and interrupting errata,
- optional Windows-only UI Direct integration over MCP stdio,
- optional local web and YouTube research,
- reusable macros,
- a loopback-only local operator monitor.

## Out of scope

- providing or hosting an LLM,
- being an OS sandbox, privilege boundary, EDR, antivirus, or malware detector,
- authenticating public Internet clients,
- redistributing third-party desktop backends, browsers, FFmpeg, or AI models,
- silently installing system dependencies,
- automatically publishing content or taking actions outside commands requested by the connected MCP client/operator.

Fast Hands intentionally exposes powerful local capabilities. Security comes from least-privilege deployment, loopback-only defaults, explicit optional integrations, durable state, and human operator controls; it does not make arbitrary command execution intrinsically safe.
