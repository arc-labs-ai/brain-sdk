"""Feature: idempotency by request id — replaying a write with the same
``request_id`` returns the cached response, not a second row.

This is what makes at-least-once client retries safe, and the SDK's own retry
layer depends on it. Integration only; gated on ``BRAIN_SDK_IT_DATA`` via the
``it`` fixture.

Ported from the Rust suite, which had it and the other two SDKs did not.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder, new_id
from brain_db_sdk.wire.types import EntityCreateRequest


def test_repeated_encode_is_idempotent(it):
    client, _space = it.connect_fresh()
    try:
        # One request value, so one request_id, sent twice: a retry, not a
        # second write.
        req = EncodeBuilder("A memory that must not double on retry.").build()
        first = client.encode(req)
        second = client.encode(req)

        assert first.memory_id == second.memory_id, (
            "same request_id must return the same memory, not a second row"
        )
        assert first.lsn == second.lsn, "the retry replays the cached response"
    finally:
        client.close()


def test_repeated_create_entity_is_idempotent(it):
    client, _space = it.connect_fresh()
    try:
        req = EntityCreateRequest(
            entity_type_id=1,
            canonical_name="Idempotent Ada",
            aliases=[],
            attributes_blob=[],
            session_id=0,
            request_id=new_id(),
        )
        first = client.create_entity(req)
        second = client.create_entity(req)

        assert first.entity_id == second.entity_id, (
            "same request_id must resolve to the same entity"
        )
    finally:
        client.close()
