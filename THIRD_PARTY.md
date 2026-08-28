# Third-party components

Fast Hands source is MIT licensed. Third-party projects and dependencies retain their own licenses. Fast Hands does not vendor or redistribute optional desktop/browser/media executables.

## Node runtime dependencies

- Model Context Protocol TypeScript SDK packages: MIT.
- Zod: MIT.
- Transitive npm dependencies retain their upstream licenses; `npm audit` and the lockfile are part of the CI gate.

## Optional Python research dependencies

Installed from PyPI into a local virtual environment, not vendored into this repository or release archive:

- DDGS: MIT.
- Trafilatura: Apache-2.0.
- Requests: Apache-2.0.
- Playwright Python: Apache-2.0 (with bundled upstream notices in the installed distribution).
- yt-dlp: Unlicense/public-domain dedication.
- faster-whisper: MIT.

Their transitive dependencies retain their own upstream licenses.

## External optional executables

- Windows UI Direct interoperates with a compatible `windows-mcp-server` over MCP stdio. Fast Hands does not redistribute that executable or source. The Deployment Theory implementation used during development is MIT licensed.
- FFmpeg is an external executable and is not redistributed. FFmpeg builds may be LGPL or GPL depending on build configuration; users are responsible for the license of the build they install.
