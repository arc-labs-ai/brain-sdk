"""Multiplexed-connection concurrency test: two ENCODE requests issued from
two threads at once, answered by the server in *reverse* order, must each route
back to the right caller by ``stream_id``. Proves the reader-thread demux, not
just a single round-trip.
"""

from __future__ import annotations

import socket
import threading

from brain_db_sdk import MuxConnection, new_id
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AgentPermissions,
    AuthCredentials,
    AuthMethod,
    AuthOkPayload,
    AuthPayload,
    EncodeRequest,
    EncodeResponse,
    HelloCapabilities,
    HelloPayload,
    MemoryKind,
    ServerFeatures,
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload))


def _response(req: EncodeRequest, agent_id: bytes) -> EncodeResponse:
    return EncodeResponse(
        memory_id=req.context_id,
        was_deduplicated=False,
        salience=0.5,
        auto_edges_added=0,
        lsn=1,
        agent_id=agent_id,
        context_id=req.context_id,
        kind=req.kind,
        created_at_unix_nanos=1,
        edges_out_count=0,
        embedding_model_fp=b"\x00" * 16,
        pending_stages=[],
        has_active_schema=True,
    )


def _request(context_id: int) -> EncodeRequest:
    return EncodeRequest(
        text=f"memory {context_id}",
        context_id=context_id,
        kind=MemoryKind.SEMANTIC,
        salience_hint=0.5,
        edges=[],
        request_id=new_id(),
        txn_id=None,
        deduplicate=True,
    )


def _serve_two_concurrent(sock: socket.socket) -> None:
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        session_id=b"\xAB" * 16,
        capabilities=hello.capabilities,
        server_features=ServerFeatures(
            max_payload_size=1 << 20,
            max_concurrent_streams=256,
            idle_timeout_seconds=300,
            auth_methods=[],
        ),
    )
    _write(sock, Opcode.WELCOME, 0, encode_payload(welcome))

    auth_frame = read_frame(sock, buf)
    auth = decode_payload(AuthPayload, auth_frame.payload)
    auth_ok = AuthOkPayload(
        agent_id=auth.agent_id,
        bound_shard_id=0,
        permissions=AgentPermissions(
            can_encode=True,
            can_recall=True,
            can_plan=True,
            can_reason=True,
            can_forget=True,
            can_admin=False,
        ),
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # Read both requests before answering either, then answer in reverse order.
    f1 = read_frame(sock, buf)
    r1 = decode_payload(EncodeRequest, f1.payload)
    f2 = read_frame(sock, buf)
    r2 = decode_payload(EncodeRequest, f2.payload)

    _write(sock, Opcode.ENCODE_RESP, f2.stream_id, encode_payload(_response(r2, auth.agent_id)))
    _write(sock, Opcode.ENCODE_RESP, f1.stream_id, encode_payload(_response(r1, auth.agent_id)))

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


def test_two_requests_in_flight_route_back_correctly() -> None:
    host, port, server_thread, listener = _spawn(_serve_two_concurrent)
    try:
        hello = HelloPayload(
            client_id="mux-test",
            supported_versions=[1],
            capabilities=HelloCapabilities(streaming=True, compression_zstd=False, server_push=False),
            client_session_token=None,
        )
        auth = AuthPayload(method=AuthMethod.NONE, agent_id=new_id(), credentials=AuthCredentials.none())
        conn, outcome = MuxConnection.connect(host, port, hello, auth)
        assert outcome.welcome.chosen_version == 1

        results: dict[int, EncodeResponse] = {}

        def do(context_id: int) -> None:
            frame = conn.request_one(Opcode.ENCODE_REQ, encode_payload(_request(context_id)))
            results[context_id] = decode_payload(EncodeResponse, frame.payload)

        t1 = threading.Thread(target=do, args=(100,))
        t2 = threading.Thread(target=do, args=(200,))
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)
        assert not t1.is_alive() and not t2.is_alive()

        # Despite the server replying in reverse order, each response routed
        # back to the request whose context it echoes.
        assert results[100].memory_id == 100
        assert results[100].context_id == 100
        assert results[200].memory_id == 200
        assert results[200].context_id == 200

        conn.send_bye()
        conn.close()
        server_thread.join(timeout=5)
    finally:
        listener.close()
