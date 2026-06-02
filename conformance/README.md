# Conformance corpus

The byte-level oracle every SDK codec is tested against.

Brain's reference implementation ships a golden corpus at
`brain/crates/brain-protocol/tests/conformance/corpus/` — 38 `(*.bin, *.json)`
pairs plus `index.json`, one per opcode family / handshake frame / error
category / the vector-trailer case. Each pair is `(exact wire bytes, the
field-map those bytes decode to)`.

## How it's used

Every SDK's wire codec runs the same two-way check against this corpus:

1. **decode**: parse `<case>.bin` → assert the field-map equals `<case>.json`.
2. **encode**: build the value from `<case>.json` → assert the bytes equal `<case>.bin`.

If all three languages pass the same corpus, they agree on the wire byte-for-byte
— which is the whole point of independent re-implementation.

## Vendoring (TODO — build phase)

The corpus is **copied in with a version pin**, not git-submoduled and not fetched
in CI, because cross-repo CI/coupling into the Brain repo is disallowed. The copy
records the Brain commit it came from; a refresh is a deliberate, reviewed step.
Target: `conformance/corpus/` here mirrors the Brain corpus, with `SOURCE.txt`
naming the upstream commit.
