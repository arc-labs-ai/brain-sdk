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
    AuthCredentials,
    AuthMethod,
    AuthOkPayload,
    AuthPayload,
    ClientPongRequest,
    EncodeRequest,
    EncodeResponse,
    HelloCapabilities,
    HelloPayload,
    MemoryKind,
    ServerFeatures,
    ServerPingResponse,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(
        sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload)
    )


# The server assigns the agent id from the credential; the client never sends
# one. The mock server hands back this fixed id so tests can route responses.
SERVER_AGENT_ID = b"\x22" * 16


def _response(req: EncodeRequest, space_id: bytes) -> EncodeResponse:
    return EncodeResponse(
        memory_id=req.session_id,
        was_deduplicated=False,
        salience=0.5,
        auto_edges_added=0,
        lsn=1,
        space_id=space_id,
        session_id=req.session_id,
        kind=MemoryKind.SEMANTIC,
        created_at_unix_nanos=1,
        edges_out_count=0,
        embedding_model_fp=b"\x00" * 16,
        pending_stages=[],
        has_active_schema=True,
    )


def _request(session_id: int) -> EncodeRequest:
    return EncodeRequest(
        text=f"memory {session_id}",
        session_id=session_id,
        request_id=new_id(),
        txn_id=None,
        occurred_at_unix_nanos=None,
    )


def _serve_two_concurrent(sock: socket.socket) -> None:
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
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
            can_admin=False,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # Read both requests before answering either, then answer in reverse order.
    f1 = read_frame(sock, buf)
    r1 = decode_payload(EncodeRequest, f1.payload)
    f2 = read_frame(sock, buf)
    r2 = decode_payload(EncodeRequest, f2.payload)

    # Client-initiated op streams MUST be non-zero and odd (the real server
    # rejects even/zero client streams as BadFrame). Pin the odd-only stream
    # allocator against regression — this exact bug bit the pool/reuse path.
    for label, sid in (("req 1", f1.stream_id), ("req 2", f2.stream_id)):
        assert sid != 0 and sid % 2 == 1, f"{label} used non-odd client stream id {sid}"

    _write(sock, Opcode.ENCODE_RESP, f2.stream_id, encode_payload(_response(r2, SERVER_AGENT_ID)))
    _write(sock, Opcode.ENCODE_RESP, f1.stream_id, encode_payload(_response(r1, SERVER_AGENT_ID)))

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
            capabilities=HelloCapabilities(
                streaming=True, compression_zstd=False, server_push=False
            ),
            client_connection_token=None,
        )
        auth = AuthPayload(
            method=AuthMethod.TOKEN, credentials=AuthCredentials.token(b"opaque-token")
        )
        conn, outcome = MuxConnection.connect(host, port, hello, auth)
        assert outcome.welcome.chosen_version == 1

        results: dict[int, EncodeResponse] = {}

        def do(session_id: int) -> None:
            frame = conn.request_one(Opcode.ENCODE_REQ, encode_payload(_request(session_id)))
            results[session_id] = decode_payload(EncodeResponse, frame.payload)

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
        assert results[100].session_id == 100
        assert results[200].memory_id == 200
        assert results[200].session_id == 200

        conn.send_bye()
        conn.close()
        server_thread.join(timeout=5)
    finally:
        listener.close()


# ===========================================================================
# SUBSCRIBE: a long-lived server-push stream.
#
# On SUBSCRIBE_REQ the mock server pushes two SUBSCRIBE_EVENT frames (non-EOS)
# on the subscription's stream, then — on UNSUBSCRIBE_REQ — replies
# UNSUBSCRIBE_RESP (EOS) plus a final EOS SUBSCRIBE_EVENT (empty terminator) on
# the subscription stream. The client must drain exactly the two events,
# unsubscribe() must succeed, next() must then return None, and the route table
# must be empty afterward (no leaked subscription route).
# ===========================================================================

from brain_db_sdk.wire.types import (
    EventType,
    SubscribeRequest,
    SubscriptionEvent,
    SubscriptionFilter,
    UnsubscribeRequest,
    UnsubscribeResponse,
)


def _sample_event(lsn: int) -> SubscriptionEvent:
    return SubscriptionEvent(
        event_type=EventType.ENCODED,
        memory_id=lsn,
        session_id=1,
        text=f"event {lsn}",
        kind=MemoryKind.SEMANTIC,
        salience=0.5,
        timestamp_unix_nanos=lsn,
        lsn=lsn,
        graph_payload=None,
        edge_payload=None,
        stage_kind=None,
        stage_outcome=None,
        stage_payload=None,
    )


