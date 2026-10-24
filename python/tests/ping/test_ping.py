"""PING must go out on stream 0, on the synchronous client too.

The asyncio suite pins the same claim for its tier; this one covers the
threaded client, which carried the identical bug. `ping()` went through the
unary path, which allocates an odd op-stream id, while Brain classifies
PING/PONG as connection-level alongside HELLO/AUTH/BYE and refuses them
anywhere but stream 0 with `connection-level opcode requires stream_id = 0`.

The bug was found by running against live Brain, not here — the rule lives in
the server's dispatch layer, and the mock below answers a wrong-stream PING
quite happily. What a mock can pin is the stream id the client chose, which is
precisely what was wrong.
"""

from __future__ import annotations

import contextlib
import socket
import threading

from brain_db_sdk import Auth, BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthOkPayload,
    AuthPayload,
    HelloPayload,
    PingRequest,
    PongResponse,
    ServerFeatures,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

SERVER_AGENT_ID = b"\x22" * 16


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(
        sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload)
    )


def _serve_ping(sock: socket.socket, seen: list[int]) -> None:
    buf = bytearray()

    hello = decode_payload(HelloPayload, read_frame(sock, buf).payload)
    _write(
        sock,
        Opcode.WELCOME,
        0,
        encode_payload(
            WelcomePayload(
                server_id="mock-brain",
                chosen_version=1,
                connection_id=b"\xab" * 16,
                capabilities=hello.capabilities,
                server_features=ServerFeatures(
                    max_payload_size=1 << 20,
                    max_concurrent_streams=256,
                    idle_timeout_seconds=300,
                    auth_methods=[],
                ),
            )
        ),
    )

    decode_payload(AuthPayload, read_frame(sock, buf).payload)
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
                    can_admin=False,
                ),
                namespace="",
                server_time_unix_nanos=1,
            )
        ),
    )

    frame = read_frame(sock, buf)
    seen.append(frame.stream_id)
    sent = decode_payload(PingRequest, frame.payload)
    # Echo on whatever stream it arrived on, so a wrong-stream PING still
    # round-trips here and the assertion is the only thing that can fail.
    _write(
        sock,
        Opcode.PONG,
        frame.stream_id,
        encode_payload(
            PongResponse(
                client_timestamp_unix_nanos=sent.client_timestamp_unix_nanos,
                server_timestamp_unix_nanos=7,
            )
        ),
    )
    with contextlib.suppress(Exception):
        read_frame(sock, buf)  # BYE
    sock.close()


def test_ping_travels_on_the_connection_stream() -> None:
    seen: list[int] = []
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]

    def accept() -> None:
        conn, _ = listener.accept()
        with contextlib.suppress(Exception):
            _serve_ping(conn, seen)

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        with BrainClient.connect("127.0.0.1", port, Auth.token(b"opaque-token")) as client:
            assert client.ping().server_timestamp_unix_nanos == 7
        assert seen == [0], f"PING went out on stream {seen}, not the connection stream"
    finally:
        listener.close()
        thread.join(timeout=2)
