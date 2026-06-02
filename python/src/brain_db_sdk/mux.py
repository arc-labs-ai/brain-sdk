"""Multiplexed connection: many requests in flight at once over one socket.

The one-at-a-time :class:`~brain_db_sdk.connection.Connection` sends a request
and blocks the socket until its response arrives. A :class:`MuxConnection` runs
a background **reader thread** that demultiplexes every inbound frame to the
waiting request by its ``stream_id``, so callers issue requests concurrently
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

import queue
import socket
import threading
from dataclasses import dataclass

from .errors import BrainTimeout, ConnectionClosed, ProtocolError, ServerError, VersionMismatch
from .transport import read_frame, write_frame
from .wire.frame import FLAG_EOS, Frame
from .wire.opcode import Opcode
from .wire.types import (
    AuthOkPayload,
    AuthPayload,
    ErrorResponse,
    HelloPayload,
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
    ) -> tuple["MuxConnection", HandshakeOutcome]:
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
                    raise ServerError(decode_payload(ErrorResponse, frame.payload))
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

    def send_bye(self) -> None:
        """Send BYE to end the session cleanly."""
        self._write(Opcode.BYE, HANDSHAKE_STREAM_ID, b"")

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
            raise BrainTimeout(self._request_timeout)
        if isinstance(item, _Closed):
            raise item.error
        return item

    def _expect(self, q: queue.Queue, expected: Opcode) -> Frame:
        frame = self._next(q)
        if frame.opcode == Opcode.ERROR:
            raise ServerError(decode_payload(ErrorResponse, frame.payload))
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
        with self._id_lock:
            stream_id = self._next_stream_id
            self._next_stream_id = self._next_stream_id + 1 if self._next_stream_id < 0xFFFF_FFFF else 1
            return stream_id


__all__ = ["MuxConnection", "HandshakeOutcome", "HANDSHAKE_STREAM_ID"]
