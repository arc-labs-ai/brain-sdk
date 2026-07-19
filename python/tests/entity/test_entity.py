"""Feature: typed-graph ENTITY lifecycle — create → update → rename → merge →
unmerge → tombstone (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline.
"""

from __future__ import annotations

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    EntityCreateRequest,
    EntityMergeRequest,
    EntityRenameRequest,
    EntityTombstoneRequest,
    EntityUnmergeRequest,
    EntityUpdateRequest,
)


def _create(client, name: str) -> bytes:
    return client.create_entity(
        EntityCreateRequest(
            entity_type_id=1,
            canonical_name=name,
            aliases=[],
            attributes_blob=[],
            request_id=new_id(),
        )
    ).entity_id


def test_update_then_rename_then_tombstone(it):
    client, _agent = it.connect_fresh()
    try:
        entity_id = _create(client, "Ada")

        updated = client.update_entity(
            EntityUpdateRequest(
                entity_id=entity_id,
                canonical_name="Ada Lovelace",
                aliases=["Ada"],
                attributes_blob=list(b"role=mathematician"),
                request_id=new_id(),
            )
        )
        assert updated.entity.canonical_name == "Ada Lovelace"

        renamed = client.rename_entity(
            EntityRenameRequest(
                entity_id=entity_id,
                new_canonical_name="Countess Lovelace",
                move_to_alias=True,
                request_id=new_id(),
            )
        )
        assert renamed.entity.canonical_name == "Countess Lovelace"
        assert "Ada Lovelace" in renamed.entity.aliases

        ts = client.tombstone_entity(
            EntityTombstoneRequest(
                entity_id=entity_id, reason="test cleanup", request_id=new_id()
            )
        )
        assert ts.tombstoned_at_unix_nanos > 0
    finally:
        client.close()


def test_merge_then_unmerge(it):
    client, _agent = it.connect_fresh()
    try:
        survivor = _create(client, "NYC")
        merged = _create(client, "New York City")

        m = client.merge_entities(
            EntityMergeRequest(
                survivor=survivor,
                merged=merged,
                confidence=0.95,
                reason="same city",
                request_id=new_id(),
            )
        )
        assert m.grace_period_seconds > 0

        u = client.unmerge_entity(
            EntityUnmergeRequest(merged_entity=merged, request_id=new_id())
        )
        assert u.restored_entity_id == merged
    finally:
        client.close()
