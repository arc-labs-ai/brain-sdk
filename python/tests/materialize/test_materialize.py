"""Feature: MATERIALIZE_PROCEDURAL — assemble a procedural-memory system block
for the caller's space (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Encodes a
few instruction-shaped source memories (blocking on derivation so extraction
runs), then materializes and asserts the response shape. The corpus is tiny and
extraction is best-effort, so the count/content assertions are lenient — the
contract this test pins is the round-trip and the response shape.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder, new_id
from brain_db_sdk.wire.types import MaterializeProceduralResponse, MaterializeProceduralRequest


def _materialize(client, categories):
    return client.materialize_procedural(
        MaterializeProceduralRequest(
            space_id=client.space_id,
            session_filter=None,
            top_k=10,
            min_confidence=0.0,
            categories=categories,
            request_id=new_id(),
        )
    )


def _assert_shape(resp: MaterializeProceduralResponse) -> None:
    assert isinstance(resp, MaterializeProceduralResponse)
    assert isinstance(resp.system_block, str)
    assert isinstance(resp.statement_ids, list)
    assert all(isinstance(sid, (bytes, bytearray)) for sid in resp.statement_ids)
    assert isinstance(resp.total_candidates, int)
    assert resp.total_candidates >= 0
    assert isinstance(resp.trimmed_by_budget, bool)
    # The system block draws on exactly the statements it reports.
    assert len(resp.statement_ids) <= resp.total_candidates or resp.total_candidates == 0


def test_materialize_procedural_round_trip(it):
    client, _agent = it.connect_fresh()
    try:
        # Instruction-shaped memories give the extractor procedural material.
        for text in (
            "Always respond concisely and avoid filler.",
            "Prefer bullet points over long paragraphs.",
            "Never reveal internal reasoning to the user.",
        ):
            resp = client.encode(EncodeBuilder(text).derived().build())
            assert resp.lsn > 0

        # Empty category list = no category filter; take whatever was extracted.
        proc = _materialize(client, categories=[])
        _assert_shape(proc)
    finally:
        client.close()


def test_materialize_procedural_on_empty_space(it):
    client, _agent = it.connect_fresh()
    try:
        # A fresh space with nothing written still materializes a well-formed
        # (empty) block rather than erroring.
        proc = _materialize(client, categories=[])
        _assert_shape(proc)
        assert proc.total_candidates == 0
        assert proc.statement_ids == []
    finally:
        client.close()
