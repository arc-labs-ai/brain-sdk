"""The asyncio client's verb layer.

The mux suite covers the connection; this covers what sits on it — that a verb
sends the opcode it claims, decodes the response type it claims, refuses an
answer of the wrong shape, and that the aggregating verbs (``recall``,
``memory_list``, the ``list_*`` family) flatten a streamed answer correctly.
"""

from __future__ import annotations

import asyncio

import pytest
from aio_harness import (
    MEMORY_NOT_FOUND_CODE,
    MOCK_SPACE_ID,
    MockBrain,
    MockSession,
    mock_encode_response,
)

from brain_db_sdk.aio import AsyncBrainClient
from brain_db_sdk.client import Auth, ClientConfig
from brain_db_sdk.errors import ConnectionClosed, ProtocolError, ServerError
from brain_db_sdk.verbs import EncodeBuilder, ForgetBuilder, RecallBuilder
from brain_db_sdk.wire.frame import FLAG_EOS
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AnswerKind,
    EncodeRequest,
    ErrorCategory,
    ForgetResponse,
    MemoryInspectRequest,
    MemoryListItem,
    MemoryListRequest,
    MemoryListResponseFrame,
    MemoryResult,
    RecallResponseFrame,
    decode_payload,
    encode_payload,
)

AUTH = Auth.token(b"brain_test")


async def _client(server: MockBrain, **kw: object) -> AsyncBrainClient:
    return await AsyncBrainClient.connect_with(
        server.host,
        server.port,
        ClientConfig(auth=AUTH, **kw),  # type: ignore[arg-type]
    )


def _memory(memory_id: int, text: str) -> MemoryResult:
    """A recall hit with everything at its neutral value but the two fields
    these tests assert on."""
    return MemoryResult(
        memory_id=memory_id,
        text=text,
        similarity_score=0.9,
        confidence=0.9,
        salience=0.5,
        kind=0,
        space_id=MOCK_SPACE_ID,
        session_id=0,
        created_at_unix_nanos=1,
        last_accessed_at_unix_nanos=1,
        edges=None,
        contributing_retrievers=[],
        fused_score=0.9,
        rerank_score=None,
        salience_initial=0.5,
        access_count=0,
        lsn=1,
        flags=0,
        consolidated_at_unix_nanos=None,
        occurred_at_unix_nanos=None,
        edges_out_count=0,
        edges_in_count=0,
        graph=None,
    )


def _list_item(n: int) -> MemoryListItem:
    return MemoryListItem(
        memory_id=n,
        space_id=MOCK_SPACE_ID,
        session_id=0,
        text=f"m{n}",
        kind=0,
        state=0,
        created_at_unix_nanos=1,
        occurred_at_unix_nanos=1,
        last_accessed_at_unix_nanos=1,
        salience=0.1,
        access_count=0,
        source_request_id=b"\x00" * 16,
        statement_count=0,
        entity_count=0,
        relation_count=0,
    )


def _list_request() -> MemoryListRequest:
    """A plain first page: no filters, no cursor."""
    return MemoryListRequest(
        sort=0,
        dir=0,
        limit=10,
        cursor=b"",
        kinds=[],
        include_tombstoned=False,
        time_axis=0,
        from_unix_nanos=0,
        to_unix_nanos=0,
        salience_min=0.0,
        salience_max=1.0,
        text_contains="",
    )


def _recall_frame(memories: list[MemoryResult], *, final: bool) -> bytes:
    return encode_payload(
        RecallResponseFrame(
            answer_kind=AnswerKind.MANY if memories else AnswerKind.NONE,
            memories=memories,
            is_final=final,
            cumulative_count=len(memories),
            estimated_remaining=0,
            trace=None,
        )
    )


# --------------------------------------------------------------------------
# A verb round trip
# --------------------------------------------------------------------------


async def test_encode_sends_the_request_and_decodes_the_response() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        assert frame.opcode == int(Opcode.ENCODE_REQ)
        request = decode_payload(EncodeRequest, frame.payload)
        assert request.text == "Ada works at Arc Labs"
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(77))
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            response = await client.encode(EncodeBuilder("Ada works at Arc Labs").build())
            assert response.memory_id == 77
            assert response.space_id == MOCK_SPACE_ID
        finally:
            await client.aclose()


async def test_the_connection_carries_what_the_server_bound() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake(namespace="acme")
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            assert client.namespace == "acme"
            assert client.space_id == MOCK_SPACE_ID
            assert client.connection.server_id == "mock-brain"
            assert client.connection.permissions.can_encode is True
            assert client.connection.permissions.can_admin is False
            assert client.is_closed is False
        finally:
            await client.aclose()


