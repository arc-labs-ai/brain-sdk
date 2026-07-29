"""Multiplexed connection: many requests in flight at once over one socket.

A :class:`MuxConnection` is the SDK's one connection type. It runs a background
**reader thread** that demultiplexes every inbound frame to the waiting request
by its ``stream_id``, so callers issue requests concurrently
from many threads over one shared connection. Each request registers a
thread-safe queue under a fresh ``stream_id``, writes its frame (writes are
serialized by a lock so frames never interleave), and drains frames from its
queue until the EOS frame — so streaming verbs (RECALL / QUERY) and single-shot
verbs share one path. When the reader thread dies (a transport drop or a fatal
frame-codec error) it fails every outstanding request.

``stream_id`` 0 is the handshake stream; the handshake registers a queue on it
and completes before request streams (numbered from 1) are issued.
"""

from __future__ import annotations

import contextlib
import queue
import socket
import threading
import time
from dataclasses import dataclass
from typing import TypeVar

from .errors import BrainTimeout, ConnectionClosed, ProtocolError, ServerError, VersionMismatch
from .transport import read_frame, write_frame
from .wire.frame import FLAG_EOS, Frame
from .wire.opcode import Opcode
from .wire.types import (
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

HANDSHAKE_STREAM_ID = 0


@dataclass(frozen=True)
class HandshakeOutcome:
    """What the server told us during the handshake."""

    welcome: WelcomePayload
    auth_ok: AuthOkPayload


# Sentinel a per-stream queue receives when the connection fails, so a blocked
# request wakes and re-raises rather than hanging.
class _Closed:
    def __init__(self, error: Exception) -> None:
        self.error = error


class MuxConnection:
    """A connection that serves many concurrent requests over one socket."""

    def __init__(self, sock: socket.socket, request_timeout: float | None = None) -> None:
        self._sock = sock
        self._request_timeout = request_timeout
        self._routes: dict[int, queue.Queue] = {}
        self._routes_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._next_stream_id = 1
        self._id_lock = threading.Lock()
        self._closed_error: Exception | None = None
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        hello: HelloPayload,
        auth: AuthPayload,
        connect_timeout: float | None = 10.0,
        request_timeout: float | None = 30.0,
    ) -> tuple[MuxConnection, HandshakeOutcome]:
        """Connect to ``host:port``, run the handshake, and return the live
        connection plus the negotiated outcome."""
        sock = socket.create_connection((host, port), timeout=connect_timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(None)  # the reader thread blocks; per-request waits use the queue
        conn = cls(sock, request_timeout=request_timeout)
        outcome = conn.handshake(hello, auth)
        return conn, outcome

    def handshake(self, hello: HelloPayload, auth: AuthPayload) -> HandshakeOutcome:
        """Run the client side of the handshake on stream 0."""
        offered = list(hello.supported_versions)
        q = self._register(HANDSHAKE_STREAM_ID)
        try:
            self._write(Opcode.HELLO, HANDSHAKE_STREAM_ID, encode_payload(hello))
            welcome_frame = self._expect(q, Opcode.WELCOME)
            welcome = decode_payload(WelcomePayload, welcome_frame.payload)
            if welcome.chosen_version not in offered:
                raise VersionMismatch(welcome.chosen_version, offered)

            self._write(Opcode.AUTH, HANDSHAKE_STREAM_ID, encode_payload(auth))
            auth_ok_frame = self._expect(q, Opcode.AUTH_OK)
            auth_ok = decode_payload(AuthOkPayload, auth_ok_frame.payload)
            return HandshakeOutcome(welcome=welcome, auth_ok=auth_ok)
        finally:
            self._deregister(HANDSHAKE_STREAM_ID)

    def request(self, opcode: Opcode, payload: bytes) -> list[Frame]:
        """Send one request and collect its response frames up to and including
        the EOS frame. Safe to call from many threads; responses route back by
        ``stream_id``."""
        stream_id = self._take_stream_id()
        q = self._register(stream_id)
        try:
            self._write(opcode, stream_id, payload)
            frames: list[Frame] = []
            while True:
                frame = self._next(q)
                if frame.opcode == Opcode.ERROR:
                    raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
                frames.append(frame)
                if frame.flags & FLAG_EOS:
                    return frames
        finally:
            self._deregister(stream_id)

    def request_one(self, opcode: Opcode, payload: bytes) -> Frame:
        """Send one request and require exactly one EOS response frame."""
        frames = self.request(opcode, payload)
        if len(frames) != 1:
            raise ProtocolError(f"expected a single response frame, got {len(frames)}")
        return frames[0]

    def subscribe(self, request: SubscribeRequest) -> Subscription:
        """Open a long-lived subscription. Allocates a stream id, registers its
        route, sends the SUBSCRIBE frame as one EOS frame, and returns a
        :class:`Subscription` the caller drains with ``next()``. Unlike
        :meth:`request`, this does NOT collect to EOS — the server pushes events
        until the client unsubscribes."""
        stream_id = self._take_stream_id()
        q = self._register(stream_id)
        try:
            self._write(Opcode.SUBSCRIBE_REQ, stream_id, encode_payload(request))
        except Exception:
            self._deregister(stream_id)
            raise
        return Subscription(self, stream_id, q)

    def route_count(self) -> int:
        """Number of live routes in the table. Test/diagnostics hook: a clean
        subscription teardown must leave no leaked route behind."""
        with self._routes_lock:
            return len(self._routes)

    def send_bye(self) -> None:
        """Send BYE to end the session cleanly."""
        # A CBOR map, not an empty payload: the server decodes this as a
        # ByeRequest, and zero bytes is not valid CBOR.
        self._write(Opcode.BYE, HANDSHAKE_STREAM_ID, encode_payload(ByeRequest()))

    def close(self) -> None:
        """Close the socket; the reader thread exits and fails any waiters."""
        try:
            self._sock.close()
        finally:
            pass

    # ---- internals ----

    def _reader_loop(self) -> None:
        buf = bytearray()
        while True:
            try:
                frame = read_frame(self._sock, buf)
            except Exception as exc:  # noqa: BLE001 — transport/codec failure ends the loop
                self._fail_all(exc)
                return
            if frame.opcode == int(Opcode.SERVER_PING):
                # Idle-timer heartbeat: answer with CLIENT_PONG on stream 0 so
                # the server doesn't reap an otherwise-idle connection. The
                # reply echoes the server timestamp (0 if the payload can't be
                # decoded — the server only needs a frame to reset its timer).
                # Best-effort: a write failure surfaces as the next read error.
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
                # A closed socket ends the loop on the next read; a failed
                # heartbeat is not separately actionable.
                with contextlib.suppress(Exception):
                    self._write(Opcode.CLIENT_PONG, HANDSHAKE_STREAM_ID, encode_payload(pong))
                continue
            with self._routes_lock:
                q = self._routes.get(frame.stream_id)
            # An unknown stream_id is a late frame for a cancelled/timed-out
            # request; drop it.
            if q is not None:
                q.put(frame)

    def _register(self, stream_id: int) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._routes_lock:
            if self._closed_error is not None:
                raise self._closed_error
            self._routes[stream_id] = q
        return q

    def _deregister(self, stream_id: int) -> None:
        with self._routes_lock:
            self._routes.pop(stream_id, None)

    def _fail_all(self, exc: Exception) -> None:
        error = exc if isinstance(exc, (ConnectionClosed, OSError)) else ConnectionClosed(str(exc))
        with self._routes_lock:
            if self._closed_error is None:
                self._closed_error = error
            for q in self._routes.values():
                q.put(_Closed(error))
            self._routes.clear()

    def _next(self, q: queue.Queue) -> Frame:
        try:
            item = q.get(timeout=self._request_timeout)
        except queue.Empty:
            # `from None`: the empty queue is how a timeout is detected, not a
            # cause worth showing a caller.
            raise BrainTimeout(self._request_timeout) from None
        if isinstance(item, _Closed):
            raise item.error
        return item

    def _expect(self, q: queue.Queue, expected: Opcode) -> Frame:
        frame = self._next(q)
        if frame.opcode == Opcode.ERROR:
            raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
        if frame.opcode != int(expected):
            raise ProtocolError(
                f"expected {expected.name} ({int(expected):#06x}), got {frame.opcode:#06x}"
            )
        return frame

    def _write(self, opcode: Opcode, stream_id: int, payload: bytes) -> None:
        frame = Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload)
        with self._write_lock:
            write_frame(self._sock, frame)

    def _take_stream_id(self) -> int:
        # Client-initiated op streams MUST be non-zero and ODD (stream 0 is the
        # connection/handshake stream; the server rejects even/zero client
        # streams as BadFrame). Start at 1 and step by 2 so every request on a
        # reused connection (pool, any reuse) stays odd, wrapping back to 1.
        with self._id_lock:
            stream_id = self._next_stream_id
            self._next_stream_id = (
                self._next_stream_id + 2 if self._next_stream_id + 2 <= 0xFFFF_FFFF else 1
            )
            return stream_id


