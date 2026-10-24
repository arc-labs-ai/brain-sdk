"""The multiplexed asyncio connection.

Handshake, demultiplexing, deadlines, cancellation, and the ways a connection
dies. These are the claims that distinguish this tier from "a socket with
awaits on it": that two requests in flight at once come back to the right
caller even when the server answers in the wrong order, that an abandoned
request leaves nothing behind, and that a connection used from the wrong event
loop says so instead of hanging.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from aio_harness import (
    MEMORY_NOT_FOUND_CODE,
    MOCK_CONNECTION_ID,
    MOCK_MAX_PAYLOAD,
    MOCK_SPACE_ID,
    MockBrain,
    MockSession,
    mock_encode_response,
)

from brain_db_sdk import EncodeBuilder, RecallBuilder
from brain_db_sdk.aio import AsyncBrainClient
from brain_db_sdk.aio.mux import AsyncMuxConnection
from brain_db_sdk.client import DEFAULT_CLIENT_ID, Auth, ClientConfig
from brain_db_sdk.errors import (
    ActAsDenied,
    BrainTimeout,
    ConnectionClosed,
    ProtocolError,
    ServerError,
    VersionMismatch,
)
from brain_db_sdk.wire.frame import FLAG_EOS
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthCredentials,
    AuthMethod,
    AuthPayload,
    EncodeRequest,
    ErrorCategory,
    ErrorCode,
    HelloCapabilities,
    HelloPayload,
    decode_payload,
    encode_payload,
)

HELLO = HelloPayload(
    client_id=DEFAULT_CLIENT_ID,
    supported_versions=[1],
    capabilities=HelloCapabilities(streaming=True, compression_zstd=False, server_push=False),
    client_connection_token=None,
)
AUTH = AuthPayload(method=AuthMethod.TOKEN, credentials=AuthCredentials.token(b"brain_test"))


def _request(session_id: int = 0) -> bytes:
    return encode_payload(
        EncodeRequest(
            text=f"memory {session_id}",
            session_id=session_id,
            request_id=bytes([session_id % 256]) * 16,
            txn_id=None,
            occurred_at_unix_nanos=None,
        )
    )


async def _connect(server: MockBrain, **kw: object) -> AsyncMuxConnection:
    conn, _ = await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH, **kw)  # type: ignore[arg-type]
    return conn


# --------------------------------------------------------------------------
# Handshake
# --------------------------------------------------------------------------


async def test_the_handshake_returns_what_the_server_granted() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake(namespace="acme")
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn, outcome = await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH)
        try:
            assert outcome.welcome.server_id == "mock-brain"
            assert outcome.welcome.connection_id == MOCK_CONNECTION_ID
            assert outcome.auth_ok.space_id == MOCK_SPACE_ID
            assert outcome.auth_ok.namespace == "acme"
            assert server.sessions[0].hello is not None
            assert server.sessions[0].hello.client_id == DEFAULT_CLIENT_ID
        finally:
            await conn.aclose()


async def test_a_version_the_client_never_offered_is_refused() -> None:
    """Negotiation is not advisory: a server picking something outside the
    offered set would leave both sides decoding to different rules."""

    async def handler(session: MockSession) -> None:
        await session.handshake(chosen_version=99)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        with pytest.raises(VersionMismatch) as caught:
            await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH)
        assert caught.value.chosen == 99
        assert caught.value.supported == [1]


async def test_an_unexpected_opcode_during_the_handshake_is_a_protocol_error() -> None:
    async def handler(session: MockSession) -> None:
        await session.read()  # HELLO
        await session.write(Opcode.PONG, 0, b"\xa0")  # not WELCOME
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        with pytest.raises(ProtocolError, match="expected WELCOME"):
            await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH)


async def test_a_rejected_credential_surfaces_as_a_server_error() -> None:
    async def handler(session: MockSession) -> None:
        await session.read()  # HELLO — refused before WELCOME even goes out
        await session.error(
            0,
            code=ErrorCode.PERMISSION_DENIED,
            category=ErrorCategory.AUTHENTICATION,
            message="bad key",
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        with pytest.raises(ServerError) as caught:
            await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH)
        assert caught.value.category == ErrorCategory.AUTHENTICATION
        assert "bad key" in caught.value.message


async def test_a_failed_handshake_leaves_no_socket_or_task_behind() -> None:
    """A caller retrying in a loop must not accumulate half-open connections.

    The task count is the observable: each live connection holds one reader
    task, so a leak shows up as a task that outlives the failed connect.
    """
    before = len(asyncio.all_tasks())

    async def handler(session: MockSession) -> None:
        await session.handshake(chosen_version=99)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        for _ in range(5):
            with pytest.raises(VersionMismatch):
                await AsyncMuxConnection.connect(server.host, server.port, HELLO, AUTH)
        # Let any cancelled reader task actually finish unwinding.
        await asyncio.sleep(0.05)
        assert len(asyncio.all_tasks()) - before <= 1, (
            "a failed handshake left reader tasks running; five failed connects should leave none"
        )


async def test_a_connect_timeout_is_a_timeout_not_a_hang() -> None:
    """Dialling an address nothing answers must give up on schedule."""
    # 198.51.100.0/24 is TEST-NET-2 (RFC 5737): reserved for documentation and
    # guaranteed not to be routed, so the connect stalls rather than failing
    # fast the way a closed local port would.
    with pytest.raises((asyncio.TimeoutError, OSError)):
        await AsyncMuxConnection.connect("198.51.100.1", 18080, HELLO, AUTH, connect_timeout=0.25)


# --------------------------------------------------------------------------
# Demultiplexing
# --------------------------------------------------------------------------


async def test_concurrent_requests_answered_in_reverse_order_route_correctly() -> None:
    """The central claim of the tier: responses find their caller by
    ``stream_id``, not by arrival order."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        first = await session.read()
        second = await session.read()
        # Answer the *second* request first; each payload carries a memory_id
        # matching the stream it belongs to, so a mis-route is visible.
        await session.write(
            Opcode.ENCODE_RESP, second.stream_id, mock_encode_response(second.stream_id)
        )
        await session.write(
            Opcode.ENCODE_RESP, first.stream_id, mock_encode_response(first.stream_id)
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            a, b = await asyncio.gather(
                conn.request_one(Opcode.ENCODE_REQ, _request(1)),
                conn.request_one(Opcode.ENCODE_REQ, _request(2)),
            )
            assert a.stream_id != b.stream_id
            for frame in (a, b):
                from brain_db_sdk.wire.types import EncodeResponse

                assert decode_payload(EncodeResponse, frame.payload).memory_id == frame.stream_id
        finally:
            await conn.aclose()


async def test_many_requests_in_flight_at_once_all_come_back() -> None:
    """Fifty concurrent requests over one socket, answered in a shuffled
    order — one task, one connection, no pool."""
    count = 50

    async def handler(session: MockSession) -> None:
        await session.handshake()
        pending = [await session.read() for _ in range(count)]
        for frame in reversed(pending):
            await session.write(
                Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(frame.stream_id)
            )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            frames = await asyncio.gather(
                *(conn.request_one(Opcode.ENCODE_REQ, _request(i)) for i in range(count))
            )
            assert len({f.stream_id for f in frames}) == count
            assert conn.route_count() == 0, "every route should be deregistered"
        finally:
            await conn.aclose()


async def test_client_stream_ids_are_non_zero_and_odd() -> None:
    """Stream 0 is the connection stream and even ids are the server's; a
    client that numbered otherwise would have its frames rejected as BadFrame."""
    seen: list[int] = []

    async def handler(session: MockSession) -> None:
        await session.handshake()
        for _ in range(4):
            frame = await session.read()
            seen.append(frame.stream_id)
            await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            for _ in range(4):
                await conn.request_one(Opcode.ENCODE_REQ, _request())
            assert seen == [1, 3, 5, 7]
        finally:
            await conn.aclose()


async def test_a_streamed_response_collects_every_frame_up_to_eos() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        for i in range(3):
            await session.write(
                Opcode.RECALL_RESP,
                frame.stream_id,
                mock_encode_response(i),
                flags=FLAG_EOS if i == 2 else 0,
            )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            frames = await conn.request(Opcode.RECALL_REQ, _request())
            assert len(frames) == 3
            assert frames[-1].flags & FLAG_EOS
            assert not frames[0].flags & FLAG_EOS
        finally:
            await conn.aclose()


async def test_request_one_refuses_a_multi_frame_answer() -> None:
    """A unary verb that streams is a server bug; reporting the first frame as
    "the" answer would hide it."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(), flags=0)
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            with pytest.raises(ProtocolError, match="single response frame"):
                await conn.request_one(Opcode.ENCODE_REQ, _request())
        finally:
            await conn.aclose()


async def test_the_server_heartbeat_is_answered_without_a_caller() -> None:
    """SERVER_PING is how the server tells a live-but-idle connection from a
    dead one. The reader answers it; nothing is waiting on that stream."""
    pong = asyncio.get_running_loop().create_future()

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.write(Opcode.SERVER_PING, 0, encode_payload_server_ping())
        frame = await session.read()
        if not pong.done():
            pong.set_result(frame)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            frame = await asyncio.wait_for(pong, timeout=3)
            assert frame.opcode == int(Opcode.CLIENT_PONG)
            assert frame.stream_id == 0
        finally:
            await conn.aclose()


def encode_payload_server_ping() -> bytes:
    from brain_db_sdk.wire.types import ServerPingResponse

    return encode_payload(ServerPingResponse(server_timestamp_unix_nanos=42))


async def test_a_malformed_heartbeat_is_still_answered() -> None:
    """The server only needs a frame back to reset its idle timer, so a
    heartbeat the client cannot decode must not take the connection down."""
    pong = asyncio.get_running_loop().create_future()

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.write(Opcode.SERVER_PING, 0, b"\xff\xff\xff")  # not valid CBOR
        frame = await session.read()
        if not pong.done():
            pong.set_result(frame)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            frame = await asyncio.wait_for(pong, timeout=3)
            assert frame.opcode == int(Opcode.CLIENT_PONG)
            assert not conn.is_closed()
        finally:
            await conn.aclose()


async def test_a_frame_for_an_unknown_stream_is_dropped() -> None:
    """A late answer for a request nobody is waiting on must not crash the
    reader — it is the normal aftermath of a cancellation."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.write(Opcode.ENCODE_RESP, 9999, mock_encode_response())
        frame = await session.read()
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(7))
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            await asyncio.sleep(0.05)
            assert not conn.is_closed()
            frame = await conn.request_one(Opcode.ENCODE_REQ, _request())
            from brain_db_sdk.wire.types import EncodeResponse

            assert decode_payload(EncodeResponse, frame.payload).memory_id == 7
        finally:
            await conn.aclose()


