# Tools quick reference

Core MCP tools include `fast_exec`, `fast_batch`, `fast_run`, `fast_resume`, `fast_revise`, run/operator state, macros, and the visual fallback screenshot.

On Windows, Windows UI Direct convenience tools include `fast_ui_snapshot`, `fast_ui_click`, `fast_ui_type`, `fast_ui_invoke`, and `fast_ui_call`. Inside `fast_run`, use:

```json
{
  "kind": "windows_ui",
  "tool": "Snapshot",
  "arguments": { "all_windows": true }
}
```

Optional research tools are `fast_web_search`, `fast_web_read`, `fast_web_deep`, and `youtube_research`.

`fast_probe` reports `coreOk`, global `ok`, optional backend health, and `degraded`. By default an unavailable Windows UI backend does not fail the core health check. Set `FAST_HANDS_REQUIRE_WINDOWS_UI=1` when UI availability must be part of the global PASS/FAIL gate.

On Linux and macOS, core execution/research tools remain available while Windows UI Direct and desktop screenshot capture report a clear unsupported-platform error.

## Resume integrity

`fast_resume` validates tracked workspace artifacts before continuing. Fast Hands automatically tracks paths used by `fs` steps. Any step may also declare extra file paths with an `artifacts` array when a shell or executable step produces files that should be protected by resume validation.

At each durable checkpoint, tracked files are recorded with SHA-256 + size. If a tracked file is changed, removed, recreated, or replaced before resume, `fast_resume` does not execute the remaining steps. It returns `code: "WORKSPACE_DRIFT_DETECTED"` with the expected and current fingerprints so the caller can review or revise the workflow first.

This is file-level drift detection, not a full snapshot of the entire workspace or filesystem.
