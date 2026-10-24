"""Multiplexed asyncio connection: many requests in flight at once over one
socket.

The asyncio twin of :mod:`brain_db_sdk.mux`. An :class:`AsyncMuxConnection`
runs a background **reader task** that demultiplexes every inbound frame to the
waiting request by its ``stream_id``, so callers issue requests concurrently
from many tasks over one shared connection. Each request registers a queue
under a fresh ``stream_id``, writes its frame (writes are serialized by a lock
so frames never interleave), and drains frames from its queue until the EOS
frame — so streaming verbs (RECALL / QUERY) and single-shot verbs share one
path. When the reader task dies (a transport drop or a fatal frame-codec error)
it fails every outstanding request.

``stream_id`` 0 is the handshake stream; the handshake registers a queue on it
and completes before request streams (numbered from 1) are issued.

Three things differ from the threaded version, and all three are consequences
of the loop rather than choices:

* **No route-table lock.** The threaded mux guards ``_routes`` with a
  :class:`threading.Lock` because its reader runs on another thread. Here every
  mutation happens on one loop and none of them awaits part-way through, so the
  dict is already consistent at every suspension point. A lock would add
  contention and deadlock risk for an invariant the loop supplies.
* **The write lock stays.** ``write`` + ``await drain`` *does* suspend in the
  middle, so two tasks writing at once would splice their frames together.
* **Loop affinity is checked.** A connection owns an event loop from the moment
  it is opened; using it from another one silently never completes, so
  :meth:`request` refuses up front with an explanation instead of hanging.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
import time
from typing import TypeVar, Union

from brain_db_sdk.errors import (
    BrainTimeout,
    ConnectionClosed,
    ProtocolError,
    ServerError,
    VersionMismatch,
)
from brain_db_sdk.mux import HANDSHAKE_STREAM_ID, HandshakeOutcome
from brain_db_sdk.wire.frame import FLAG_EOS, MAX_PAYLOAD_BYTES, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthOkPayload,
    AuthPayload,
    ByeRequest,
    ClientPongRequest,
    ErrorResponse,
    HelloPayload,
    ServerPingResponse,
    SubscribeRequest,
    SubscriptionEvent,
    UnsubscribeRequest,
    UnsubscribeResponse,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

from .transport import read_frame, write_frame


# Sentinel a per-stream queue receives when the connection fails, so a waiting
# request wakes and re-raises rather than hanging.
class _Closed:
    def __init__(self, error: Exception) -> None:
        self.error = error


# What a per-stream route queue carries: response frames, or the `_Closed`
# sentinel once the reader task has failed the connection. Naming the union is
# what lets a type checker see through `_register` / `_next` instead of treating
# every frame they hand back as unknown.
_RouteQueue = asyncio.Queue[Union[Frame, "_Closed"]]


class AsyncMuxConnection:
    """A connection that serves many concurrent requests over one socket."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        request_timeout: float | None = None,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._request_timeout = request_timeout
        # The loop this connection was opened on. Every later operation must run
        # on it: the reader task, the queues and the stream pair are all bound
        # to it, and driving them from a second loop does not fail — it waits
        # forever on a future nothing will ever complete. See `_check_loop`.
        self._loop = asyncio.get_running_loop()
        # The server's WELCOME `max_payload_size`, enforced before every write.
        # A *policy* limit, not the frame format's structural 24-bit ceiling: a
        # server may advertise less than 16 MiB. Set at the end of `handshake`;
        # until then only handshake frames are written and those are small.
        self._max_payload_size = MAX_PAYLOAD_BYTES
        self._routes: dict[int, _RouteQueue] = {}
        self._write_lock = asyncio.Lock()
        self._next_stream_id = 1
        self._closed_error: Exception | None = None
        self._reader_task: asyncio.Task[None] = asyncio.create_task(
            self._reader_loop(), name="brain-mux-reader"
        )

    @classmethod
    async def connect(
        cls,
        host: str,
        port: int,
        hello: HelloPayload,
        auth: AuthPayload,
        connect_timeout: float | None = 10.0,
        request_timeout: float | None = 30.0,
    ) -> tuple[AsyncMuxConnection, HandshakeOutcome]:
        """Connect to ``host:port``, run the handshake, and return the live
        connection plus the negotiated outcome.

        A failure anywhere after the socket opens — a timeout, a rejected
        credential, a version mismatch, cancellation — closes that socket before
        propagating, so a caller that retries in a loop does not accumulate
        half-open connections and reader tasks.
        """
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=connect_timeout
        )
        sock = writer.get_extra_info("socket")
        if sock is not None:
            # Request/response over a multiplexed socket: Nagle would hold a
            # small frame back waiting for company that is not coming.
            # Best-effort — a transport without a real socket just skips it.
            with contextlib.suppress(OSError):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn = cls(reader, writer, request_timeout=request_timeout)
        try:
            outcome = await conn.handshake(hello, auth)
        except BaseException:
            await conn.aclose()
            raise
        return conn, outcome

    async def handshake(self, hello: HelloPayload, auth: AuthPayload) -> HandshakeOutcome:
        """Run the client side of the handshake on stream 0."""
        offered = list(hello.supported_versions)
        q = self._register(HANDSHAKE_STREAM_ID)
        try:
            await self._write(Opcode.HELLO, HANDSHAKE_STREAM_ID, encode_payload(hello))
            welcome_frame = await self._expect(q, Opcode.WELCOME)
            welcome = decode_payload(WelcomePayload, welcome_frame.payload)
            if welcome.chosen_version not in offered:
                raise VersionMismatch(welcome.chosen_version, offered)

            await self._write(Opcode.AUTH, HANDSHAKE_STREAM_ID, encode_payload(auth))
            auth_ok_frame = await self._expect(q, Opcode.AUTH_OK)
            auth_ok = decode_payload(AuthOkPayload, auth_ok_frame.payload)
            # A server that leaves this field at its default advertises 0. Zero
            # is not a meaningful payload cap -- read literally it refuses every
            # request -- so it means "unset", and the structural 24-bit ceiling
            # stands in.
            self._max_payload_size = welcome.server_features.max_payload_size or MAX_PAYLOAD_BYTES
            return HandshakeOutcome(welcome=welcome, auth_ok=auth_ok)
        finally:
            self._deregister(HANDSHAKE_STREAM_ID)

    async def request(self, opcode: Opcode, payload: bytes) -> list[Frame]:
        """Send one request and collect its response frames up to and including
        the EOS frame. Safe to call from many tasks; responses route back by
        ``stream_id``.

        Cancelling the awaiting task (``asyncio.timeout``, ``task.cancel()``)
        deregisters the route on the way out, so a late response for an
        abandoned request is dropped by the reader rather than accumulating.
        """
        self._check_loop()
        stream_id = self._take_stream_id()
        q = self._register(stream_id)
        try:
            await self._write(opcode, stream_id, payload)
            frames: list[Frame] = []
            while True:
                frame = await self._next(q)
                if frame.opcode == Opcode.ERROR:
                    raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
                frames.append(frame)
                if frame.flags & FLAG_EOS:
                    return frames
        finally:
            self._deregister(stream_id)

    async def request_on_connection(self, opcode: Opcode, payload: bytes) -> list[Frame]:
        """Send a CONNECTION-LEVEL request and collect its response frames.

        PING/PONG, like HELLO and BYE, are connection-level opcodes: the server
        refuses them on any stream but 0 with ``connection-level opcode
        requires stream_id = 0``. They therefore cannot go through
        :meth:`request`, which allocates an odd op-stream id — a ``ping()``
        built on that path never completed a round trip.

        Stream 0 is also the handshake stream, but it is free by the time any
        request runs: HELLO/AUTH complete before this is reachable, and the
        server's own SERVER_PING keepalive is intercepted by the reader before
        routing, so it never lands in the table.
        """
        self._check_loop()
        stream_id = HANDSHAKE_STREAM_ID
        q = self._register(stream_id)
        try:
            await self._write(opcode, stream_id, payload)
            frames: list[Frame] = []
            while True:
                frame = await self._next(q)
                if frame.opcode == Opcode.ERROR:
                    raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
                frames.append(frame)
                if frame.flags & FLAG_EOS:
                    return frames
        finally:
            self._deregister(stream_id)

    async def request_one(self, opcode: Opcode, payload: bytes) -> Frame:
        """Send one request and require exactly one EOS response frame."""
        frames = await self.request(opcode, payload)
        if len(frames) != 1:
            raise ProtocolError(f"expected a single response frame, got {len(frames)}")
        return frames[0]

    async def subscribe(self, request: SubscribeRequest) -> AsyncSubscription:
        """Open a long-lived subscription. Allocates a stream id, registers its
        route, sends the SUBSCRIBE frame as one EOS frame, and returns an
        :class:`AsyncSubscription` the caller drains with ``next()``. Unlike
        :meth:`request`, this does NOT collect to EOS — the server pushes events
        until the client unsubscribes."""
        self._check_loop()
        stream_id = self._take_stream_id()
        q = self._register(stream_id)
        try:
            await self._write(Opcode.SUBSCRIBE_REQ, stream_id, encode_payload(request))
        except BaseException:
            self._deregister(stream_id)
            raise
        return AsyncSubscription(self, stream_id, q)

    def route_count(self) -> int:
        """Number of live routes in the table. Test/diagnostics hook: a clean
        subscription teardown must leave no leaked route behind."""
        return len(self._routes)

    def is_closed(self) -> bool:
        """Whether the reader has stopped or the peer has failed."""
        return self._closed_error is not None or self._reader_task.done()

    async def send_bye(self) -> None:
        """Send BYE to end the session cleanly."""
        # A CBOR map, not an empty payload: the server decodes this as a
        # ByeRequest, and zero bytes is not valid CBOR.
        await self._write(Opcode.BYE, HANDSHAKE_STREAM_ID, encode_payload(ByeRequest()))

    async def aclose(self) -> None:
        """Close the stream, stop the reader task, and fail any waiters.

        Idempotent, and safe to call from a cancelled scope: everything after
        the first step is best-effort, because the socket is being discarded
        either way.
        """
        self._fail_all(ConnectionClosed("connection closed by client"))
        self._reader_task.cancel()
        # The reader is cancelled, not awaited to completion, so a task blocked
        # in `read` does not hold up the close. Awaiting it here is what makes
        # `aclose` leave no pending task behind for the loop to warn about.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self._reader_task
        self._writer.close()
        # `wait_closed` can raise whatever the connection died of; the socket is
        # gone either way and a teardown error is not separately actionable.
        with contextlib.suppress(Exception):
            await self._writer.wait_closed()

    # ---- internals ----

    def _check_loop(self) -> None:
        """Refuse an operation issued from a loop other than the one that owns
        this connection.

        Without this the call simply never completes: the reader task and the
        queues live on the original loop, so the future this coroutine awaits is
        never scheduled anywhere the caller is watching. A client stashed in a
        module global and reused across ``asyncio.run()`` calls, or driven from
        a thread running its own loop, hits exactly this — and a hang with no
        error is the hardest possible version of it to diagnose.
        """
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            # Not inside a loop at all; the `await` would fail on its own, but
            # saying so here names the actual mistake.
            raise ProtocolError(
                "this connection must be used from the event loop it was opened on, "
                "but no loop is running"
            ) from None
        if running is not self._loop:
            raise ProtocolError(
                "this connection was opened on a different event loop and cannot be "
                "used from this one. Open one connection per loop — a client cached "
                "across asyncio.run() calls, or shared with a thread running its own "
                "loop, hits this."
            )

    async def _reader_loop(self) -> None:
        buf = bytearray()
        while True:
            try:
                frame = await read_frame(self._reader, buf)
            except asyncio.CancelledError:
                # `aclose` has already failed every route with a close reason
                # that says so; re-raise so the task ends cancelled rather than
                # looking like it returned normally.
                raise
            except Exception as exc:  # noqa: BLE001 — transport/codec failure ends the loop
                self._fail_all(exc)
                return
            if frame.opcode == int(Opcode.SERVER_PING):
                await self._pong(frame)
                continue
            q = self._routes.get(frame.stream_id)
            # An unknown stream_id is a late frame for a cancelled/timed-out
            # request; drop it.
            if q is not None:
                q.put_nowait(frame)

    async def _pong(self, frame: Frame) -> None:
        """Answer the server's idle-timer heartbeat.

        SERVER_PING exists so the server can tell a live-but-idle connection
        from a dead one; replying with CLIENT_PONG on stream 0 resets its timer.
        The reply echoes the server timestamp (0 if the payload cannot be
        decoded — the server only needs a frame, not the contents).
        """
        try:
            server_ts = decode_payload(
                ServerPingResponse, frame.payload
            ).server_timestamp_unix_nanos
        except Exception:  # noqa: BLE001 — tolerate a malformed heartbeat
            server_ts = 0
        pong = ClientPongRequest(
            server_timestamp_unix_nanos=server_ts,
            client_timestamp_unix_nanos=time.time_ns(),
        )
        # A closed socket ends the loop on the next read; a failed heartbeat is
        # not separately actionable.
        with contextlib.suppress(Exception):
            await self._write(Opcode.CLIENT_PONG, HANDSHAKE_STREAM_ID, encode_payload(pong))

    def _register(self, stream_id: int) -> _RouteQueue:
        if self._closed_error is not None:
            raise self._closed_error
        q: _RouteQueue = asyncio.Queue()
        self._routes[stream_id] = q
        return q

    def _deregister(self, stream_id: int) -> None:
        self._routes.pop(stream_id, None)

    def _fail_all(self, exc: Exception) -> None:
        error = exc if isinstance(exc, (ConnectionClosed, OSError)) else ConnectionClosed(str(exc))
        if self._closed_error is None:
            self._closed_error = error
        for q in self._routes.values():
            q.put_nowait(_Closed(error))
        self._routes.clear()

    async def _next(self, q: _RouteQueue) -> Frame:
        try:
            # `asyncio.TimeoutError`, not the builtin: they are only the same
            # exception from 3.11 on, and this package supports 3.10.
            item = await asyncio.wait_for(q.get(), timeout=self._request_timeout)
        except asyncio.TimeoutError:
            # `from None`: the expired wait is how a timeout is detected, not a
            # cause worth showing a caller.
            raise BrainTimeout(self._request_timeout) from None
        if isinstance(item, _Closed):
            raise item.error
        return item

    async def _expect(self, q: _RouteQueue, expected: Opcode) -> Frame:
        frame = await self._next(q)
        if frame.opcode == Opcode.ERROR:
            raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
        if frame.opcode != int(expected):
            raise ProtocolError(
                f"expected {expected.name} ({int(expected):#06x}), got {frame.opcode:#06x}"
            )
        return frame

    async def _write(self, opcode: Opcode, stream_id: int, payload: bytes) -> None:
        if len(payload) > self._max_payload_size:
            raise ProtocolError(
                f"payload is {len(payload)} bytes, over the "
                f"{self._max_payload_size} the server advertised at WELCOME"
            )
        frame = Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload)
        async with self._write_lock:
            await write_frame(self._writer, frame)

    def _take_stream_id(self) -> int:
        # Client-initiated op streams MUST be non-zero and ODD (stream 0 is the
        # connection/handshake stream; the server rejects even/zero client
        # streams as BadFrame). Start at 1 and step by 2 so every request on a
        # reused connection stays odd, wrapping back to 1.
        #
        # No lock: this runs to completion without awaiting, so the loop cannot
        # interleave a second caller part-way through.
        stream_id = self._next_stream_id
        self._next_stream_id = (
            self._next_stream_id + 2 if self._next_stream_id + 2 <= 0xFFFF_FFFF else 1
        )
        return stream_id


