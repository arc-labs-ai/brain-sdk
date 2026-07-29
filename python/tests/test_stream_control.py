"""SCHEMA_REPLACE and CANCEL_STREAM round-trips against an in-process mock server.

Neither verb is in the vendored conformance corpus, so unlike the rest of the
wire surface they have no byte-level drift guard. Until Brain regenerates the
corpus with them, this test is the only thing pinning their opcodes and payload
shapes — which is why it asserts the numeric opcode rather than trusting the
enum, so a renumbering upstream fails here instead of silently.
"""

from __future__ import annotations

import socket
import threading
import uuid

from brain_db_sdk import Auth, BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthOkPayload,
    AuthPayload,
    CancelStreamAck,
    CancelStreamRequest,
    HelloPayload,
    SchemaReplaceRequest,
    SchemaReplaceResponse,
    ServerFeatures,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

SERVER_AGENT_ID = b"\x22" * 16
# The stream the client asks the server to stop.
TARGET_STREAM = 7


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(
        sock,
        Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload),
    )


def _handshake(sock: socket.socket, buf: bytearray) -> None:
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    _write(
        sock,
        Opcode.WELCOME,
        0,
        encode_payload(
            WelcomePayload(
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
        ),
    )

    auth_frame = read_frame(sock, buf)
    decode_payload(AuthPayload, auth_frame.payload)
    _write(
        sock,
        Opcode.AUTH_OK,
        0,
        encode_payload(
            AuthOkPayload(
                space_id=SERVER_AGENT_ID,
                bound_shard_id=0,
                permissions=SpacePermissions(
                    can_encode=True,
                    can_recall=True,
                    can_plan=True,
                    can_reason=True,
                    can_forget=True,
                    can_admin=True,
                ),
                namespace="",
                server_time_unix_nanos=1,
            )
        ),
    )


def _serve(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    # SCHEMA_REPLACE.
    f = read_frame(sock, buf)
    assert f.opcode == 0x0127, "SCHEMA_REPLACE opcode"
    req = decode_payload(SchemaReplaceRequest, f.payload)
    assert req.schema_document == "entity Person {}"
    assert req.force_drop_existing, (
        "the SDK must not send force_drop_existing=False — the server rejects it"
    )
    _write(
        sock,
        Opcode.SCHEMA_REPLACE_RESP,
        f.stream_id,
        encode_payload(
            SchemaReplaceResponse(
                namespace="app",
                schema_version=4,
                dropped_count=129,
                validation_errors=[],
            )
        ),
    )

    # CANCEL_STREAM — rides its own stream id, names the target in the body.
    f = read_frame(sock, buf)
    assert f.opcode == 0x0050, "CANCEL_STREAM opcode"
    req = decode_payload(CancelStreamRequest, f.payload)
    assert req.target_stream_id == TARGET_STREAM
    assert req.reason == "ClientUnneeded"
    assert f.stream_id != TARGET_STREAM, (
        "cancel must not ride the stream it is cancelling, or it queues behind "
        "the very frames it is trying to stop"
    )
    _write(
        sock,
        Opcode.CANCEL_STREAM_ACK,
        f.stream_id,
        encode_payload(
            CancelStreamAck(target_stream_id=TARGET_STREAM, cancelled_at_unix_nanos=1234)
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def _spawn(handler) -> tuple[str, int, threading.Thread, socket.socket]:
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


def test_schema_replace_and_cancel_stream() -> None:
    host, port, thread, listener = _spawn(_serve)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"test-token"))

        replaced = client.replace_schema(
            SchemaReplaceRequest(
                schema_document="entity Person {}",
                force_drop_existing=True,
                request_id=uuid.uuid4().bytes,
            )
        )
        assert replaced.schema_version == 4
        assert replaced.dropped_count == 129, (
            "dropped_count is the whole point of the verb — it is how a caller "
            "learns how much the swap destroyed"
        )

        ack = client.cancel_stream(TARGET_STREAM)
        assert ack.target_stream_id == TARGET_STREAM
        assert ack.cancelled_at_unix_nanos == 1234

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()
