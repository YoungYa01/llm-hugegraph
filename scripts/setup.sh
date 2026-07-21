#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
VENV="$PROJECT_DIR/.venv"

python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r "$PROJECT_DIR/backend/requirements.txt"
"$VENV/bin/pip" install -r "$BUNDLE_DIR/LogFaultAlgorithm/requirements.txt"
"$VENV/bin/pip" install -r "$PROJECT_DIR/backend/requirements-dev.txt"

if [[ ! -f "$PROJECT_DIR/backend/.env" ]]; then
  cp "$PROJECT_DIR/backend/.env.example" "$PROJECT_DIR/backend/.env"
fi

echo "依赖安装完成。请检查 backend/.env 中的 llama.cpp 和 HugeGraph 地址。"
