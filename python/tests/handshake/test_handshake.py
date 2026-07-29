"""Feature: handshake + mandatory auth (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline.
"""

from __future__ import annotations

import pytest

from brain_db_sdk import Auth, BrainClient, new_id
from brain_db_sdk.errors import ServerError


def test_minted_token_resolves_session(it):
    agent = new_id()
    client = it.connect_as(agent)
    try:
        session = client.connection
        # The server derives identity from the credential: the session's agent
        # is exactly the one the key was minted for, bound to the tenant.
        assert session.space_id == agent
        assert session.namespace == it.namespace
        assert session.chosen_version == 1
    finally:
        client.close()


def test_two_agents_get_distinct_sessions(it):
    a, a_id = it.connect_fresh()
    b, b_id = it.connect_fresh()
    try:
        assert a_id != b_id
        assert a.connection.space_id == a_id
        assert b.connection.space_id == b_id
        assert a.connection.namespace == b.connection.namespace  # same tenant
    finally:
        a.close()
        b.close()


def test_bad_token_is_refused(it):
    # A token the server never minted must not resolve to a session. Asserting
    # the specific error, not a blind `Exception`: a bare `raises(Exception)`
    # would also pass on a connection refusal or a codec bug, which is the
    # opposite of what this is checking.
    with pytest.raises(ServerError) as excinfo:
        BrainClient.connect(it.data_host, it.data_port, Auth.token(b"brain_not-a-real-key"))
    assert "unknown API key" in str(excinfo.value), (
        f"expected an authentication rejection, got: {excinfo.value}"
    )
