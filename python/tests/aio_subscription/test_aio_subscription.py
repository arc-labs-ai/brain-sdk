"""Server-push subscriptions over the asyncio connection.

A subscription is the one stream that does *not* collect to EOS: the server
pushes until the client stops it. That makes the interesting claims about
lifetime rather than content — that iteration ends when the server says so,
that a clean teardown is acknowledged, and that no handle, abandoned or closed,
leaves a route behind on a connection meant to stay up for days.
"""

from __future__ import annotations

import asyncio

import pytest
from aio_harness import MockBrain, MockSession

from brain_db_sdk.aio import AsyncBrainClient
from brain_db_sdk.client import Auth, ClientConfig
from brain_db_sdk.errors import ProtocolError, ServerError
from brain_db_sdk.wire.frame import FLAG_EOS
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    ErrorCategory,
    SubscribeRequest,
    SubscriptionEvent,
    SubscriptionFilter,
    UnsubscribeRequest,
    UnsubscribeResponse,
    decode_payload,
    encode_payload,
)

AUTH = Auth.token(b"brain_test")


def _subscribe() -> SubscribeRequest:
    return SubscribeRequest(
        filter=SubscriptionFilter(session_filter=None, kinds=None, similar_to=None, spaces=None),
        include_history=False,
        from_lsn=None,
        max_inflight=16,
    )


def _event(lsn: int, text: str) -> bytes:
    return encode_payload(
        SubscriptionEvent(
            event_type=0,
            memory_id=lsn,
            session_id=0,
            text=text,
            kind=0,
            salience=0.5,
            timestamp_unix_nanos=1,
            lsn=lsn,
            graph_payload=None,
            edge_payload=None,
            stage_kind=None,
            stage_outcome=None,
            stage_payload=None,
        )
    )


async def _client(server: MockBrain) -> AsyncBrainClient:
    return await AsyncBrainClient.connect_with(server.host, server.port, ClientConfig(auth=AUTH))


async def test_events_arrive_in_order_and_async_for_ends_at_eos() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        assert frame.opcode == int(Opcode.SUBSCRIBE_REQ)
        for i in (1, 2, 3):
            await session.write(
                Opcode.SUBSCRIBE_EVENT, frame.stream_id, _event(i, f"e{i}"), flags=0
            )
        # An EOS frame with an empty payload is how the server ends the stream.
        await session.write(Opcode.SUBSCRIBE_EVENT, frame.stream_id, b"", flags=FLAG_EOS)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            seen = [event.text async for event in sub]
            assert seen == ["e1", "e2", "e3"]
            assert await sub.next() is None, "a finished stream keeps answering None"
        finally:
            await client.aclose()


async def test_an_event_riding_the_eos_frame_is_still_delivered() -> None:
    """The last event and the end-of-stream can share a frame; dropping the
    payload because EOS is set would silently lose it."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.SUBSCRIBE_EVENT, frame.stream_id, _event(9, "last"), flags=FLAG_EOS
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            event = await sub.next()
            assert event is not None
            assert event.text == "last"
            assert await sub.next() is None
        finally:
            await client.aclose()


async def test_unsubscribe_round_trips_on_its_own_stream() -> None:
    """UNSUBSCRIBE travels on a fresh stream so it does not queue behind the
    events it is stopping."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        sub_frame = await session.read()
        await session.write(Opcode.SUBSCRIBE_EVENT, sub_frame.stream_id, _event(1, "e1"), flags=0)
        unsub_frame = await session.read()
        assert unsub_frame.opcode == int(Opcode.UNSUBSCRIBE_REQ)
        assert unsub_frame.stream_id != sub_frame.stream_id
        request = decode_payload(UnsubscribeRequest, unsub_frame.payload)
        assert request.target_stream_id == sub_frame.stream_id
        await session.write(
            Opcode.UNSUBSCRIBE_RESP,
            unsub_frame.stream_id,
            encode_payload(UnsubscribeResponse(target_stream_id=sub_frame.stream_id, final_lsn=1)),
        )
        await session.write(Opcode.SUBSCRIBE_EVENT, sub_frame.stream_id, b"", flags=FLAG_EOS)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            first = await sub.next()
            assert first is not None and first.text == "e1"
            response = await sub.unsubscribe()
            assert response.target_stream_id == sub.stream_id
            assert await sub.next() is None
            assert client._conn.route_count() == 0
        finally:
            await client.aclose()


async def test_an_unexpected_answer_to_unsubscribe_is_a_protocol_error() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.read()  # SUBSCRIBE
        unsub_frame = await session.read()
        await session.write(Opcode.PONG, unsub_frame.stream_id, b"\xa0")
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            with pytest.raises(ProtocolError, match="expected UNSUBSCRIBE_RESP"):
                await sub.unsubscribe()
        finally:
            await client.aclose()


async def test_an_error_frame_on_the_event_stream_raises_and_ends_it() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.error(
            frame.stream_id,
            category=ErrorCategory.RESOURCE_EXHAUSTED,
            message="too many subscriptions",
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            with pytest.raises(ServerError, match="too many subscriptions"):
                await sub.next()
            assert client._conn.route_count() == 0, "a failed stream must drop its route"
        finally:
            await client.aclose()


async def test_closing_a_subscription_without_unsubscribing_leaks_no_route() -> None:
    """A handle that just goes away is the common accident; on a connection
    meant to live for days, one leaked route per accident adds up."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.read()
        await asyncio.sleep(1.0)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            assert client._conn.route_count() == 1
            await sub.aclose()
            assert client._conn.route_count() == 0
            assert await sub.next() is None
        finally:
            await client.aclose()


async def test_the_async_context_manager_drops_the_route() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.read()
        await asyncio.sleep(1.0)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            async with await client.subscribe(_subscribe()):
                assert client._conn.route_count() == 1
            assert client._conn.route_count() == 0
        finally:
            await client.aclose()


async def test_a_dropped_connection_ends_the_stream_rather_than_raising() -> None:
    """A subscription outliving its connection reads as end-of-stream: the
    caller's loop finishes instead of exploding mid-iteration."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(Opcode.SUBSCRIBE_EVENT, frame.stream_id, _event(1, "e1"), flags=0)
        await asyncio.sleep(0.05)
        await session.close()

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            sub = await client.subscribe(_subscribe())
            seen = [event.text async for event in sub]
            assert seen == ["e1"]
        finally:
            await client.aclose()
