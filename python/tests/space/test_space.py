"""Feature: SPACE registry CRUD — create → list (present) → delete → list
(gone), plus the idempotent-replay and not-found edges (integration, real
server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Each test
mints a fresh, isolated agent, so the space it provisions is its own.

Note: keys are minted from a raw 16-byte space id (``space_id_hex``), not a
structured ``namespace:space`` string, so the server echoes an empty
``space_id`` string in the registry rows and :class:`SpaceView` carries no bytes
id. Membership is therefore proven by the count delta on the caller-shard's
listing (create adds exactly one row, delete removes it) rather than by matching
an id — sound because the suite runs serially, so nothing else touches this
namespace between a test's own calls.
"""

from __future__ import annotations

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    SpaceCreateRequest,
    SpaceDeleteRequest,
    SpaceListRequest,
)


def _space_count(client) -> int:
    return len(client.list_spaces(SpaceListRequest(limit=0)).spaces)


def test_space_crud_round_trip(it):
    client, _agent = it.connect_fresh()
    try:
        before = _space_count(client)

        created = client.create_space(SpaceCreateRequest(request_id=new_id()))
        # A never-before-provisioned effective space is genuinely new.
        assert created.created is True

        # list_spaces must now surface exactly one more space — ours.
        assert _space_count(client) == before + 1

        deleted = client.delete_space(SpaceDeleteRequest(request_id=new_id()))
        assert deleted.existed is True

        # After a GDPR erase the registry row is gone.
        assert _space_count(client) == before
    finally:
        client.close()


def test_create_space_is_idempotent(it):
    client, _agent = it.connect_fresh()
    try:
        first = client.create_space(SpaceCreateRequest(request_id=new_id()))
        assert first.created is True

        # A create for an existing space returns the existing row, created=False.
        second = client.create_space(SpaceCreateRequest(request_id=new_id()))
        assert second.created is False
        assert second.space_id == first.space_id
    finally:
        client.close()


def test_delete_space_that_never_existed_reports_absent(it):
    client, _agent = it.connect_fresh()
    try:
        # Fresh agent that never provisioned or wrote: no registry row.
        deleted = client.delete_space(SpaceDeleteRequest(request_id=new_id()))
        assert deleted.existed is False
        assert deleted.memories_forgotten == 0
    finally:
        client.close()
