# Contributing

1. Fork the repository and create a focused branch.
2. Keep machine-specific paths, credentials, runtime logs and screenshots out of commits.
3. Run `npm ci`, `npm run check`, `npm test`, and a secret scan before opening a pull request.
4. For Python integrations, run `python -m py_compile integrations/fastweb/fast_web.py integrations/youtube/research.py integrations/youtube/transcript_helper.py`.
5. Describe the behavior change and how it was verified.

Changes to operator-control semantics must preserve the invariant that completed safe units are never silently replayed after an interrupt.
