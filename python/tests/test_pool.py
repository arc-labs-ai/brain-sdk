"""Connection-pool integration test: a pool of 3 opens 3 independent sockets,
and round-robin ``get()`` spreads requests across all three. The mock server
tags each accepted connection with its accept order and echoes that tag as the
ENCODE response's ``memory_id``, so the client can prove which socket served
each request — three round-robin encodes must touch all three.
"""

from __future__ import annotations

import socket
import threading

import pytest

from brain_db_sdk import Auth, Pool, ProtocolError, new_id
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
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload))


# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _serve_member(sock: socket.socket, tag: int) -> None:
    """Handshake, then answer every ENCODE with a response whose ``memory_id``
    is this connection's accept-order ``tag``."""
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        connection_id=b"\xAB" * 16,
        capabilities=hello.capabilities,
        server_features=ServerFeatures(
            max_payload_size=1 << 20,
            max_concurrent_streams=64,
            idle_timeout_seconds=300,
            auth_methods=[],
        ),
    )
    _write(sock, Opcode.WELCOME, 0, encode_payload(welcome))

    auth_frame = read_frame(sock, buf)
    decode_payload(AuthPayload, auth_frame.payload)
    auth_ok = AuthOkPayload(
        space_id=SERVER_AGENT_ID,
        bound_shard_id=0,
        permissions=AgentPermissions(
            can_encode=True,
            can_recall=True,
            can_plan=True,
            can_reason=True,
            can_forget=True,
            can_admin=False,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    while True:
        try:
            frame = read_frame(sock, buf)
        except Exception:  # noqa: BLE001 — peer closed
            return
        if frame.opcode == Opcode.BYE:
            return
        if frame.opcode != Opcode.ENCODE_REQ:
            continue
        req = decode_payload(EncodeRequest, frame.payload)
        resp = EncodeResponse(
            memory_id=tag,
            was_deduplicated=False,
            salience=0.5,
            auto_edges_added=0,
            lsn=1,
            space_id=SERVER_AGENT_ID,
            session_id=req.session_id,
            kind=MemoryKind.SEMANTIC,
            created_at_unix_nanos=1,
            edges_out_count=0,
            embedding_model_fp=b"\x00" * 16,
            pending_stages=[],
            has_active_schema=True,
        )
        _write(sock, Opcode.ENCODE_RESP, frame.stream_id, encode_payload(resp))


def _request() -> EncodeRequest:
    return EncodeRequest(
        text="pooled",
        session_id=1,
        request_id=new_id(),
        txn_id=None,
        occurred_at_unix_nanos=None,
    )


def test_pool_spreads_requests_across_all_members() -> None:
    size = 3
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(size)
    host, port = listener.getsockname()

    def run() -> None:
        for tag in range(size):
            conn, _peer = listener.accept()
            threading.Thread(target=_serve_member, args=(conn, tag), daemon=True).start()

    server = threading.Thread(target=run, daemon=True)
    server.start()

    try:
        pool = Pool.connect(host, port, size, Auth.token(b"opaque-token"))
        assert pool.size() == size

        seen = set()
        for _ in range(size):
            client = pool.get()
            resp = client.encode(_request())
            seen.add(resp.memory_id)
        assert seen == set(range(size)), "round-robin must spread across every pooled socket"

        pool.close()
        server.join(timeout=5)
    finally:
        listener.close()


def test_pool_rejects_zero_size() -> None:
    with pytest.raises(ProtocolError):
        Pool.connect("127.0.0.1", 1, 0, Auth.token(b"opaque-token"))