# --------------------------------------------------------------------------
# Errors, deadlines, cancellation
# --------------------------------------------------------------------------


async def test_an_error_frame_raises_the_mapped_subclass() -> None:
    """The wire ``code`` picks the exception class, so a caller can catch
    ``ActAsDenied`` rather than string-matching a message."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.error(
            frame.stream_id,
            code=ErrorCode.ACT_AS_DENIED,
            category=ErrorCategory.AUTHORIZATION,
            message="not entitled",
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            with pytest.raises(ActAsDenied) as caught:
                await conn.request_one(Opcode.ENCODE_REQ, _request())
            assert caught.value.code == ErrorCode.ACT_AS_DENIED
            assert conn.route_count() == 0
        finally:
            await conn.aclose()


async def test_an_unmapped_error_code_is_the_base_server_error() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.error(
            frame.stream_id,
            code=MEMORY_NOT_FOUND_CODE,
            category=ErrorCategory.NOT_FOUND,
            message="no such memory",
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            with pytest.raises(ServerError) as caught:
                await conn.request_one(Opcode.MEMORY_INSPECT_REQ, _request())
            assert type(caught.value) is ServerError
            assert caught.value.category == ErrorCategory.NOT_FOUND
        finally:
            await conn.aclose()


async def test_a_request_that_is_never_answered_times_out() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.read()
        await asyncio.sleep(5)

    async with MockBrain(handler) as server:
        conn = await _connect(server, request_timeout=0.2)
        try:
            with pytest.raises(BrainTimeout) as caught:
                await conn.request_one(Opcode.ENCODE_REQ, _request())
            assert caught.value.timeout == 0.2
            assert conn.route_count() == 0, "a timed-out request must not leak its route"
        finally:
            await conn.aclose()


async def test_cancelling_a_request_deregisters_its_route() -> None:
    """``asyncio.timeout`` around a verb, or a cancelled task, must leave the
    route table empty — otherwise a long-lived connection accumulates one entry
    per abandoned request."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.read()
        await asyncio.sleep(5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            task = asyncio.create_task(conn.request_one(Opcode.ENCODE_REQ, _request()))
            await asyncio.sleep(0.05)
            assert conn.route_count() == 1
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert conn.route_count() == 0
            assert not conn.is_closed(), "cancelling one request must not kill the connection"
        finally:
            await conn.aclose()


async def test_a_dropped_connection_fails_every_request_in_flight() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        for _ in range(3):
            await session.read()
        await session.close()

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            tasks = [
                asyncio.create_task(conn.request_one(Opcode.ENCODE_REQ, _request(i)))
                for i in range(3)
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            assert all(isinstance(r, (ConnectionClosed, OSError)) for r in results), results
            assert conn.is_closed()
        finally:
            await conn.aclose()


async def test_a_request_on_a_dead_connection_fails_immediately() -> None:
    """Not a timeout: the connection already knows it is gone, so there is
    nothing to wait for."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.close()

    async with MockBrain(handler) as server:
        conn = await _connect(server, request_timeout=30.0)
        try:
            for _ in range(100):
                if conn.is_closed():
                    break
                await asyncio.sleep(0.01)
            assert conn.is_closed()
            with pytest.raises((ConnectionClosed, OSError)):
                await asyncio.wait_for(conn.request_one(Opcode.ENCODE_REQ, _request()), timeout=2)
        finally:
            await conn.aclose()


async def test_aclose_is_idempotent() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        await conn.aclose()
        await conn.aclose()
        assert conn.is_closed()


# --------------------------------------------------------------------------
# Payload bounds
# --------------------------------------------------------------------------


async def test_a_payload_over_the_advertised_cap_is_refused_locally() -> None:
    """The server advertises ``max_payload_size`` at WELCOME; sending past it
    would come back as a server error or kill the connection. Failing here
    costs no round trip and names the actual number."""

    async def handler(session: MockSession) -> None:
        await session.handshake(max_payload_size=1024)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            with pytest.raises(ProtocolError, match="over the 1024"):
                await conn.request_one(Opcode.ENCODE_REQ, b"\x41" + b"x" * 2048)
            assert not conn.is_closed(), "a refused write must not disturb the connection"
        finally:
            await conn.aclose()


async def test_a_payload_exactly_at_the_cap_is_allowed() -> None:
    """The boundary belongs on the allowed side — `>` not `>=`."""
    cap = 4096

    async def handler(session: MockSession) -> None:
        await session.handshake(max_payload_size=cap)
        frame = await session.read()
        assert len(frame.payload) == cap
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            await conn.request_one(Opcode.ENCODE_REQ, b"z" * cap)
        finally:
            await conn.aclose()


async def test_a_server_advertising_zero_means_unset_not_nothing() -> None:
    """Read literally, a zero cap refuses every request — it bricked the client
    against any server leaving the field at its default."""

    async def handler(session: MockSession) -> None:
        await session.handshake(max_payload_size=0)
        frame = await session.read()
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            await conn.request_one(Opcode.ENCODE_REQ, _request())
        finally:
            await conn.aclose()


async def test_an_empty_payload_is_sent_as_is() -> None:
    """The cap is an upper bound only; nothing rejects a zero-length body at
    the transport, and BYE relies on that path."""

    async def handler(session: MockSession) -> None:
        await session.handshake(max_payload_size=MOCK_MAX_PAYLOAD)
        frame = await session.read()
        assert frame.payload == b""
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:
            await conn.request_one(Opcode.ENCODE_REQ, b"")
        finally:
            await conn.aclose()


# --------------------------------------------------------------------------
# Event-loop affinity
# --------------------------------------------------------------------------


async def test_a_connection_refuses_a_different_event_loop() -> None:
    """The failure this prevents is a hang, not an error: the reader task and
    the queues live on the original loop, so a request issued from another one
    waits on a future nothing will ever complete.

    This is the exact shape of "just wrap the async client in asyncio.run" —
    the workaround people reach for when a sync API is wanted back.
    """

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await asyncio.sleep(1.0)

    async with MockBrain(handler) as server:
        conn = await _connect(server)
        try:

            def other_loop() -> BaseException | None:
                async def use_it() -> None:
                    await conn.request_one(Opcode.ENCODE_REQ, _request())

                try:
                    asyncio.run(use_it())
                except BaseException as exc:  # noqa: BLE001 — the test's subject
                    return exc
                return None

            caught = await asyncio.to_thread(other_loop)
            assert isinstance(caught, ProtocolError), caught
            assert "different event loop" in str(caught)
        finally:
            await conn.aclose()


# --------------------------------------------------------------------------
# Two deadlines, not one.
#
# The asyncio half of what `tests/mux/test_mux.py` pins for the threaded tier:
# a derived ENCODE waits out the asynchronous half of the write (~9s typical on
# a live server, 45.5s under a ten-way burst) while a read keeps the flat one.
# The handler here never answers, so the deadline that fires is the only thing
# under test.
# --------------------------------------------------------------------------

# Scaled down from the shipped 30s / 120s: the ratio is what matters, and a
# test that waits out the real numbers is a test nobody runs.
_FLAT = 0.15
_DERIVED = 0.8


async def _silence(session: MockSession) -> None:
    """Handshake, then never answer anything."""
    await session.handshake()
    while True:
        await session.read()


async def _connect_client_mux(server: MockBrain) -> AsyncMuxConnection:
    return await _connect(server, request_timeout=_FLAT)


async def _connect_client(server: MockBrain) -> AsyncBrainClient:
    return await AsyncBrainClient.connect_with(
        server.host,
        server.port,
        ClientConfig(
            auth=Auth.token(b"opaque-token"),
            request_timeout=_FLAT,
            derived_write_timeout=_DERIVED,
        ),
    )


async def test_a_per_request_deadline_overrides_the_connection_default() -> None:
    async with MockBrain(_silence) as server:
        conn = await _connect_client_mux(server)
        try:
            with pytest.raises(BrainTimeout) as default_timeout:
                await conn.request_one(Opcode.ENCODE_REQ, _request(1))
            assert default_timeout.value.timeout == _FLAT

            with pytest.raises(BrainTimeout) as overridden:
                await conn.request_one(Opcode.ENCODE_REQ, _request(2), _DERIVED)
            assert overridden.value.timeout == _DERIVED
        finally:
            await conn.aclose()


async def test_a_derived_encode_waits_under_the_derived_deadline() -> None:
    async with MockBrain(_silence) as server:
        client = await _connect_client(server)
        started = time.monotonic()
        with pytest.raises(BrainTimeout) as excinfo:
            await client.encode(EncodeBuilder("a derived write").derived().build())
        elapsed = time.monotonic() - started

        assert excinfo.value.timeout == _DERIVED
        # The number alone could come from anywhere; the wall clock proves the
        # request really outlived the flat deadline rather than reporting one
        # value and enforcing another.
        assert elapsed >= _FLAT * 2, f"gave up after {elapsed:.3f}s"
        await client._conn.aclose()  # the server never answers a BYE


async def test_an_ack_encode_and_a_read_keep_the_flat_deadline() -> None:
    """The point of a second number is that it is *not* applied to everything:
    raising the flat default instead would make every read hang for two
    minutes on a dead connection."""
    async with MockBrain(_silence) as server:
        client = await _connect_client(server)
        started = time.monotonic()

        with pytest.raises(BrainTimeout) as ack:
            await client.encode(EncodeBuilder("an ordinary write").build())
        assert ack.value.timeout == _FLAT

        with pytest.raises(BrainTimeout) as read:
            await client.recall(RecallBuilder("a cue").build())
        assert read.value.timeout == _FLAT

        assert time.monotonic() - started < _DERIVED
        await client._conn.aclose()  # the server never answers a BYE
