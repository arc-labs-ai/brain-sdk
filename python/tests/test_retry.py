"""Retry helper tests: backoff schedule (unit) and an integration round-trip
where a server returns a retryable ``ResourceExhausted`` ERROR once, then
succeeds — recovered transparently by ``with_retry`` wrapping a verb call, with
the *same* ``request_id`` resent both times (idempotent retry).
"""

from __future__ import annotations

import socket
import threading

import pytest

from brain_db_sdk import Auth, BrainClient, ForgetBuilder, RetryPolicy, ServerError, with_retry
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    SpacePermissions,
    AuthOkPayload,
    AuthPayload,
    ErrorCategory,
    ErrorResponse,
    ForgetRequest,
    ForgetResponse,
    HelloPayload,
    ServerFeatures,
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload))


# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _handshake(sock: socket.socket, buf: bytearray) -> AuthPayload:
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        connection_id=b"\xEE" * 16,
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
    auth = decode_payload(AuthPayload, auth_frame.payload)
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
    return auth


def _serve_forget_then_recover(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    # First FORGET -> retryable ERROR with a short server retry_after.
    first = read_frame(sock, buf)
    assert first.opcode == Opcode.FORGET_REQ
    first_req = decode_payload(ForgetRequest, first.payload)
    err = ErrorResponse(
        code=0x0073,  # RateLimited
        category=ErrorCategory.RESOURCE_EXHAUSTED,
        message="slow down",
        details=None,
        retry_after_ms=5,
    )
    _write(sock, Opcode.ERROR, first.stream_id, encode_payload(err))

    # Second FORGET (the retry) -> success. Same request_id proves idempotency.
    second = read_frame(sock, buf)
    assert second.opcode == Opcode.FORGET_REQ
    second_req = decode_payload(ForgetRequest, second.payload)
    assert first_req.request_id == second_req.request_id

    resp = ForgetResponse(memory_id=second_req.memory_id, was_already_forgotten=False, edges_removed=1)
    _write(sock, Opcode.FORGET_RESP, second.stream_id, encode_payload(resp))

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def _serve_forget_always_busy(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)
    while True:
        try:
            frame = read_frame(sock, buf)
        except Exception:  # noqa: BLE001 — client closed
            return
        if frame.opcode == Opcode.BYE:
            return
        err = ErrorResponse(
            code=0x0091,  # Overloaded
            category=ErrorCategory.UNAVAILABLE,
            message="busy",
            details=None,
            retry_after_ms=None,
        )
        _write(sock, Opcode.ERROR, frame.stream_id, encode_payload(err))


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


def test_backoff_doubles_and_caps() -> None:
    p = RetryPolicy(max_attempts=5, base_delay=0.1, max_delay=1.0)
    assert p.backoff(1, None) == pytest.approx(0.1)
    assert p.backoff(2, None) == pytest.approx(0.2)
    assert p.backoff(3, None) == pytest.approx(0.4)
    assert p.backoff(4, None) == pytest.approx(0.8)
    assert p.backoff(5, None) == pytest.approx(1.0)  # 1.6 capped


def test_server_retry_after_overrides_and_caps() -> None:
    p = RetryPolicy(max_attempts=3, base_delay=0.1, max_delay=2.0)
    assert p.backoff(1, 0.5) == pytest.approx(0.5)
    assert p.backoff(1, 99.0) == pytest.approx(2.0)


def test_none_policy_is_single_attempt() -> None:
    p = RetryPolicy.none()
    assert p.max_attempts == 1
    assert p.backoff(1, None) is None


def test_with_retry_recovers_a_resource_exhausted_forget() -> None:
    host, port, thread, listener = _spawn(_serve_forget_then_recover)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))
        req = ForgetBuilder(0xBEEF).build()
        policy = RetryPolicy(max_attempts=3, base_delay=0.0, max_delay=0.0)
        resp = with_retry(lambda: client.forget(req), policy)
        assert resp.memory_id == 0xBEEF
        assert resp.edges_removed == 1
        client.close()
        thread.join(timeout=5)
    finally:
        listener.close()


def test_with_retry_gives_up_and_surfaces_server_error() -> None:
    host, port, thread, listener = _spawn(_serve_forget_always_busy)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))
        req = ForgetBuilder(1).build()
        policy = RetryPolicy(max_attempts=2, base_delay=0.0, max_delay=0.0)
        with pytest.raises(ServerError) as excinfo:
            with_retry(lambda: client.forget(req), policy)
        assert excinfo.value.category == ErrorCategory.UNAVAILABLE
        client.close()
    finally:
        listener.close()
        thread.join(timeout=5)