async def test_a_response_with_the_wrong_opcode_is_refused() -> None:
    """A FORGET_RESP where ENCODE_RESP belongs would otherwise be decoded as
    the wrong type and surface as a confusing field error much later."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.FORGET_RESP,
            frame.stream_id,
            encode_payload(
                ForgetResponse(memory_id=1, was_already_forgotten=False, edges_removed=0)
            ),
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            with pytest.raises(ProtocolError, match="expected ENCODE_RESP"):
                await client.encode(EncodeBuilder("x").build())
        finally:
            await client.aclose()


async def test_forget_round_trips() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        assert frame.opcode == int(Opcode.FORGET_REQ)
        await session.write(
            Opcode.FORGET_RESP,
            frame.stream_id,
            encode_payload(
                ForgetResponse(memory_id=5, was_already_forgotten=False, edges_removed=3)
            ),
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            response = await client.forget(ForgetBuilder(5).hard().build())
            assert response.memory_id == 5
            assert response.was_already_forgotten is False
            assert response.edges_removed == 3
        finally:
            await client.aclose()


# --------------------------------------------------------------------------
# Streamed verbs
# --------------------------------------------------------------------------


async def test_recall_concatenates_memories_across_frames() -> None:
    """RECALL streams; ``recall`` is the flattened view and the terminal
    frame's ``answer_kind`` is the one that counts."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.RECALL_RESP,
            frame.stream_id,
            _recall_frame([_memory(1, "one"), _memory(2, "two")], final=False),
            flags=0,
        )
        await session.write(
            Opcode.RECALL_RESP,
            frame.stream_id,
            _recall_frame([_memory(3, "three")], final=True),
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            answer = await client.recall(RecallBuilder("who is Ada?").build())
            assert [m.memory_id for m in answer.memories] == [1, 2, 3]
            assert answer.answer_kind == AnswerKind.MANY
        finally:
            await client.aclose()


async def test_recall_with_nothing_to_say_is_an_empty_answer_not_an_error() -> None:
    """A cue that nothing stored answers is a result, not a failure."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(Opcode.RECALL_RESP, frame.stream_id, _recall_frame([], final=True))
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            answer = await client.recall(RecallBuilder("nothing").build())
            assert answer.memories == []
            assert answer.answer_kind == AnswerKind.NONE
        finally:
            await client.aclose()


async def test_recall_frames_preserves_the_streaming_detail() -> None:
    """``recall`` throws away ``is_final`` / ``cumulative_count``; the
    ``_frames`` variant is what a paging caller needs."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.RECALL_RESP,
            frame.stream_id,
            _recall_frame([_memory(1, "a")], final=False),
            flags=0,
        )
        await session.write(
            Opcode.RECALL_RESP, frame.stream_id, _recall_frame([_memory(2, "b")], final=True)
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            frames = await client.recall_frames(RecallBuilder("cue").build())
            assert [f.is_final for f in frames] == [False, True]
        finally:
            await client.aclose()


async def test_memory_list_flattens_pages() -> None:
    def page(ids: list[int], *, final: bool) -> bytes:
        return encode_payload(
            MemoryListResponseFrame(
                items=[_list_item(i) for i in ids],
                next_cursor=b"" if final else b"\x01" * 16,
                cumulative_count=len(ids),
                is_final=final,
            )
        )

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.MEMORY_LIST_RESP, frame.stream_id, page([1, 2], final=False), flags=0
        )
        await session.write(Opcode.MEMORY_LIST_RESP, frame.stream_id, page([3], final=True))
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            items = await client.memory_list(_list_request())
            assert [i.memory_id for i in items] == [1, 2, 3]
        finally:
            await client.aclose()


# --------------------------------------------------------------------------
# The absent-memory contract
# --------------------------------------------------------------------------