# Stands in for `typing.Self`, which is 3.11+; requires-python here is >=3.10.
_SelfSub = TypeVar("_SelfSub", bound="AsyncSubscription")


class AsyncSubscription:
    """A live server-push subscription stream. Drain events with :meth:`next`
    (or by ``async for``); call :meth:`unsubscribe` for a clean teardown — the
    server then EOS-closes the event stream, which :meth:`next` observes as
    end-of-stream.

    Dropping a subscription without unsubscribing leaks no route once it is
    closed: :meth:`aclose` (and the async-context-manager exit) deregisters the
    route. Prefer :meth:`unsubscribe` before closing so the server stops
    pushing.
    """

    def __init__(self, conn: AsyncMuxConnection, stream_id: int, q: _RouteQueue) -> None:
        self._conn = conn
        self._stream_id = stream_id
        self._q = q
        # Set once an EOS frame has been observed: the next next() returns None
        # without touching the (already-removed) route.
        self._ended = False

    @property
    def stream_id(self) -> int:
        """The stream id the server pushes events on."""
        return self._stream_id

    async def next(self) -> SubscriptionEvent | None:
        """Return the next subscription event, or ``None`` once the stream has
        ended (the server EOS-closed it, or the connection dropped).

        An EOS-flagged frame carrying an event yields that event; the following
        call returns ``None``. An EOS frame with an empty payload ends the
        stream immediately.
        """
        if self._ended:
            return None
        try:
            frame = await self._conn._next(self._q)  # noqa: SLF001 — same module
        except ConnectionClosed:
            self._end()
            return None
        if frame.opcode == Opcode.ERROR:
            self._end()
            raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
        if frame.flags & FLAG_EOS:
            # Last frame on the stream; mark ended and drop the route.
            self._end()
            if not frame.payload:
                return None
        return decode_payload(SubscriptionEvent, frame.payload)

    def __aiter__(self) -> AsyncSubscription:
        return self

    async def __anext__(self) -> SubscriptionEvent:
        event = await self.next()
        if event is None:
            raise StopAsyncIteration
        return event

    async def unsubscribe(self) -> UnsubscribeResponse:
        """Tear the subscription down cleanly: send UNSUBSCRIBE on a fresh
        stream and await its UNSUBSCRIBE_RESP. The server then EOS-closes the
        event stream, which a subsequent :meth:`next` observes as ``None``."""
        req = UnsubscribeRequest(target_stream_id=self._stream_id)
        frame = await self._conn.request_one(Opcode.UNSUBSCRIBE_REQ, encode_payload(req))
        if frame.opcode != int(Opcode.UNSUBSCRIBE_RESP):
            raise ProtocolError(
                f"expected UNSUBSCRIBE_RESP ({int(Opcode.UNSUBSCRIBE_RESP):#06x}), got "
                f"{frame.opcode:#06x}"
            )
        return decode_payload(UnsubscribeResponse, frame.payload)

    async def aclose(self) -> None:
        """Deregister the subscription's route so a forgotten handle doesn't
        leak a route-table entry. Does not send UNSUBSCRIBE — call
        :meth:`unsubscribe` first for a clean shutdown."""
        self._end()

    def _end(self) -> None:
        self._ended = True
        self._conn._deregister(self._stream_id)  # noqa: SLF001 — same module

    async def __aenter__(self: _SelfSub) -> _SelfSub:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


__all__ = [
    "HANDSHAKE_STREAM_ID",
    "AsyncMuxConnection",
    "AsyncSubscription",
    "HandshakeOutcome",
]
