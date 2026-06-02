"""A single connection: the handshake and one-at-a-time request/response
over a socket.

This phase serves one request at a time (send, then read the response to
EOS). The concurrent stream multiplexer and pool are a later phase and
will reuse this type's frame plumbing. ``stream_id`` 0 is reserved for the
handshake; request streams are numbered from 1 upward.
"""

from __future__ import annotations

import socket
from dataclasses import dataclass

from .errors import BrainTimeout, ProtocolError, ServerError, VersionMismatch
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

# The ``stream_id`` carried by every handshake frame.
HANDSHAKE_STREAM_ID = 0


@dataclass(frozen=True)
class HandshakeOutcome:
    """What the server told us during the handshake."""

    welcome: WelcomePayload
    auth_ok: AuthOkPayload


class Connection:
    """One connection to a Brain server."""

    def __init__(self, sock: socket.socket, request_timeout: float | None = None) -> None:
        self._sock = sock
        self._buf = bytearray()
        self._next_stream_id = 1
        self._request_timeout = request_timeout

    def handshake(self, hello: HelloPayload, auth: AuthPayload) -> HandshakeOutcome:
        """Run the client side of the handshake: HELLO -> WELCOME -> AUTH
        -> AUTH_OK. Validates the chosen version was offered and that each
        reply carries the expected opcode."""
        offered = list(hello.supported_versions)

        self._send(Opcode.HELLO, HANDSHAKE_STREAM_ID, encode_payload(hello))
        welcome_frame = self._read_handshake_reply(Opcode.WELCOME)
        welcome = decode_payload(WelcomePayload, welcome_frame.payload)
        if welcome.chosen_version not in offered:
            raise VersionMismatch(welcome.chosen_version, offered)

        self._send(Opcode.AUTH, HANDSHAKE_STREAM_ID, encode_payload(auth))
        auth_ok_frame = self._read_handshake_reply(Opcode.AUTH_OK)
        auth_ok = decode_payload(AuthOkPayload, auth_ok_frame.payload)

        return HandshakeOutcome(welcome=welcome, auth_ok=auth_ok)

    def request(self, opcode: Opcode, payload: bytes) -> list[Frame]:
        """Send one request and collect its response frames up to and
        including the EOS frame. Single-shot verbs return one frame;
        streaming verbs return several. An ERROR reply raises
        :class:`~brain_db_sdk.errors.ServerError`."""
        stream_id = self._take_stream_id()
        self._send(opcode, stream_id, payload)

        frames: list[Frame] = []
        while True:
            frame = self._read_frame()
            if frame.opcode == Opcode.ERROR:
                raise ServerError(decode_payload(ErrorResponse, frame.payload))
            if frame.stream_id != stream_id:
                raise ProtocolError(
                    f"response on stream {frame.stream_id} but request used "
                    f"stream {stream_id}"
                )
            frames.append(frame)
            if frame.flags & FLAG_EOS:
                return frames

    def request_one(self, opcode: Opcode, payload: bytes) -> Frame:
        """Send one request and require exactly one EOS response frame —
        the shape every single-shot verb uses."""
        frames = self.request(opcode, payload)
        if len(frames) != 1:
            raise ProtocolError(
                f"expected a single response frame, got {len(frames)}"
            )
        return frames[0]

    def send_bye(self) -> None:
        """Send BYE to end the session cleanly. The server closes without
        a reply, so this does not read."""
        self._send(Opcode.BYE, HANDSHAKE_STREAM_ID, b"")

    def close(self) -> None:
        """Close the underlying socket."""
        self._sock.close()

    # ---- internals ----

    def _send(self, opcode: Opcode, stream_id: int, payload: bytes) -> None:
        frame = Frame(
            opcode=int(opcode),
            flags=FLAG_EOS,
            stream_id=stream_id,
            payload=payload,
        )
        write_frame(self._sock, frame)

    def _read_handshake_reply(self, expected: Opcode) -> Frame:
        frame = self._read_frame()
        if frame.opcode == Opcode.ERROR:
            raise ServerError(ErrorResponse.decode(frame.payload))
        if frame.opcode != int(expected):
            raise ProtocolError(
                f"expected {expected.name} ({int(expected):#06x}), got opcode "
                f"{frame.opcode:#06x}"
            )
        return frame

    def _read_frame(self) -> Frame:
        if self._request_timeout is not None:
            self._sock.settimeout(self._request_timeout)
        try:
            return read_frame(self._sock, self._buf)
        except socket.timeout:
            raise BrainTimeout(self._request_timeout)

    def _take_stream_id(self) -> int:
        stream_id = self._next_stream_id
        # 32-bit wire field; wrap past the max back to 1 (0 stays reserved
        # for the handshake).
        self._next_stream_id = self._next_stream_id + 1 if self._next_stream_id < 0xFFFF_FFFF else 1
        return stream_id


__all__ = ["Connection", "HandshakeOutcome", "HANDSHAKE_STREAM_ID"]
