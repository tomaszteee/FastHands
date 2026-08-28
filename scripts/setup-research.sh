#!/usr/bin/env sh
set -eu
INSTALL_BROWSER=0
if [ "${1:-}" = "--install-browser" ]; then INSTALL_BROWSER=1; fi
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
PYTHON_BIN="${FAST_HANDS_PYTHON:-python3}"
"$PYTHON_BIN" -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-research.txt
if [ "$INSTALL_BROWSER" -eq 1 ]; then python -m playwright install chromium; fi
python -m pip check
printf '%s\n' 'Fast Hands research environment ready.'
