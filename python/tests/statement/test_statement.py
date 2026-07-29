"""Feature: typed-graph STATEMENT lifecycle — create → supersede → history →
tombstone / retract (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Each test
mints a fresh, isolated agent and its own subject entity.
"""

from __future__ import annotations

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    EntityCreateRequest,
    EvidenceRef,
    StatementCreateRequest,
    StatementHistoryRequest,
    StatementKind,
    StatementObject,
    StatementRetractRequest,
    StatementSupersedeRequest,
    StatementTombstoneRequest,
    StatementValue,
)


def _subject(client) -> bytes:
    return client.create_entity(
        EntityCreateRequest(
            entity_type_id=1,
            canonical_name="Ada",
            aliases=[],
            attributes_blob=[],
            session_id=0,
            request_id=new_id(),
        )
    ).entity_id


def _fact(subject: bytes, obj: str) -> StatementCreateRequest:
    # Predicates must be namespaced ("namespace:name"); reason codes are 1..=4.
    return StatementCreateRequest(
        kind=StatementKind.FACT,
        subject=subject,
        predicate="org:works_on",
        object=StatementObject("Value", StatementValue("Text", obj)),
        confidence=0.9,
        evidence=EvidenceRef.inline([]),
        extractor_id=0,
        valid_from_unix_nanos=0,
        valid_to_unix_nanos=(1 << 64) - 1,
        event_at_unix_nanos=0,
        schema_version=1,
        session_id=0,
        request_id=new_id(),
    )


def test_supersede_builds_a_history_chain(it):
    client, _agent = it.connect_fresh()
    try:
        subject = _subject(client)
        first = client.create_statement(_fact(subject, "brain"))

        superseded = client.supersede_statement(
            StatementSupersedeRequest(
                old_statement_id=first.statement_id,
                new_statement=_fact(subject, "brain-db"),
                request_id=new_id(),
            )
        )
        assert superseded.chain_root == first.chain_root
        assert superseded.version >= 2

        history = client.statement_history(
            StatementHistoryRequest(anchor_id=first.statement_id, include_tombstoned=True)
        )
        assert len(history) >= 2
    finally:
        client.close()


def test_tombstone_and_retract_are_accepted(it):
    client, _agent = it.connect_fresh()
    try:
        subject = _subject(client)

        a = client.create_statement(_fact(subject, "one"))
        ts = client.tombstone_statement(
            StatementTombstoneRequest(
                statement_id=a.statement_id,
                reason=1,
                reason_message="superseded by hand",
                request_id=new_id(),
            )
        )
        assert ts.tombstoned_at_unix_nanos > 0

        b = client.create_statement(_fact(subject, "two"))
        rt = client.retract_statement(
            StatementRetractRequest(
                statement_id=b.statement_id,
                reason=1,
                reason_message="was wrong",
                request_id=new_id(),
            )
        )
        assert rt.will_zero_at_unix_nanos >= rt.retracted_at_unix_nanos
    finally:
        client.close()