async def test_inspecting_a_memory_that_is_not_there_is_refused_not_flagged() -> None:
    """An id with no memory behind it is refused with ``MemoryNotFound`` in the
    ``NotFound`` category, the same answer every sibling read gives, so a
    caller branches on the error taxonomy it already handles rather than on a
    flag specific to one response.
    """

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        assert frame.opcode == int(Opcode.MEMORY_INSPECT_REQ)
        await session.error(
            frame.stream_id,
            code=MEMORY_NOT_FOUND_CODE,
            category=ErrorCategory.NOT_FOUND,
            message="memory not found",
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            with pytest.raises(ServerError) as caught:
                await client.memory_inspect(MemoryInspectRequest(memory_id=99))
            assert caught.value.category == ErrorCategory.NOT_FOUND
            assert caught.value.code == MEMORY_NOT_FOUND_CODE
        finally:
            await client.aclose()


# --------------------------------------------------------------------------
# Concurrency and lifecycle
# --------------------------------------------------------------------------


async def test_verbs_run_concurrently_over_one_connection() -> None:
    """One socket, one reader task, twenty writes at once — the reason to
    reach for this tier at all."""
    count = 20

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frames = [await session.read() for _ in range(count)]
        for frame in reversed(frames):
            await session.write(
                Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(frame.stream_id)
            )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            responses = await asyncio.gather(
                *(client.encode(EncodeBuilder(f"memory {i}").build()) for i in range(count))
            )
            assert len({r.memory_id for r in responses}) == count
        finally:
            await client.aclose()


async def test_aclose_sends_bye() -> None:
    saw_bye = asyncio.get_running_loop().create_future()

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        if not saw_bye.done():
            saw_bye.set_result(frame.opcode)
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        await client.aclose()
        assert await asyncio.wait_for(saw_bye, timeout=3) == int(Opcode.BYE)


async def test_the_async_context_manager_closes_the_connection() -> None:
    async def handler(session: MockSession) -> None:
        await session.handshake()
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        async with client:
            assert client.is_closed is False
        assert client.is_closed is True


async def test_a_peer_that_disappears_shows_up_as_closed() -> None:
    """``is_closed`` is what a pool reads to decide a member needs replacing."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        await session.close()

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            for _ in range(100):
                if client.is_closed:
                    break
                await asyncio.sleep(0.01)
            assert client.is_closed
            with pytest.raises((ConnectionClosed, OSError)):
                await client.encode(EncodeBuilder("x").build())
        finally:
            await client.aclose()


async def test_ping_travels_on_the_connection_stream() -> None:
    """PING is connection-level, like HELLO and BYE: Brain refuses it on any
    stream but 0 with ``connection-level opcode requires stream_id = 0``.

    The unary path allocates an odd op-stream id, which the server refuses for
    a connection-level opcode, so the probe has to ride stream 0. Only live
    traffic shows that: the rule lives in the server's dispatch layer, and the
    mock below answers a wrong-stream PING quite happily. The stream id is the
    part a mock can pin.
    """
    seen: list[int] = []

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        seen.append(frame.stream_id)
        from brain_db_sdk.wire.types import PingRequest, PongResponse

        sent = decode_payload(PingRequest, frame.payload)
        await session.write(
            Opcode.PONG,
            frame.stream_id,
            encode_payload(
                PongResponse(
                    client_timestamp_unix_nanos=sent.client_timestamp_unix_nanos,
                    server_timestamp_unix_nanos=7,
                )
            ),
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            assert (await client.ping()).server_timestamp_unix_nanos == 7
            assert seen == [0], f"PING went out on stream {seen}, not the connection stream"
        finally:
            await client.aclose()


async def test_ping_defaults_its_timestamp() -> None:
    """A client-initiated liveness probe, distinct from the server heartbeat
    the reader answers on its own."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        assert frame.opcode == int(Opcode.PING)
        from brain_db_sdk.wire.types import PingRequest, PongResponse

        sent = decode_payload(PingRequest, frame.payload)
        assert sent.client_timestamp_unix_nanos > 0
        await session.write(
            Opcode.PONG,
            frame.stream_id,
            encode_payload(
                PongResponse(
                    client_timestamp_unix_nanos=sent.client_timestamp_unix_nanos,
                    server_timestamp_unix_nanos=123,
                )
            ),
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server)
        try:
            pong = await client.ping()
            assert pong.server_timestamp_unix_nanos == 123
        finally:
            await client.aclose()


async def test_the_eos_flag_terminates_a_single_frame_answer() -> None:
    """A unary verb whose frame lacks EOS would hang until the deadline; the
    server sets it, and the client must treat it as the end."""

    async def handler(session: MockSession) -> None:
        await session.handshake()
        frame = await session.read()
        await session.write(
            Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response(), flags=FLAG_EOS
        )
        await asyncio.sleep(0.5)

    async with MockBrain(handler) as server:
        client = await _client(server, request_timeout=1.0)
        try:
            assert (await client.encode(EncodeBuilder("x").build())).memory_id == 1
        finally:
            await client.aclose()
