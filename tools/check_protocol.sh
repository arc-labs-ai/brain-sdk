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
#
#   ./tools/check_protocol.sh              # the gate (what CI runs)
#   ./tools/check_protocol.sh --refresh [brain-checkout]
#                                          # re-vendor the server manifest
#
# `--refresh` exists because the gate going red has two causes with opposite
# fixes — the SDK is wrong, or the manifest is stale — and the second used to
# be a five-step manual procedure described in prose. The rule that matters
# most in it ("generate from a CLEAN checkout, never a dirty working tree") was
# enforced by nothing, and a manifest built over uncommitted work pins the SDK
# to a wire format no released server speaks. Now the procedure is code: the
# manifest is built from `git archive` of a commit, so the working tree cannot
# leak in even if someone wants it to.
set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST="conformance/protocol.json"
SOURCE="conformance/SOURCE.txt"

# Where the server lives, for --refresh. The checkout is not needed by the gate
# itself, which reads only the vendored manifest.
DEFAULT_BRAIN_REPO="${BRAIN_REPO:-$(cd .. 2>/dev/null && pwd)/brain}"

die() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# --refresh: re-vendor conformance/protocol.json from the server.
# ---------------------------------------------------------------------------
refresh() {
  local repo="${1:-$DEFAULT_BRAIN_REPO}"
  [ -d "$repo/.git" ] || die "no git checkout at '$repo'.
Pass the path: ./tools/check_protocol.sh --refresh /path/to/brain
or set BRAIN_REPO."

  local src_path="crates/brain-protocol/src"
  [ -d "$repo/$src_path" ] || die "'$repo' has no $src_path — is that the brain repo?"

  # Refuse a dirty protocol source. `git archive` below would quietly vendor
  # HEAD while the operator is testing their working tree, so the manifest
  # would describe a wire format nothing is running. This is the rule
  # SOURCE.txt stated and nothing enforced.
  local dirty
  dirty="$(git -C "$repo" status --porcelain -- "$src_path")"
  if [ -n "$dirty" ]; then
    die "$src_path has uncommitted changes in '$repo':

$dirty

The manifest is a claim about what the server SHIPS. Commit the protocol
change first, then refresh — that ordering is the point, not a formality."
  fi

  local commit date
  commit="$(git -C "$repo" rev-parse HEAD)"
  date="$(git -C "$repo" show -s --format=%cs "$commit")"

  local work
  work="$(mktemp -d -t protomanifest.XXXXXX)"
  # shellcheck disable=SC2064 — expand $work now, not at trap time.
  trap "rm -rf '$work'" RETURN

  # `git archive`, not a copy of the worktree: the bytes come from the commit,
  # so what is vendored is exactly what that commit contains.
  git -C "$repo" archive "$commit" "$src_path" | tar -x -C "$work"

  local fresh="$work/manifest.json"
  python3 tools/protocol_manifest.py "$work/$src_path" > "$fresh"

  # A non-empty `unparsed` means the parser met something it could not read and
  # said so rather than dropping it. Vendoring that would silently narrow the
  # gate to whatever it did understand, which is worse than no gate.
  local unparsed
  unparsed="$(python3 -c '
import json, sys
print(len(json.load(open(sys.argv[1]))["unparsed"]))' "$fresh")"
  [ "$unparsed" = "0" ] || die "the generated manifest has $unparsed unparsed declarations.
Fix tools/protocol_manifest.py to read them before vendoring — a manifest that
skipped part of the protocol is not a gate."

  python3 -c '
import json, sys
old_path, new_path = sys.argv[1], sys.argv[2]
new = json.load(open(new_path))
try:
    old = json.load(open(old_path))
except FileNotFoundError:
    old = {"structs": {}, "enums": {}, "opcodes": {}}

for kind in ("structs", "enums", "opcodes"):
    a, b = old.get(kind, {}), new.get(kind, {})
    added, removed = sorted(set(b) - set(a)), sorted(set(a) - set(b))
    changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    print(f"  {kind:8} {len(b):4}  (+{len(added)} -{len(removed)} ~{len(changed)})")
    for label, names in (("added", added), ("removed", removed), ("changed", changed)):
        for name in names[:12]:
            print(f"      {label:7} {name}")
        if len(names) > 12:
            print(f"      {label:7} … and {len(names) - 12} more")
' "$MANIFEST" "$fresh"

  cp "$fresh" "$MANIFEST"
  python3 - "$SOURCE" "$commit" "$date" <<'PY'
import re, sys
path, commit, date = sys.argv[1:4]
text = open(path).read()
text = re.sub(r"^commit: .*$", f"commit: {commit}", text, count=1, flags=re.M)
text = re.sub(r"^date: .*$", f"date: {date}", text, count=1, flags=re.M)
open(path, "w").write(text)
PY

  echo
  echo "Vendored $MANIFEST from $commit ($date)."
  echo "Re-run ./tools/check_protocol.sh to confirm the SDKs agree."
}

