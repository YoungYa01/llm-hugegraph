#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$PROJECT_DIR/frontend-system/serve.py" --port "${FRONTEND_PORT:-5174}" --bind 0.0.0.0