def _serve_subscription(sock: socket.socket) -> None:
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
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
            can_admin=False,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # SUBSCRIBE_REQ on stream N — a single EOS frame; must be a non-zero odd id.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SUBSCRIBE_REQ
    assert f.flags & FLAG_EOS, "SUBSCRIBE_REQ is a single EOS frame"
    assert f.stream_id != 0 and f.stream_id % 2 == 1, "subscribe stream must be odd"
    sub_stream = f.stream_id

    # Two events, pushed without EOS (the stream stays open).
    for lsn in (1, 2):
        write_frame(
            sock,
            Frame(
                opcode=int(Opcode.SUBSCRIBE_EVENT),
                flags=0,
                stream_id=sub_stream,
                payload=encode_payload(_sample_event(lsn)),
            ),
        )

    # UNSUBSCRIBE_REQ on a fresh (odd) stream M.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.UNSUBSCRIBE_REQ
    assert f.stream_id != 0 and f.stream_id % 2 == 1, "unsubscribe stream must be odd"
    unsub = decode_payload(UnsubscribeRequest, f.payload)
    assert unsub.target_stream_id == sub_stream

    # UNSUBSCRIBE_RESP (EOS) on stream M.
    _write(
        sock,
        Opcode.UNSUBSCRIBE_RESP,
        f.stream_id,
        encode_payload(UnsubscribeResponse(target_stream_id=sub_stream, final_lsn=2)),
    )

    # Final EOS SUBSCRIBE_EVENT on stream N: an empty-payload terminator that
    # closes the subscription stream. The client observes this as end-of-stream.
    write_frame(
        sock,
        Frame(
            opcode=int(Opcode.SUBSCRIBE_EVENT), flags=FLAG_EOS, stream_id=sub_stream, payload=b""
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def test_subscription_drains_events_unsubscribes_and_leaks_no_route() -> None:
    host, port, server_thread, listener = _spawn(_serve_subscription)
    try:
        hello = HelloPayload(
            client_id="sub-test",
            supported_versions=[1],
            capabilities=HelloCapabilities(
                streaming=True, compression_zstd=False, server_push=True
            ),
            client_connection_token=None,
        )
        auth = AuthPayload(
            method=AuthMethod.TOKEN, credentials=AuthCredentials.token(b"opaque-token")
        )
        conn, outcome = MuxConnection.connect(host, port, hello, auth)
        assert outcome.welcome.chosen_version == 1

        sub = conn.subscribe(
            SubscribeRequest(
                filter=SubscriptionFilter(
                    session_filter=None, kinds=None, similar_to=None, spaces=None
                ),
                include_history=False,
                from_lsn=None,
                max_inflight=8,
            )
        )

        # The subscription occupies exactly one route while live.
        assert conn.route_count() == 1

        # Drain exactly the two pushed events (no deadlock: the subscription
        # path does not collect to EOS the way request() does).
        e1 = sub.next()
        assert e1 is not None and e1.lsn == 1
        e2 = sub.next()
        assert e2 is not None and e2.lsn == 2

        # Clean teardown: UNSUBSCRIBE on a fresh stream; server EOS-closes the
        # subscription stream in response.
        resp = sub.unsubscribe()
        assert resp.final_lsn == 2

        # The terminating EOS event ends the stream.
        assert sub.next() is None

        # No leaked route: the subscription stream's route was removed on EOS,
        # and the unsubscribe stream's route on its own EOS response.
        sub.close()
        assert conn.route_count() == 0

        conn.send_bye()
        conn.close()
        server_thread.join(timeout=5)
        assert not server_thread.is_alive()
    finally:
        listener.close()


# ===========================================================================
# Keepalive: the server's idle-timer SERVER_PING must be answered by the
# reader thread with a CLIENT_PONG on stream 0 (echoing the server timestamp),
# or the real server would reap the connection. The client issues no op here —
# the auto-reply must come purely from the reader thread.
# ===========================================================================


def _serve_keepalive(sock: socket.socket) -> None:
    buf = bytearray()

    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
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
            can_admin=False,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # Idle-timer heartbeat.
    _write(
        sock,
        Opcode.SERVER_PING,
        0,
        encode_payload(ServerPingResponse(server_timestamp_unix_nanos=0xDEAD_BEEF)),
    )

    # The reader thread must answer with CLIENT_PONG on stream 0, echoing the
    # server timestamp. This is the only frame the client sends.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.CLIENT_PONG, "SERVER_PING must be answered with CLIENT_PONG"
    assert f.stream_id == 0, "CLIENT_PONG rides the connection stream 0"
    pong = decode_payload(ClientPongRequest, f.payload)
    assert pong.server_timestamp_unix_nanos == 0xDEAD_BEEF, "CLIENT_PONG echoes server ts"


def test_server_ping_is_answered_with_client_pong() -> None:
    host, port, server_thread, listener = _spawn(_serve_keepalive)
    try:
        hello = HelloPayload(
            client_id="keepalive-test",
            supported_versions=[1],
            capabilities=HelloCapabilities(
                streaming=True, compression_zstd=False, server_push=False
            ),
            client_connection_token=None,
        )
        auth = AuthPayload(
            method=AuthMethod.TOKEN, credentials=AuthCredentials.token(b"opaque-token")
        )
        # Hold `conn` (and its reader thread) alive while the server sends
        # SERVER_PING and reads back the auto-replied CLIENT_PONG.
        conn, _outcome = MuxConnection.connect(host, port, hello, auth)
        server_thread.join(timeout=5)
        assert not server_thread.is_alive(), "server did not observe a CLIENT_PONG"
        conn.close()
    finally:
        listener.close()
