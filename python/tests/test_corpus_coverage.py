"""Coverage gate: every opcode is either pinned by the corpus or on the tracked
gap list. Nothing gets to be silently unverified.

The corpus is the only oracle in this repo that comes from outside it. Every
other suite — round-trips, mock servers, cross-language parity — is built from
the SDK's own types, so an opcode with no corpus vector is verified by nothing
but its own reflection.

That is not theoretical. ``QueryRequest`` was missing ``session_filter`` in all
three SDKs; the server treats a missing ``Option`` as ``None`` rather than an
error, so a session-scoped query silently searched every session. Both verbs
that carry it, QUERY_EXPLAIN and QUERY_TRACE, are on the gap list.

This test does not demand the gap be closed. It demands the gap be *known*: add
an opcode, and it must show up in the corpus or in ``coverage.json``.
"""

from __future__ import annotations

import json
from pathlib import Path

from brain_db_sdk.wire.opcode import Opcode

CONFORMANCE = Path(__file__).resolve().parents[2] / "conformance"


def _covered_values() -> set[int]:
    index = json.loads((CONFORMANCE / "corpus" / "index.json").read_text())
    return {int(case["opcode"], 16) for case in index}


def _gap_values() -> set[int]:
    # Matched by VALUE, not name: the three SDKs spell the variants differently
    # (EntityGetReq / ENTITY_GET_REQ / EntityGetReq), and the number is the
    # thing the wire actually carries.
    coverage = json.loads((CONFORMANCE / "coverage.json").read_text())
    return {int(v, 16) for v in coverage["opcode_values"].values()}


def test_every_opcode_is_corpus_pinned_or_on_the_tracked_gap_list() -> None:
    covered = _covered_values()
    gap = _gap_values()
    declared = {op.name: int(op) for op in Opcode}

    assert len(declared) > 100, f"only {len(declared)} opcodes found — the enum import has drifted"

    unaccounted = sorted(
        f"{name} (0x{value:04X})"
        for name, value in declared.items()
        if value not in covered and value not in gap
    )
    assert not unaccounted, (
        "these opcodes have no corpus vector and are not on the tracked gap list, so "
        "nothing verifies their wire shape. Add a corpus case upstream in brain, or add "
        "the name to conformance/coverage.json with the rest:\n  " + "\n  ".join(unaccounted)
    )

    # The gap list must not outlive the gap: an entry that has since been
    # covered has to be deleted, or the list stops meaning anything.
    stale = sorted(
        f"{name} (0x{value:04X})"
        for name, value in declared.items()
        if value in covered and value in gap
    )
    assert not stale, (
        "these opcodes now HAVE a corpus vector but are still listed as uncovered in "
        "conformance/coverage.json — delete them from it:\n  " + "\n  ".join(stale)
    )
