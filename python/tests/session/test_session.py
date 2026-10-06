"""Feature: SESSION registry CRUD — create → list (present) → delete → list
(gone), plus the idempotent-replay edge (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Each test
mints a fresh, isolated agent whose space owns the sessions it creates, so the
membership assertions are unaffected by other tests.
"""

from __future__ import annotations

import random

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    SessionCreateRequest,
    SessionDeleteRequest,
    SessionListRequest,
)


def _nonzero_session_id() -> int:
    # session_id 0 is the default, non-deletable session; pick a random u64 > 0.
    return random.randrange(1, 1 << 63)


def _session_ids(client) -> list[int]:
    listed = client.list_sessions(SessionListRequest(limit=0))
    return [s.session_id for s in listed.sessions]


def test_session_crud_round_trip(it):
    client, _agent = it.connect_fresh()
    try:
        sid = _nonzero_session_id()

        created = client.create_session(
            SessionCreateRequest(session_id=sid, request_id=new_id(), title="round-trip")
        )
        assert created.created is True
        assert created.session_id == sid

        # list_sessions must surface the session we just provisioned.
        assert sid in _session_ids(client)

        # hard delete zeroes immediately, so the registry row disappears at once.
        deleted = client.delete_session(
            SessionDeleteRequest(session_id=sid, request_id=new_id(), hard=True)
        )
        assert deleted.existed is True
        assert deleted.session_id == sid

        assert sid not in _session_ids(client)
    finally:
        client.close()


def test_create_session_is_idempotent(it):
    client, _agent = it.connect_fresh()
    try:
        sid = _nonzero_session_id()

        first = client.create_session(SessionCreateRequest(session_id=sid, request_id=new_id()))
        assert first.created is True

        second = client.create_session(SessionCreateRequest(session_id=sid, request_id=new_id()))
        assert second.created is False
        assert second.session_id == sid
    finally:
        client.close()
