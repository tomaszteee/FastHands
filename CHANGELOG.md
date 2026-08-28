# Changelog

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
