#!/usr/bin/env bash
# Run the cross-language HTTP edge integration suites against a live server.
#
# Two files per language:
#   test_http_edge / http-edge / http_edge              the six-verb smoke
#   test_http_all_operations / http-all-operations / …  all 25 verbs, plus
#                                                       the failure paths
#
# EXPECT THIS TO TAKE MINUTES, NOT SECONDS. A full pass makes more requests
# than a Free plan's 60/minute allows, so the suites are deliberately patient:
# they raise the retry cap past the server's 60s rate-limit window so a 429
# becomes a pause instead of a failure. That is the behaviour a real caller
# gets, and exercising it is the point.
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

echo "── python ─────────────────────────────────────────────────────────────"
(
  cd "$repo_dir/python"
  PYTHONPATH=src "${py_runner[@]}" -q \
    tests/test_http_edge.py tests/test_http_all_operations.py
)

echo "── typescript ─────────────────────────────────────────────────────────"
(
  cd "$repo_dir/typescript"
  # The all-operations pass can sit inside a rate-limit window, which is well
  # past vitest's 5s default.
  npm test -- --run --testTimeout=180000 \
    test/http-edge.test.ts test/http-all-operations.test.ts
)

echo "── rust ───────────────────────────────────────────────────────────────"
(
  cd "$repo_dir/rust"
  # No --test-threads=1 here on purpose: `http_all_operations` serialises
  # itself (see `serial()` in that file), so running it the ordinary way is
  # correct. A flag that has to be remembered is a flag that gets forgotten.
  cargo test --test http_edge
  cargo test --test http_all_operations
)

echo "── all three live suites passed ───────────────────────────────────────"
