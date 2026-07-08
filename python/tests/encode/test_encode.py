"""Feature: ENCODE — write episodic memory (integration, real server).

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture; skips offline. Each test
mints a fresh, isolated agent.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder


def test_encode_returns_a_durable_id(it):
    client, _agent = it.connect_fresh()
    try:
        resp = client.encode(EncodeBuilder("The Eiffel Tower is in Paris.").build())
        # WAL-before-ack: a returned response means the write was durably
        # logged, so the log sequence number is assigned and non-zero.
        assert resp.lsn > 0
        assert resp.salience >= 0.0
    finally:
        client.close()


def test_encode_carries_context_and_event_time(it):
    client, _agent = it.connect_fresh()
    try:
        req = (
            EncodeBuilder("We shipped v1 on launch day.")
            .context(42)
            .occurred_at(1_700_000_000_000_000_000)
            .build()
        )
        resp = client.encode(req)
        assert resp.lsn > 0
    finally:
        client.close()


def test_encode_is_idempotent_on_identical_text(it):
    client, _agent = it.connect_fresh()
    try:
        req = EncodeBuilder("A fact I might repeat verbatim.").build()
        first = client.encode(req)
        second = client.encode(req)
        assert first.lsn > 0 and second.lsn > 0
    finally:
        client.close()