if [ "${1:-}" = "--refresh" ]; then
  shift
  refresh "${1:-}"
  exit 0
fi

[ -f "$MANIFEST" ] || die "$MANIFEST is missing. Vendor it:
  ./tools/check_protocol.sh --refresh /path/to/brain"

# The same trustworthiness check the refresh applies, re-asserted here so a
# manifest vendored by hand (or by an older tool) cannot narrow the gate.
unparsed_count="$(python3 -c '
import json, sys
print(len(json.load(open(sys.argv[1]))["unparsed"]))' "$MANIFEST")"
if [ "$unparsed_count" != "0" ]; then
  die "$MANIFEST lists $unparsed_count unparsed declarations, so it does not
describe the whole protocol and this gate would pass on a subset. Re-vendor:
  ./tools/check_protocol.sh --refresh /path/to/brain"
fi

# `mktemp -t` differs between BSD and GNU: BSD appends a random suffix to the
# template, GNU requires the template to end in at least three X's and errors
# out otherwise. Without them this script runs on macOS and dies on every
# Linux CI runner with "too few X's in template" — which is exactly how this
# gate sat red in CI while passing locally.
RUST_MANIFEST="$(mktemp -t rust_manifest.XXXXXX)"
PY_SRC="$(mktemp -t py_wire.XXXXXX)"
TS_SRC="$(mktemp -t ts_wire.XXXXXX)"
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

# Labelled lookup, not `head -2 | tail -1`: the provenance line moves the
# moment anyone edits the prose around it, and a gate that misreports which
# server it checked against is worse than one that says nothing.
vendored_commit="$(sed -n 's/^commit: *//p' "$SOURCE" | head -1)"
echo "── Rust SDK vs server (commit: ${vendored_commit:-unknown})"
python3 tools/compare_rust.py "$MANIFEST" "$RUST_MANIFEST" || failed=1
echo

echo "── Python vs Rust SDK"
python3 tools/compare_bindings.py "$RUST_MANIFEST" python "$PY_SRC" || failed=1
echo

echo "── TypeScript vs Rust SDK"
python3 tools/compare_bindings.py "$RUST_MANIFEST" typescript "$TS_SRC" || failed=1

if [ "$failed" -ne 0 ]; then
  echo
  echo "Protocol type drift detected, and it has two causes with opposite fixes:" >&2
  echo >&2
  echo "  * The SDK is wrong — the server changed and the bindings did not." >&2
  echo "    Fix the binding." >&2
  echo "  * The manifest is stale — the server changed deliberately and this" >&2
  echo "    copy predates it. Re-vendor, from a committed protocol source:" >&2
  echo "        ./tools/check_protocol.sh --refresh /path/to/brain" >&2
  echo >&2
  echo "Which one it is depends on whether the SDK change was intended, so this" >&2
  echo "cannot be decided here. Read the diff above and pick." >&2
  exit 1
fi
echo
echo "All three SDKs agree with the server's wire types."
