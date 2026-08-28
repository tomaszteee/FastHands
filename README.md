# Fast Hands

**Local-first execution and research layer for AI agents on Windows.**

Fast Hands gives an MCP-capable assistant a fast local execution path while keeping a human operator in control. It combines persistent PowerShell, deterministic multi-step runs, durable safe-point checkpoints, operator Pause/Stop/errata, Windows UI automation, local web research, and YouTube research behind one model-agnostic MCP server.

> Fast Hands does **not** include an LLM and does not require a paid API for its core features. The calling MCP client supplies the reasoning model.

## Why it is different

Most computer-use servers focus on clicking and typing. Fast Hands treats execution as a controlled transaction loop:

`plan -> safe point -> action -> checkpoint -> operator gate -> next action`

If the operator interrupts a run, completed work is preserved. The caller can replace only the not-yet-executed tail with `fast_revise`, then continue with `fast_resume` instead of replaying successful steps.

## Highlights

- `fast_exec` - low-latency command execution through a persistent hidden PowerShell process.
- `fast_batch` - 1-200 PowerShell commands with separate results and checkpoints.
- `fast_run` - mixed multi-step workflows with durable progress and operator control.
- `fast_resume` / `fast_revise` - resume from a checkpoint or replace only the unexecuted tail.
- Local operator monitor with **RUN / PAUSE / EMERGENCY STOP** and interrupting messages.
- Windows UI Direct adapter via a compatible `windows-mcp-server` executable.
- Optional legacy UIA batch adapter through `FAST_HANDS_LEGACY_UIA_OPERATOR`.
- `fast_web_search`, `fast_web_read`, `fast_web_deep` - local public-web research.
- `youtube_research` - YouTube search, metadata, captions, local Whisper fallback and frame extraction.
- Loopback-only HTTP endpoints by default (`127.0.0.1`).
- MCP stdio mode for normal MCP clients.

## Requirements

Core:

- Windows 10/11
- Node.js 20+
- PowerShell 7 recommended; Windows PowerShell is used as a fallback.

Optional research:

- Python 3.10+
- FFmpeg for YouTube frame/audio operations
- Playwright browser support for rendered-page fallback

Optional Windows UI Direct:

- A compatible `windows-mcp-server` executable. Fast Hands does not redistribute third-party binaries.

## Quick start

```powershell
git clone https://github.com/tomaszteee/FastHands.git
cd FastHands
npm install
npm test
```

Run over stdio:

```powershell
npm run stdio
```

Run loopback HTTP MCP:

```powershell
npm start
# MCP:    http://127.0.0.1:8797/mcp
# health: http://127.0.0.1:8797/health
```

Run the operator console (it also supervises the local HTTP MCP server):

```powershell
npm run monitor
# http://127.0.0.1:8796/
```

## MCP client example

```json
{
  "mcpServers": {
    "fast-hands": {
      "command": "node",
      "args": ["C:/path/to/FastHands/server.mjs"]
    }
  }
}
```

## Windows UI Direct

Set the backend executable or command before starting Fast Hands:

```powershell
$env:FAST_HANDS_WINDOWS_MCP = 'C:\tools\windows-mcp-server.exe'
node server.mjs
```

Fast Hands opens the backend over MCP stdio and exposes convenience tools such as `fast_ui_snapshot`, `fast_ui_click`, `fast_ui_type`, and `fast_ui_invoke`. `fast_ui_call` provides access to the complete backend tool surface.

If the backend is unavailable, shell/checkpoint functionality remains usable; UI-specific calls fail clearly.

## Web and YouTube research

Install optional local research dependencies:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-research.ps1
```

To install Playwright Chromium too:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-research.ps1 -InstallBrowser
```

FastWeb uses public search/read backends and local extraction. YouTubeResearch uses `yt-dlp`; captions are preferred, and `faster-whisper` can run locally when captions are missing. These integrations do not require a paid API.

## Configuration

| Variable | Purpose |
|---|---|
| `FAST_HANDS_PORT` | HTTP MCP port, default `8797` |
| `FAST_HANDS_MONITOR_PORT` | operator monitor port, default `8796` |
| `FAST_HANDS_PWSH` | explicit PowerShell executable |
| `FAST_HANDS_PYTHON` | explicit Python executable for research integrations |
| `FAST_HANDS_WINDOWS_MCP` | Windows UI Direct MCP executable/command |
| `FAST_HANDS_LEGACY_UIA_OPERATOR` | optional legacy UIA batch executable |

## Safety model

Fast Hands is powerful software. A connected agent can run commands and, when UI backends are enabled, operate desktop applications.

The execution engine records durable run state and checks local operator control before and after safe units. **Emergency Stop** terminates active child processes and marks the affected step as uncertain when partial execution may have occurred.

Do not expose the monitor or HTTP MCP endpoint to an untrusted network without adding authenticated transport and least-privilege controls. See [SECURITY.md](SECURITY.md).

## Project boundaries

Included here: the Fast Hands server, operator monitor, research integrations and adapter code written for Fast Hands.

Not bundled: LLMs, paid APIs, third-party desktop binaries, personal logs/screenshots, local runtime state, credentials, machine-specific paths, or project handoff files.

## License

MIT. Third-party dependencies and optional backends keep their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
