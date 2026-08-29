# Changelog

## [0.6.8] - 2026-08-29

### External side-effect reconciliation

- adds durable pre-action external-effect records with stable `operation_id`, target, SHA-256 payload fingerprint, attempt number and `confirmed` / `failed` / `unknown` outcome,
- blocks `fast_resume` and `fast_revise` while any declared external effect remains `unknown`, preventing blind replay after a crash, timeout, or uncertain browser/API mutation,
- adds `fast_reconcile_external` so remote read-back can mark an operation `confirmed` (skip replay) or `failed` (controlled retry),
- supports strict `confirmation: "reconcile"` mode for actions where a successful local call does not prove the remote write committed; UI actions default to this mode,
- rejects reuse of an operation ID with a different step, target, or payload fingerprint,
- adds regression coverage for confirmed no-replay, timeout-after-effect reconciliation, failed-safe-to-retry, explicit read-back mode, and existing workspace-drift compatibility.

## [0.6.7] - 2026-08-28

- hardens atomic runtime-state writes with bounded retries for transient Windows file-lock errors (`EPERM`/`EBUSY`/`EACCES`).
### Resume integrity

- fingerprints tracked file artifacts at durable checkpoints with SHA-256 + size,
- blocks `fast_resume` with `WORKSPACE_DRIFT_DETECTED` when a tracked artifact changed after the checkpoint,
- automatically tracks file paths referenced by `fs` steps and supports explicit per-step `artifacts` paths for shell/executable workflows,
- adds regression coverage for same-size content changes so hash verification, not file size alone, guards resume.

## [0.6.6] - 2026-08-28

- updates GitHub artifact transfer actions to upload-artifact v7.0.1 and download-artifact v8.0.1, pinned by commit SHA, to eliminate the deprecated Node 20 action-runtime warnings.

## [0.6.5] - 2026-08-28

- rebuilds native distribution release from the corrected Windows builder without rewriting the failed v0.6.4 tag.

## [0.6.4] - 2026-08-28

- fixes the Windows GitHub Actions standalone build path and uses an Intel macOS runner for native x64 distribution builds.

## [0.6.3] - 2026-08-28

### Native distributions

- adds `FastHands-Windows-x64.exe`, a single-file Windows x64 launcher with embedded Node + Fast Hands payload,
- adds `FastHands-Linux-x64.tar.gz` with a native Linux launcher and bundled Node runtime,
- adds `FastHands-macOS-x64.tar.gz` with a native macOS launcher and bundled Node runtime,
- release workflow builds and smoke-tests every platform artifact before GitHub Release creation.

## [0.6.1] - 2026-08-28

### Cross-platform release

- supports Windows, Linux and macOS for core PowerShell/checkpoint/research workflows,
- adds POSIX process-group Emergency Stop behavior and `.sh` launch/setup scripts,
- keeps Windows UI Direct and desktop screenshot capture explicitly Windows-only,
- adds `fast-hands` and `fast-hands-mcp` npm CLI entry points,
- adds multi-platform CI and exact tag/version release validation.

### Fixed

- repaired `fast_screenshot` by routing the visual fallback through the configured PowerShell executable,
- replaced the bundled legacy-UIA macro with a shipped `windows_ui` / Windows UI Direct workflow,
- made optional Windows UI availability non-fatal to core `fast_probe` health unless explicitly required.

### Added

- native checkpointed `windows_ui` steps for `fast_run` and macros,
- regression tests for core execution and interrupt/revise/resume semantics,
- repository privacy audit and package allowlist,
- threat model, scope, privacy, support, architecture/tools documentation, CODEOWNERS and contribution templates,
- pinned/minimal-permission CI across Node.js 20/22/24 on Windows,
- tag-triggered GitHub release pipeline with source archive, SPDX SBOM, SHA-256 checksums and provenance attestations.

## 0.6.0 - 2026-08-28

- First public-ready Fast Hands repository.
- Portable paths and environment configuration.
- Durable checkpoint / Pause / Stop / operator-errata workflow.
- Windows UI Direct adapter with optional legacy UIA fallback.
- Optional local FastWeb and YouTubeResearch integrations.
- Security policy, CI and portability self-test.
