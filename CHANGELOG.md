# Changelog

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