# Stands in for `typing.Self`, which is 3.11+; requires-python here is >=3.9.
_SelfSub = TypeVar("_SelfSub", bound="Subscription")


class Subscription:
    """A live server-push subscription stream. Drain events with :meth:`next`
    (or iterate the object directly); call :meth:`unsubscribe` for a clean
    teardown — the server then EOS-closes the event stream, which :meth:`next`
    observes as end-of-stream.

    Dropping a subscription without unsubscribing leaks no route once it is
    closed: :meth:`close` (and the context-manager exit) deregisters the route.
    Prefer :meth:`unsubscribe` before closing so the server stops pushing.
    """

    def __init__(self, conn: MuxConnection, stream_id: int, q: queue.Queue) -> None:
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

    def next(self) -> SubscriptionEvent | None:
        """Return the next subscription event, or ``None`` once the stream has
        ended (the server EOS-closed it, or the connection dropped).

        An EOS-flagged frame carrying an event yields that event; the following
        call returns ``None``. An EOS frame with an empty payload ends the
        stream immediately.
        """
        if self._ended:
            return None
        try:
            frame = self._conn._next(self._q)  # noqa: SLF001 — same module
        except ConnectionClosed:
            self._ended = True
            self._conn._deregister(self._stream_id)  # noqa: SLF001
            return None
        if frame.opcode == Opcode.ERROR:
            self._ended = True
            self._conn._deregister(self._stream_id)  # noqa: SLF001
            raise ServerError.from_response(decode_payload(ErrorResponse, frame.payload))
        if frame.flags & FLAG_EOS:
            # Last frame on the stream; mark ended and drop the route.
            self._ended = True
            self._conn._deregister(self._stream_id)  # noqa: SLF001
            if not frame.payload:
                return None
        return decode_payload(SubscriptionEvent, frame.payload)

    def __iter__(self) -> Subscription:
        return self

    def __next__(self) -> SubscriptionEvent:
        event = self.next()
        if event is None:
            raise StopIteration
        return event

    def unsubscribe(self) -> UnsubscribeResponse:
        """Tear the subscription down cleanly: send UNSUBSCRIBE on a fresh
        stream and await its UNSUBSCRIBE_RESP. The server then EOS-closes the
        event stream, which a subsequent :meth:`next` observes as ``None``."""
        req = UnsubscribeRequest(target_stream_id=self._stream_id)
        frame = self._conn.request_one(Opcode.UNSUBSCRIBE_REQ, encode_payload(req))
        if frame.opcode != int(Opcode.UNSUBSCRIBE_RESP):
            raise ProtocolError(
                f"expected UNSUBSCRIBE_RESP ({int(Opcode.UNSUBSCRIBE_RESP):#06x}), got "
                f"{frame.opcode:#06x}"
            )
        return decode_payload(UnsubscribeResponse, frame.payload)

    def close(self) -> None:
        """Deregister the subscription's route so a forgotten handle doesn't
        leak a route-table entry. Does not send UNSUBSCRIBE — call
        :meth:`unsubscribe` first for a clean shutdown."""
        self._ended = True
        self._conn._deregister(self._stream_id)  # noqa: SLF001

    def __enter__(self: _SelfSub) -> _SelfSub:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


__all__ = ["HANDSHAKE_STREAM_ID", "HandshakeOutcome", "MuxConnection", "Subscription"]
