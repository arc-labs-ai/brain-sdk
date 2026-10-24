"""Asynchronous frame transport: read and write whole BRN0 frames over an
``asyncio`` stream pair.

The asyncio twin of :mod:`brain_db_sdk.transport`, and deliberately the same
shape: writing is one ``write`` + ``drain``; reading is incremental, because a
frame can straddle reads. :func:`read_frame` keeps a caller-owned buffer, pulls
more bytes whenever the codec reports the buffer is short, and drains exactly
the frame's bytes once one decodes — leaving any trailing bytes (the start of
the next frame) in the buffer.

Both halves share the frame codec in :mod:`brain_db_sdk.wire.frame`, so the two
transports cannot disagree about what a frame is: only *how the bytes are
awaited* differs.
"""

from __future__ import annotations

import asyncio

from brain_db_sdk.errors import ConnectionClosed
from brain_db_sdk.transport import READ_CHUNK
from brain_db_sdk.wire.frame import Frame, TruncatedFrame, decode_frame, encode_frame


async def write_frame(writer: asyncio.StreamWriter, frame: Frame) -> None:
    """Serialize ``frame``, write it to ``writer``, and await the drain.

    The ``drain`` is the backpressure point and the reason this is a coroutine:
    without it a fast producer buffers unboundedly in the transport while the
    peer falls behind. Callers must serialize concurrent calls (the mux holds a
    lock), since ``write`` + ``await drain`` is not atomic and interleaving two
    of them would splice two frames' bytes together.
    """
    writer.write(encode_frame(frame.opcode, frame.stream_id, frame.flags, frame.payload))
    await writer.drain()


async def read_frame(reader: asyncio.StreamReader, buf: bytearray) -> Frame:
    """Read exactly one frame from ``reader``, using ``buf`` to hold bytes that
    span reads. On return ``buf`` holds only the bytes after the decoded frame,
    ready for the next call.

    A :class:`~brain_db_sdk.wire.frame.TruncatedFrame` from the codec means
    "need more bytes" and drives another read; any other
    :class:`~brain_db_sdk.wire.frame.FrameError` is fatal for the connection and
    propagates. A zero-length read is a closed peer and raises
    :class:`~brain_db_sdk.errors.ConnectionClosed`.
    """
    while True:
        try:
            frame, rest = decode_frame(bytes(buf))
        except TruncatedFrame:
            chunk = await reader.read(READ_CHUNK)
            if not chunk:
                # `from None`: a short frame followed by EOF means the peer hung
                # up mid-frame. The TruncatedFrame was the prompt to read more,
                # not the failure.
                raise ConnectionClosed("connection closed by peer") from None
            buf.extend(chunk)
            continue
        # Drop exactly the frame's bytes, keeping the tail for next time.
        del buf[: len(buf) - len(rest)]
        return frame


__all__ = ["READ_CHUNK", "read_frame", "write_frame"]
