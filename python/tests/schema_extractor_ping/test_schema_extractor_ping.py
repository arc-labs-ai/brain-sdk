"""Round-trips against an in-process mock server for the verbs that had a type,
a client method, and a corpus vector but no live-or-mock integration test:
SCHEMA_DROP, EXTRACTOR_LIST, and the client-initiated PING → PONG probe.

Each test drives one verb over one connection through the real handshake
(HELLO → WELCOME → AUTH → AUTH_OK) and checks the decoded reply. The mock is
the same socket + daemon-thread pattern as ``tests/test_graph.py``.
"""

from __future__ import annotations

import socket
import threading

from brain_db_sdk import Auth, BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    SCHEMA_DROP_TARGET_PREDICATE,
    AuthOkPayload,
    AuthPayload,
    ExtractorListItem,
    ExtractorListRequest,
    ExtractorListResponseFrame,
    HelloPayload,
    PingRequest,
    PongResponse,
    SchemaDropRequest,
    SchemaDropResponse,
    ServerFeatures,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(
        sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload)
    )


def _handshake(sock: socket.socket, buf: bytearray) -> None:
    """Consume HELLO/AUTH and reply WELCOME/AUTH_OK, mirroring test_graph."""
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        connection_id=b"\xab" * 16,
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
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))


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


def _rid() -> bytes:
    import uuid

    return uuid.uuid4().bytes


def _serve_schema_drop(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    # First SCHEMA_DROP: the declared type is present and gets removed.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_DROP_REQ
    req = decode_payload(SchemaDropRequest, f.payload)
    assert req.namespace == "people"
    assert req.target_kind == SCHEMA_DROP_TARGET_PREDICATE
    assert req.target_name == "born_in"
    _write(
        sock,
        Opcode.SCHEMA_DROP_RESP,
        f.stream_id,
        encode_payload(
            SchemaDropResponse(
                namespace="people",
                schema_version=3,
                target_kind=SCHEMA_DROP_TARGET_PREDICATE,
                target_name="born_in",
                dropped=True,
                live_rows=0,
                validation_errors=[],
            )
        ),
    )

    # Second SCHEMA_DROP of the same type: the server's lenient re-drop is a
    # no-op success — dropped=false, and schema_version=0 signals "nothing
    # changed". The client must decode this shape too.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_DROP_REQ
    _write(
        sock,
        Opcode.SCHEMA_DROP_RESP,
        f.stream_id,
        encode_payload(
            SchemaDropResponse(
                namespace="people",
                schema_version=0,
                target_kind=SCHEMA_DROP_TARGET_PREDICATE,
                target_name="born_in",
                dropped=False,
                live_rows=0,
                validation_errors=[],
            )
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def test_schema_drop_then_lenient_redrop() -> None:
    host, port, thread, listener = _spawn(_serve_schema_drop)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        first = client.drop_schema(
            SchemaDropRequest(
                namespace="people",
                target_kind=SCHEMA_DROP_TARGET_PREDICATE,
                target_name="born_in",
                force=False,
                request_id=_rid(),
            )
        )
        assert first.dropped
        assert first.schema_version == 3
        assert first.live_rows == 0

        # Re-dropping the now-absent type is a no-op success, not an error.
        again = client.drop_schema(
            SchemaDropRequest(
                namespace="people",
                target_kind=SCHEMA_DROP_TARGET_PREDICATE,
                target_name="born_in",
                force=False,
                request_id=_rid(),
            )
        )
        assert not again.dropped
        assert again.schema_version == 0

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()


def _serve_extractor_list(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    f = read_frame(sock, buf)
    assert f.opcode == Opcode.EXTRACTOR_LIST_REQ
    decode_payload(ExtractorListRequest, f.payload)
    _write(
        sock,
        Opcode.EXTRACTOR_LIST_RESP,
        f.stream_id,
        encode_payload(
            ExtractorListResponseFrame(
                items=[
                    ExtractorListItem(
                        extractor_id=1,
                        namespace="brain",
                        name="pattern",
                        kind=0,
                        schema_version=1,
                        created_at_unix_nanos=42,
                    ),
                    ExtractorListItem(
                        extractor_id=2,
                        namespace="people",
                        name="classifier",
                        kind=1,
                        schema_version=2,
                        created_at_unix_nanos=43,
                    ),
                ],
                total=2,
                is_final=True,
            )
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def test_extractor_list_round_trip() -> None:
    host, port, thread, listener = _spawn(_serve_extractor_list)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        listing = client.extractor_list()
        assert listing.total == 2
        assert listing.is_final
        assert [i.name for i in listing.items] == ["pattern", "classifier"]
        assert listing.items[0].kind == 0
        assert listing.items[1].kind == 1

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()


def _serve_ping(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    f = read_frame(sock, buf)
    assert f.opcode == Opcode.PING
    req = decode_payload(PingRequest, f.payload)
    # PONG echoes the client's timestamp and adds the server's own.
    _write(
        sock,
        Opcode.PONG,
        f.stream_id,
        encode_payload(
            PongResponse(
                client_timestamp_unix_nanos=req.client_timestamp_unix_nanos,
                server_timestamp_unix_nanos=req.client_timestamp_unix_nanos + 100,
            )
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def test_ping_round_trip() -> None:
    host, port, thread, listener = _spawn(_serve_ping)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        pong = client.ping(client_timestamp_unix_nanos=1234)
        assert pong.client_timestamp_unix_nanos == 1234
        assert pong.server_timestamp_unix_nanos == 1334

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()
