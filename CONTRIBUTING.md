# Contributing

Thanks for helping improve Fast Hands.

Because Fast Hands can execute commands and control desktop applications, seemingly small changes can affect operator safety and local data.

## Development

Requirements:

- Windows 10/11
- Node.js 20+
- Git

Run before opening a pull request:

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

## Safety-sensitive changes

Changes to process execution, safe points, checkpoints, Pause/Stop, resume/revise, runtime persistence, network binding, Windows UI routing, or macro execution should include a regression test.

A hard-stopped action must remain fail-uncertain rather than being reported as safely completed.

## Scope

Read [SCOPE.md](SCOPE.md) and [THREAT_MODEL.md](THREAT_MODEL.md). Do not silently add cloud dependencies, telemetry, bundled third-party executables, or automatic remote exposure.

## Pull requests

Keep changes focused. Do not commit secrets, local machine paths, runtime state, screenshots, generated virtual environments, or unrelated project files.
