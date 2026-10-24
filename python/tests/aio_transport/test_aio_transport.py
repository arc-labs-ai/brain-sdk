"""The asyncio frame transport: whole frames out of an arbitrary byte stream.

TCP gives a byte stream, not a message stream, so the only interesting
questions here are about boundaries: a frame split across reads, several frames
delivered in one read, and a stream that ends in the middle of one. The codec
is shared with the synchronous transport and pinned by the conformance corpus;
what these cover is the awaiting around it.
"""

from __future__ import annotations

import asyncio

import pytest
from aio_harness import MockBrain, MockSession

from brain_db_sdk.aio.transport import read_frame, write_frame
from brain_db_sdk.errors import ConnectionClosed
from brain_db_sdk.wire.frame import FLAG_EOS, Frame, encode_frame
from brain_db_sdk.wire.opcode import Opcode


async def _dial(server: MockBrain) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    return await asyncio.open_connection(server.host, server.port)


async def test_a_frame_split_across_reads_is_reassembled() -> None:
    """The payload arrives in three writes with a pause between each; the
    reader must not return until it holds the whole frame."""
    payload = b"x" * 5000
    whole = encode_frame(int(Opcode.ENCODE_RESP), 1, FLAG_EOS, payload)

    async def handler(session: MockSession) -> None:
        for chunk in (whole[:7], whole[7:1200], whole[1200:]):
            await session.write_raw(chunk)
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.2)

    async with MockBrain(handler) as server:
        reader, writer = await _dial(server)
        try:
            frame = await read_frame(reader, bytearray())
            assert frame.payload == payload
            assert frame.stream_id == 1
        finally:
            writer.close()


async def test_two_frames_in_one_read_are_returned_one_at_a_time() -> None:
    """The buffer must keep the tail: reading the first frame cannot consume
    the second, which arrived in the same packet."""
    first = encode_frame(int(Opcode.ENCODE_RESP), 1, 0, b"one")
    second = encode_frame(int(Opcode.ENCODE_RESP), 3, FLAG_EOS, b"two")

    async def handler(session: MockSession) -> None:
        await session.write_raw(first + second)
        await asyncio.sleep(0.2)

    async with MockBrain(handler) as server:
        reader, writer = await _dial(server)
        try:
            buf = bytearray()
            a = await read_frame(reader, buf)
            b = await read_frame(reader, buf)
            assert (a.payload, a.stream_id) == (b"one", 1)
            assert (b.payload, b.stream_id) == (b"two", 3)
            assert not buf, "the buffer should be drained once both frames are read"
        finally:
            writer.close()


async def test_eof_in_the_middle_of_a_frame_is_a_closed_connection() -> None:
    """A truncated frame followed by EOF is a hung-up peer, not a codec bug —
    the distinction a caller needs to decide whether to reconnect."""
    whole = encode_frame(int(Opcode.ENCODE_RESP), 1, FLAG_EOS, b"y" * 100)

    async def handler(session: MockSession) -> None:
        await session.write_raw(whole[:20])
        await session.close()

    async with MockBrain(handler) as server:
        reader, writer = await _dial(server)
        try:
            with pytest.raises(ConnectionClosed):
                await read_frame(reader, bytearray())
        finally:
            writer.close()


async def test_eof_before_any_bytes_is_a_closed_connection() -> None:
    """The degenerate case: the peer accepts and immediately hangs up."""

    async def handler(session: MockSession) -> None:
        await session.close()

    async with MockBrain(handler) as server:
        reader, writer = await _dial(server)
        try:
            with pytest.raises(ConnectionClosed):
                await read_frame(reader, bytearray())
        finally:
            writer.close()


async def test_an_empty_payload_round_trips() -> None:
    """Zero-length payloads are legal on the wire (an EOS-only frame ends a
    subscription that way) and must survive the boundary logic, which works in
    lengths."""
    received: list[Frame] = []

    async def handler(session: MockSession) -> None:
        received.append(await session.read())
        await asyncio.sleep(0.2)

    async with MockBrain(handler) as server:
        _, writer = await _dial(server)
        try:
            await write_frame(
                writer, Frame(opcode=int(Opcode.BYE), flags=FLAG_EOS, stream_id=0, payload=b"")
            )
            for _ in range(100):
                if received:
                    break
                await asyncio.sleep(0.01)
            assert received, "the server never saw the frame"
            assert received[0].payload == b""
            assert received[0].opcode == int(Opcode.BYE)
        finally:
            writer.close()
