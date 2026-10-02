#!/usr/bin/env bash
# Run the cross-language HTTP edge integration smoke suite.
set -euo pipefail

: "${BRAIN_SDK_IT_HTTP:?set BRAIN_SDK_IT_HTTP to the running brain-edge URL}"
: "${BRAIN_SDK_IT_HTTP_KEY:?set BRAIN_SDK_IT_HTTP_KEY to an edge API key}"
export BRAIN_SDK_IT_REQUIRED=1

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"

(
  cd "$repo_dir/python"
  PYTHONPATH=src "$python_bin" -m pytest -q tests/test_http_edge.py
)
(
  cd "$repo_dir/typescript"
  npm test -- --run test/http-edge.test.ts
)
(
  cd "$repo_dir/rust"
  cargo test --test http_edge
)
