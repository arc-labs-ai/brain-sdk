"""Handshake + round-trip tests.

The default test stands up an in-process mock server on a loopback socket
(in a background thread) that speaks the server side of the protocol
(HELLO -> WELCOME -> AUTH -> AUTH_OK, then one ENCODE -> ENCODE_RESP, then
BYE) and drives a real :class:`BrainClient` against it — exercising the TCP
connect, transport, handshake, and request/response paths without needing
a Linux ``brain-server``.

``test_live_server_handshake`` runs the same flow against a real server
when ``BRAIN_TEST_ADDR=host:port`` is set, and is skipped otherwise.
"""

from __future__ import annotations

import os
import socket
import threading

import pytest

from brain_db_sdk import BrainClient, VersionMismatch, new_id
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AgentPermissions,
    AuthOkPayload,
    AuthPayload,
    EncodeRequest,
    EncodeResponse,
    HelloPayload,
    MemoryKind,
    ServerFeatures,
    StageKind,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

MEMORY_ID = 0x0102_0304_0506_0708_090A_0B0C_0D0E_0F10


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(
        sock,
        Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload),
    )


def _serve_one(sock: socket.socket) -> None:
    """The server side of the protocol for one connection, as a test double."""
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    assert hello_frame.opcode == Opcode.HELLO
    hello = decode_payload(HelloPayload, hello_frame.payload)
    assert 1 in hello.supported_versions

    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        session_id=b"\xAB" * 16,
        capabilities=hello.capabilities,
        server_features=ServerFeatures(
            max_payload_size=16 * 1024 * 1024,
            max_concurrent_streams=256,
            idle_timeout_seconds=300,
            auth_methods=[],
        ),
    )
    _write(sock, Opcode.WELCOME, 0, encode_payload(welcome))

    auth_frame = read_frame(sock, buf)
    assert auth_frame.opcode == Opcode.AUTH
    auth = decode_payload(AuthPayload, auth_frame.payload)

    auth_ok = AuthOkPayload(
        agent_id=auth.agent_id,
        bound_shard_id=3,
        permissions=AgentPermissions(
            can_encode=True,
            can_recall=True,
            can_plan=True,
            can_reason=True,
            can_forget=True,
            can_admin=False,
        ),
        server_time_unix_nanos=1_700_000_000_000_000_000,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    enc_frame = read_frame(sock, buf)
    assert enc_frame.opcode == Opcode.ENCODE_REQ
    enc = decode_payload(EncodeRequest, enc_frame.payload)

    resp = EncodeResponse(
        memory_id=MEMORY_ID,
        was_deduplicated=False,
        salience=0.75,
        auto_edges_added=0,
        lsn=42,
        agent_id=auth.agent_id,
        context_id=enc.context_id,
        kind=enc.kind,
        created_at_unix_nanos=1_700_000_000_000_000_001,
        edges_out_count=0,
        embedding_model_fp=b"\x11\x22\x33\x44\x55\x66\x77\x88\x99\xAA\xBB\xCC\xDD\xEE\xFF\x00",
        pending_stages=[StageKind.AUTO_EDGE, StageKind.EXTRACTOR],
        has_active_schema=True,
    )
    _write(sock, Opcode.ENCODE_RESP, enc_frame.stream_id, encode_payload(resp))

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def _spawn_server(handler) -> tuple[str, int, threading.Thread, socket.socket]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    host, port = listener.getsockname()

    def run() -> None:
        conn, _peer = listener.accept()
        with conn:
            handler(conn)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return host, port, thread, listener


def _sample_encode_request() -> EncodeRequest:
    return EncodeRequest(
        text="the user prefers dark mode",
        context_id=9,
        kind=MemoryKind.SEMANTIC,
        salience_hint=0.5,
        edges=[],
        request_id=new_id(),
        txn_id=None,
        deduplicate=True,
    )


def test_connect_handshake_encode_round_trip_against_mock_server() -> None:
    host, port, thread, listener = _spawn_server(_serve_one)
    try:
        client = BrainClient.connect(host, port)

        session = client.session
        assert session.chosen_version == 1
        assert session.server_id == "mock-brain"
        assert session.bound_shard_id == 3
        assert session.session_id == b"\xAB" * 16
        assert session.permissions.can_encode
        assert not session.permissions.can_admin
        assert session.server_features.max_concurrent_streams == 256

        req = _sample_encode_request()
        resp = client.encode(req)
        assert resp.memory_id == MEMORY_ID
        assert resp.lsn == 42
        assert resp.context_id == req.context_id
        assert resp.agent_id == client.agent_id
        assert resp.pending_stages == [StageKind.AUTO_EDGE, StageKind.EXTRACTOR]

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()


def test_rejects_a_server_that_chooses_an_unoffered_version() -> None:
    def handler(sock: socket.socket) -> None:
        buf = bytearray()
        hello_frame = read_frame(sock, buf)
        hello = decode_payload(HelloPayload, hello_frame.payload)
        welcome = WelcomePayload(
            server_id="mock-brain",
            chosen_version=99,  # never offered by the client
            session_id=b"\x00" * 16,
            capabilities=hello.capabilities,
            server_features=ServerFeatures(
                max_payload_size=0,
                max_concurrent_streams=0,
                idle_timeout_seconds=0,
                auth_methods=[],
            ),
        )
        _write(sock, Opcode.WELCOME, 0, encode_payload(welcome))

    host, port, thread, listener = _spawn_server(handler)
    try:
        with pytest.raises(VersionMismatch) as excinfo:
            BrainClient.connect(host, port)
        assert excinfo.value.chosen == 99
    finally:
        listener.close()
        thread.join(timeout=5)


@pytest.mark.skipif(
    "BRAIN_TEST_ADDR" not in os.environ,
    reason="BRAIN_TEST_ADDR not set; skipping live handshake test",
)
def test_live_server_handshake() -> None:
    host, _, port = os.environ["BRAIN_TEST_ADDR"].rpartition(":")
    client = BrainClient.connect(host, int(port))
    assert client.session.chosen_version == 1
    assert client.session.permissions.can_encode
    client.close()
