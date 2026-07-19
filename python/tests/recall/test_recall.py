"""Feature: RECALL — read episodic memory (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. ENCODE is
durable on ack but the semantic index becomes searchable a beat later, so these
use ``recall_until`` to poll for read-your-writes visibility.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder, RecallBuilder
from brain_db_sdk.wire.types import AnswerKind


def test_recall_finds_what_was_encoded(it, recall_until):
    client, _agent = it.connect_fresh()
    try:
        stored = client.encode(
            EncodeBuilder("My favorite programming language is Rust.").build()
        ).memory_id

        req = RecallBuilder("What language do I like?").limit(10).text(True).build()
        answer = recall_until(
            client, req, lambda a: any(m.memory_id == stored for m in a.memories)
        )
        assert answer.answer_kind != AnswerKind.NONE
        assert any(m.memory_id == stored for m in answer.memories)
    finally:
        client.close()


def test_recall_respects_max_results_cap(it, recall_until):
    client, _agent = it.connect_fresh()
    try:
        for i in range(8):
            client.encode(EncodeBuilder(f"Fact number {i} about coffee brewing.").build())

        req = RecallBuilder("coffee").limit(3).text(True).build()
        answer = recall_until(client, req, lambda a: len(a.memories) > 0)
        assert len(answer.memories) > 0
        assert len(answer.memories) <= 3
    finally:
        client.close()


def test_recall_confidence_threshold_is_accepted(it, recall_until):
    client, _agent = it.connect_fresh()
    try:
        client.encode(EncodeBuilder("The capital of Japan is Tokyo.").build())

        req = RecallBuilder("capital of Japan").confidence(0.0).text(True).build()
        answer = recall_until(client, req, lambda a: len(a.memories) > 0)
        assert len(answer.memories) > 0
    finally:
        client.close()
