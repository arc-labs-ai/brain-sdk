"""Feature: FORGET — retire episodic memory (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Soft
FORGET tombstones (invisible to recall, recoverable through the grace window);
hard FORGET zeroes the slot now.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder, ForgetBuilder, RecallBuilder
from brain_db_sdk.wire.types import ForgetMode


def test_soft_forget_removes_from_recall(it, recall_until):
    client, _agent = it.connect_fresh()
    try:
        mem_id = client.encode(
            EncodeBuilder("The meeting is scheduled for Tuesday.").build()
        ).memory_id

        req = RecallBuilder("When is the meeting?").text(True).build()
        # Wait until it is actually recallable, so the post-forget assertion is
        # meaningful (not vacuously true because the index lagged).
        before = recall_until(client, req, lambda a: any(m.memory_id == mem_id for m in a.memories))
        assert any(m.memory_id == mem_id for m in before.memories)

        client.forget(ForgetBuilder(mem_id).with_mode(ForgetMode.SOFT).build())

        after = recall_until(
            client, req, lambda a: not any(m.memory_id == mem_id for m in a.memories)
        )
        assert not any(m.memory_id == mem_id for m in after.memories)
    finally:
        client.close()


def test_hard_forget_is_idempotent_on_missing(it):
    client, _agent = it.connect_fresh()
    try:
        mem_id = client.encode(
            EncodeBuilder("A secret worth zeroing immediately.").build()
        ).memory_id

        # Hard FORGET zeroes the slot now.
        client.forget(ForgetBuilder(mem_id).hard().build())
        # FORGET is lenient: forgetting an already-gone id is a no-op success,
        # so a retry (at-least-once delivery) is safe.
        client.forget(ForgetBuilder(mem_id).hard().build())
    finally:
        client.close()
