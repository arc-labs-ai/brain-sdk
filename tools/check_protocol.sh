#!/usr/bin/env bash
#
# check_protocol.sh — the type-level drift gate, run by CI for all three SDKs.
#
# Three comparisons, in dependency order:
#
#   1. Rust SDK vs the vendored server manifest. serde ties a Rust field name to
#      its wire key, so this is the one comparison that can be exact.
#   2. Python vs the Rust SDK.
#   3. TypeScript vs the Rust SDK.
#
# 2 and 3 go through Rust rather than the server because step 1 has already
# proven Rust equals the server, and because Python and TypeScript write their
# wire keys by hand — there is nothing tying a declaration to a key, which is
# how QueryRequest.session_filter went missing from all three at once.
#
# This checks DECLARATIONS. The `field-names` suites check that decoded values
# land in those declarations, and the corpus checks the bytes. All three are
# needed; none subsumes another.
set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST="conformance/protocol.json"
RUST_MANIFEST="$(mktemp -t rust_manifest)"
PY_SRC="$(mktemp -t py_wire)"
TS_SRC="$(mktemp -t ts_wire)"
trap 'rm -f "$RUST_MANIFEST" "$PY_SRC" "$TS_SRC"' EXIT

python3 tools/protocol_manifest.py rust/src/wire > "$RUST_MANIFEST"

# The bindings split the wire surface across modules; the comparators take one
# blob, so concatenate rather than teach them a module graph.
cat python/src/brain_db_sdk/wire/types.py \
    python/src/brain_db_sdk/wire/opcode.py \
    python/src/brain_db_sdk/wire/frame.py > "$PY_SRC"
cat typescript/src/wire/types.ts \
    typescript/src/wire/opcode.ts \
    typescript/src/wire/frame.ts > "$TS_SRC"

failed=0

echo "── Rust SDK vs server ($(head -2 conformance/SOURCE.txt | tail -1))"
python3 tools/compare_rust.py "$MANIFEST" "$RUST_MANIFEST" || failed=1
echo

echo "── Python vs Rust SDK"
python3 tools/compare_bindings.py "$RUST_MANIFEST" python "$PY_SRC" || failed=1
echo

echo "── TypeScript vs Rust SDK"
python3 tools/compare_bindings.py "$RUST_MANIFEST" typescript "$TS_SRC" || failed=1

if [ "$failed" -ne 0 ]; then
  echo
  echo "Protocol type drift detected. Either the SDK is wrong, or the vendored" >&2
  echo "manifest is stale — refresh it per conformance/SOURCE.txt and re-run." >&2
  exit 1
fi
echo
echo "All three SDKs agree with the server's wire types."
