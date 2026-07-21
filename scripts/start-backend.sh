#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
PYTHON="$PROJECT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "未找到 .venv，请先运行 scripts/setup.sh" >&2
  exit 1
fi

export LOGFAULT_PROJECT_PATH="${LOGFAULT_PROJECT_PATH:-$BUNDLE_DIR/LogFaultAlgorithm}"
cd "$PROJECT_DIR/backend"
exec "$PYTHON" -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
