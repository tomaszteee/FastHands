# Tools quick reference

Core MCP tools include `fast_exec`, `fast_batch`, `fast_run`, `fast_resume`, `fast_revise`, `fast_reconcile_external`, run/operator state, macros, and the visual fallback screenshot.

On Windows, Windows UI Direct convenience tools include `fast_ui_snapshot`, `fast_ui_click`, `fast_ui_type`, `fast_ui_invoke`, and `fast_ui_call`. Inside `fast_run`, use:

```json
{
  "kind": "windows_ui",
  "tool": "Snapshot",
  "arguments": { "all_windows": true }
}
```

Optional research tools are `fast_web_search`, `fast_web_read`, `fast_web_deep`, `fast_research_capabilities`, `fast_external_research`, and `youtube_research`. `fast_external_research` is EXTERNAL-ONLY, on-demand, keeps persistent writes disabled, opens a short GitHub circuit breaker after rate limiting, and treats the optional MCP specialist layer as additive rather than required.

`fast_probe` reports `coreOk`, global `ok`, optional backend health, and `degraded`. By default an unavailable Windows UI backend does not fail the core health check. Set `FAST_HANDS_REQUIRE_WINDOWS_UI=1` when UI availability must be part of the global PASS/FAIL gate.

On Linux and macOS, core execution/research tools remain available while Windows UI Direct and desktop screenshot capture report a clear unsupported-platform error.

## Resume integrity

`fast_resume` validates tracked workspace artifacts before continuing. Fast Hands automatically tracks paths used by `fs` steps. Any step may also declare extra file paths with an `artifacts` array when a shell or executable step produces files that should be protected by resume validation.

At each durable checkpoint, tracked files are recorded with SHA-256 + size. If a tracked file is changed, removed, recreated, or replaced before resume, `fast_resume` does not execute the remaining steps. It returns `code: "WORKSPACE_DRIFT_DETECTED"` with the expected and current fingerprints so the caller can review or revise the workflow first.

This is file-level drift detection, not a full snapshot of the entire workspace or filesystem.

## External mutations / idempotency

A `fast_run` step that can change a remote system may add:

```json
{
  "external_effect": {
    "operation_id": "stable-operation-id",
    "target": "https://api.example.com/resource/123",
    "payload": { "desired": "state" },
    "confirmation": "reconcile"
  }
}
```

Fast Hands writes an `unknown` external-effect record before executing that step. The record contains the stable operation ID, target, payload SHA-256 fingerprint, attempt number and outcome. `payload_hash` may be supplied instead of `payload`.

`confirmation: "execution"` confirms the effect when the action returns successfully. `confirmation: "reconcile"` keeps it unknown until a separate remote read-back; this is the default for UI actions. Errors and timeouts always remain `unknown`.

While any external effect is unknown, `fast_resume` returns `EXTERNAL_RECONCILIATION_REQUIRED` and `fast_revise` refuses to replace the tail. Use `fast_reconcile_external` after read-back:

- `outcome: "confirmed"` advances the checkpoint past that step without replaying it,
- `outcome: "failed"` leaves the checkpoint on that step and allows a controlled retry,
- optional `receipt` and `readback` metadata may be stored with the reconciliation.

An operation ID cannot be rebound to a different step, target, or payload fingerprint.

