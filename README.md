# Fast Hands

[![CI](https://github.com/tomaszteee/FastHands/actions/workflows/ci.yml/badge.svg)](https://github.com/tomaszteee/FastHands/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)

**Local-first execution and research layer for AI agents on Windows, Linux and macOS.**

Fast Hands gives an MCP-capable assistant a fast local execution path while keeping a human operator in control. Core execution uses persistent PowerShell 7 on Windows, Linux and macOS; Windows UI automation and desktop screenshot capture remain optional Windows-only features.

> Fast Hands does **not** include an LLM and does not require a paid API for its core features. The calling MCP client supplies the reasoning model.

## Why it is different

Most computer-use servers focus on clicking and typing. Fast Hands treats execution as a controlled transaction loop:

`plan -> safe point -> action -> checkpoint -> operator gate -> next action`

If the operator interrupts a run, completed work is preserved. The caller can replace only the not-yet-executed tail with `fast_revise`, then continue with `fast_resume` instead of replaying successful steps.

## Highlights

- `fast_exec` - low-latency command execution through a persistent hidden PowerShell process.
- `fast_batch` - 1-200 PowerShell commands with separate results and checkpoints.
- `fast_run` - mixed multi-step workflows with durable progress and operator control, including native `windows_ui` steps when Windows UI Direct is configured.
- `fast_resume` / `fast_revise` - resume from a checkpoint or replace only the unexecuted tail; resume verifies tracked file artifacts before continuing.
- Local operator monitor with **RUN / PAUSE / EMERGENCY STOP** and interrupting messages.
- Windows UI Direct adapter via a compatible `windows-mcp-server` executable.
- Optional legacy UIA batch adapter through `FAST_HANDS_LEGACY_UIA_OPERATOR`.
- `fast_web_search`, `fast_web_read`, `fast_web_deep` - local public-web research.
- `youtube_research` - YouTube search, metadata, captions, local Whisper fallback and frame extraction.
- Loopback-only HTTP endpoints by default (`127.0.0.1`).
- MCP stdio mode for normal MCP clients.

## Downloadable builds

GitHub Releases also provide platform builds that bundle the Node.js runtime:

- `FastHands-Windows-x64.exe` - single-file Windows x64 launcher with embedded Fast Hands payload.
- `FastHands-Linux-x64.tar.gz` - Linux x64 native launcher + bundled Node runtime.
- `FastHands-macOS-x64.tar.gz` - macOS Intel x64 native launcher + bundled Node runtime.

PowerShell remains the execution engine (built into supported Windows as a compatibility fallback; PowerShell 7 is required on Linux/macOS). Optional research features still require their documented Python/FFmpeg dependencies.

## Install from npm

```bash
npm install -g fast-hands-mcp
fast-hands --version
```

Start MCP over stdio with `fast-hands`, loopback HTTP with `fast-hands server`, or the operator monitor with `fast-hands monitor`. You can also use `npx fast-hands-mcp --help` without a global install.

## Requirements

Core:

- Windows 10/11, Linux, or macOS
- Node.js 20+
- PowerShell 7 (`pwsh`) on Linux/macOS
- PowerShell 7 recommended on Windows; Windows PowerShell remains a compatibility fallback.

Optional research:

- Python 3.10+
- FFmpeg for YouTube frame/audio operations
- Playwright browser support for rendered-page fallback

Optional Windows UI Direct (Windows only):

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

## Platform support

| Platform | Core execution/checkpoints | Web/YouTube research | Windows UI Direct | Desktop screenshot fallback |
|---|---|---|---|---|
| Windows | Yes | Yes | Optional | Yes |
| Linux | Yes | Yes | No | No |
| macOS | Yes | Yes | No | No |

Linux/macOS use the same PowerShell 7 execution engine and checkpoint semantics. UI-specific tools fail clearly as unsupported outside Windows rather than degrading core health.
## Windows UI Direct

Set the backend executable or command before starting Fast Hands:

```powershell
$env:FAST_HANDS_WINDOWS_MCP = 'C:\tools\windows-mcp-server.exe'
node server.mjs
```

On Windows, Fast Hands opens the backend over MCP stdio and exposes convenience tools such as `fast_ui_snapshot`, `fast_ui_click`, `fast_ui_type`, and `fast_ui_invoke`. `fast_ui_call` provides access to the complete backend tool surface.

Inside `fast_run` or a saved macro, Windows UI Direct can be used as a normal checkpointed step:

```json
{ "kind": "windows_ui", "tool": "Snapshot", "arguments": { "all_windows": true } }
```

If the backend is unavailable, shell/checkpoint functionality remains usable; UI-specific calls fail clearly.

## Web and YouTube research

Install optional local research dependencies:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-research.ps1
```

Linux/macOS research setup:

```bash
./scripts/setup-research.sh
# or: ./scripts/setup-research.sh --install-browser
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
| `FAST_HANDS_REQUIRE_WINDOWS_UI` | set to `1` to make Windows UI availability part of global `fast_probe` PASS/FAIL |
| `FAST_HANDS_LEGACY_UIA_OPERATOR` | optional legacy UIA batch executable |

## Safety model

Fast Hands is powerful software. A connected agent can run commands and, when UI backends are enabled, operate desktop applications.

The execution engine records durable run state and checks local operator control before and after safe units. File artifacts referenced by `fs` steps (and optional per-step `artifacts` paths) are fingerprinted with SHA-256 + size at checkpoints. `fast_resume` compares the current files with the last checkpoint and returns `WORKSPACE_DRIFT_DETECTED` instead of blindly continuing when tracked content changed. **Emergency Stop** terminates active child processes and marks the affected step as uncertain when partial execution may have occurred.

Do not expose the monitor or HTTP MCP endpoint to an untrusted network without adding authenticated transport and least-privilege controls. See [SECURITY.md](SECURITY.md).

## Project boundaries

Included here: the Fast Hands server, operator monitor, research integrations and adapter code written for Fast Hands.

Not bundled: LLMs, paid APIs, third-party desktop binaries, personal logs/screenshots, local runtime state, credentials, machine-specific paths, or project handoff files.

## Release integrity

The repository includes a tag-triggered release workflow prepared to verify the tag/version, rerun the full quality gate, build an npm-compatible source archive, export an SPDX SBOM, generate SHA-256 checksums, and create GitHub build-provenance attestations. No release or npm publication occurs merely by pushing `main`; a version tag is required.

Project policies: [Architecture](docs/ARCHITECTURE.md) | [Tools](docs/TOOLS.md) | [Threat model](THREAT_MODEL.md) | [Security](SECURITY.md) | [Privacy](PRIVACY.md) | [Scope](SCOPE.md) | [Support](SUPPORT.md) | [Contributing](CONTRIBUTING.md).

## License

MIT. Third-party dependencies and optional backends keep their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).

## About

IMI Studio
https://www.imistudio.pl
