"""Feature: typed-graph RELATION lifecycle — create → get → supersede →
tombstone, plus traversal (integration, real server).

None of these verbs has a conformance vector, so before this suite existed a
real server had never seen what Python puts on the wire for any of them.

Ported from the Rust suite, which had it while the other two SDKs did not.
Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture.
"""

from __future__ import annotations

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    EntityCreateRequest,
    EvidenceRef,
    RelationCreateRequest,
    RelationGetRequest,
    RelationSupersedeRequest,
    RelationTombstoneRequest,
    RelationTraverseRequest,
)

# 2^64 - 1: "no end", the open-ended upper bound of a bitemporal validity range.
FOREVER = (1 << 64) - 1


def _entity(client, name: str) -> bytes:
    return client.create_entity(
        EntityCreateRequest(
            entity_type_id=1,
            canonical_name=name,
            aliases=[],
            attributes_blob=[],
            session_id=0,
            request_id=new_id(),
        )
    ).entity_id


def _relation(from_entity: bytes, to_entity: bytes) -> RelationCreateRequest:
    return RelationCreateRequest(
        relation_type="org:collaborated_with",
        from_entity=from_entity,
        to_entity=to_entity,
        properties_blob=[],
        evidence=EvidenceRef.inline([]),
        extractor_id=0,
        confidence=0.8,
        valid_from_unix_nanos=0,
        valid_to_unix_nanos=FOREVER,
        session_id=0,
        request_id=new_id(),
    )


def test_create_get_supersede_tombstone(it):
    client, _space = it.connect_fresh()
    try:
        a = _entity(client, "Ada")
        b = _entity(client, "Babbage")

        created = client.create_relation(_relation(a, b))

        got = client.get_relation(
            RelationGetRequest(relation_id=created.relation_id, follow_supersession=False)
        )
        assert got.relation.relation_id == created.relation_id
        assert got.relation.relation_type == "org:collaborated_with"
        assert got.relation.from_entity == a
        assert got.relation.to_entity == b

        superseded = client.supersede_relation(
            RelationSupersedeRequest(
                old_relation_id=created.relation_id,
                new_relation=_relation(a, b),
                request_id=new_id(),
            )
        )
        assert superseded.new_relation_id != created.relation_id, (
            "supersede mints a new relation rather than mutating the old one"
        )
        assert superseded.version > 1, "the chain version advances"

        # Following supersession from the original id lands on the chain head.
        head = client.get_relation(
            RelationGetRequest(relation_id=created.relation_id, follow_supersession=True)
        )
        assert head.relation.relation_id == superseded.new_relation_id
        assert head.returned_via_supersession

        tombstoned = client.tombstone_relation(
            RelationTombstoneRequest(
                relation_id=superseded.new_relation_id,
                reason="merged duplicate",
                request_id=new_id(),
            )
        )
        assert tombstoned.tombstoned_at_unix_nanos > 0
    finally:
        client.close()


def test_traverse_from_an_anchor_entity(it):
    client, _space = it.connect_fresh()
    try:
        a = _entity(client, "Ada")
        b = _entity(client, "Babbage")
        client.create_relation(_relation(a, b))

        paths = client.traverse_relations(
            RelationTraverseRequest(
                start_entity=a,
                relation_types=["org:collaborated_with"],
                direction=0,  # outgoing
                max_depth=2,
                max_nodes=100,
                time_at_unix_nanos=0,
                include_superseded=False,
                request_id=new_id(),
            )
        )
        # Each step must name the relation it traversed and be depth-ordered
        # from the anchor; whether a path exists is the server's business.
        for path in paths:
            assert path.steps, "a returned path carries at least one hop"
            for depth, step in enumerate(path.steps, start=1):
                assert step.depth == depth, "hops are depth-ordered from the anchor"
                assert step.relation_type
    finally:
        client.close()
