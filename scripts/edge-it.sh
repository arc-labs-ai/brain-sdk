#!/usr/bin/env bash
# Run the cross-language HTTP edge integration smoke suite.
set -euo pipefail

: "${BRAIN_SDK_IT_HTTP:?set BRAIN_SDK_IT_HTTP to the running brain-edge URL}"
: "${BRAIN_SDK_IT_HTTP_KEY:?set BRAIN_SDK_IT_HTTP_KEY to an edge API key}"
export BRAIN_SDK_IT_REQUIRED=1

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Prefer the project's uv environment: a bare `python3` on a machine that
# installs test deps with uv has no pytest, so the suite failed before running
# a single assertion. `PYTHON_BIN` still overrides for other setups.
if [[ -n "${PYTHON_BIN:-}" ]]; then
  py_runner=("$PYTHON_BIN" -m pytest)
elif command -v uv >/dev/null 2>&1; then
  py_runner=(uv run pytest)
else
  py_runner=(python3 -m pytest)
fi

(
  cd "$repo_dir/python"
  PYTHONPATH=src "${py_runner[@]}" -q tests/test_http_edge.py
)
(
  cd "$repo_dir/typescript"
  npm test -- --run test/http-edge.test.ts
)
(
  cd "$repo_dir/rust"
  cargo test --test http_edge
)
