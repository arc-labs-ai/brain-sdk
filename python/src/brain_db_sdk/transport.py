"""Synchronous frame transport: read and write whole BRN0 frames over a
socket.

This is the seam between the byte stream and the frame codec in
:mod:`brain_db_sdk.wire.frame`. Writing is one ``sendall``. Reading is
incremental: a frame can straddle ``recv`` calls, so :func:`read_frame`
keeps a caller-owned buffer, pulls more bytes whenever the codec reports
the buffer is short, and drains exactly the frame's bytes once one
decodes — leaving any trailing bytes (the start of the next frame) in the
buffer.
"""

from __future__ import annotations

import socket

from .errors import ConnectionClosed
from .wire.frame import Frame, TruncatedFrame, decode_frame, encode_frame

# Bytes pulled from the socket per ``recv`` when the buffer is short.
READ_CHUNK = 16 * 1024


def write_frame(sock: socket.socket, frame: Frame) -> None:
    """Serialize ``frame`` and write all its bytes to ``sock``."""
    sock.sendall(encode_frame(frame.opcode, frame.stream_id, frame.flags, frame.payload))


def read_frame(sock: socket.socket, buf: bytearray) -> Frame:
    """Read exactly one frame from ``sock``, using ``buf`` to hold bytes
    that span reads. On return ``buf`` holds only the bytes after the
    decoded frame, ready for the next call.

    A :class:`~brain_db_sdk.wire.frame.TruncatedFrame` from the codec means
    "need more bytes" and drives another ``recv``; any other
    :class:`~brain_db_sdk.wire.frame.FrameError` is fatal for the
    connection and propagates. A zero-length ``recv`` is a closed peer and
    raises :class:`~brain_db_sdk.errors.ConnectionClosed`.
    """
    while True:
        try:
            frame, rest = decode_frame(bytes(buf))
        except TruncatedFrame:
            chunk = sock.recv(READ_CHUNK)
            if not chunk:
                # `from None`: a short frame followed by EOF means the peer
                # hung up mid-frame. The TruncatedFrame was the prompt to read
                # more, not the failure.
                raise ConnectionClosed("connection closed by peer") from None
            buf.extend(chunk)
            continue
        # Drop exactly the frame's bytes, keeping the tail for next time.
        del buf[: len(buf) - len(rest)]
        return frame


__all__ = ["write_frame", "read_frame", "READ_CHUNK"]
