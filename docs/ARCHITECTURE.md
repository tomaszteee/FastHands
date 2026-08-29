# Architecture and execution model

Fast Hands runs as an MCP server over stdio or loopback HTTP on Windows, Linux and macOS. The operator monitor can supervise the HTTP server. Core command execution uses PowerShell 7 (`pwsh`) across platforms; Windows PowerShell is a Windows compatibility fallback.

## Execution paths

- `powershell` - persistent hidden PowerShell with per-command checkpoints.
- `exec` - direct child process execution.
- `detached_exec` - explicitly detached process launch.
- `fs` - Node filesystem operations.
- `wait` - interruptible wait step.
- `windows_ui` - Windows-only: call a configured Windows UI Direct MCP tool from inside `fast_run` or a macro.
- legacy `uia` - optional compatibility path only when `FAST_HANDS_LEGACY_UIA_OPERATOR` is explicitly configured.

Every normal step has a safe point before and after execution. Operator messages and Pause requests return control at safe points. Emergency Stop terminates active process work and marks uncertain state when partial execution is possible.

Steps that declare `external_effect` add a second durability layer for remote mutations. Fast Hands writes a stable operation ID, target and payload fingerprint with outcome `unknown` before the action begins. A successful execution can confirm the effect immediately, or the caller can require explicit remote reconciliation. Unknown outcomes block resume/revise until `fast_reconcile_external` records read-back as `confirmed` or `failed`.

## Optional research

FastWeb and YouTubeResearch are bundled as source but use a separate Python virtual environment. They are optional and do not change core health semantics.
