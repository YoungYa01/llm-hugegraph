#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
PYTHON="$PROJECT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "未找到 .venv，请先运行 scripts/setup.sh" >&2
  exit 1
fi

cd "$PROJECT_DIR"
PYTHONPATH=backend "$PYTHON" -m pytest -q backend/tests
cd "$BUNDLE_DIR/LogFaultAlgorithm"
PYTHONPATH=. "$PYTHON" -m pytest -q
cd "$PROJECT_DIR"
for file in frontend-system/js/*.js frontend-system/js/pages/*.js; do
  node --check "$file"
done
