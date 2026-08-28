# Tools quick reference

Core MCP tools include `fast_exec`, `fast_batch`, `fast_run`, `fast_resume`, `fast_revise`, run/operator state, macros, and the visual fallback screenshot.

Windows UI Direct convenience tools include `fast_ui_snapshot`, `fast_ui_click`, `fast_ui_type`, `fast_ui_invoke`, and `fast_ui_call`. Inside `fast_run`, use:

```json
{
  "kind": "windows_ui",
  "tool": "Snapshot",
  "arguments": { "all_windows": true }
}
```

Optional research tools are `fast_web_search`, `fast_web_read`, `fast_web_deep`, and `youtube_research`.

`fast_probe` reports `coreOk`, global `ok`, optional backend health, and `degraded`. By default an unavailable Windows UI backend does not fail the core health check. Set `FAST_HANDS_REQUIRE_WINDOWS_UI=1` when UI availability must be part of the global PASS/FAIL gate.
