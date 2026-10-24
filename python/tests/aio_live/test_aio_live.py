"""The asyncio client against a real ``brain-server``.

Everything in ``tests/aio_*`` otherwise runs against a scripted mock, which can
only ever confirm that the client does what the test thinks the server does.
This suite is the one that catches a mistaken assumption about the real thing:
a field the mock fills differently, an ordering Brain does not actually
guarantee, a verb whose real answer does not decode.

Gated on ``BRAIN_SDK_IT_DATA`` like every other integration suite — it skips
when no server is configured (see ``scripts/it-server.sh``), so the default
offline run is unaffected.
"""

from __future__ import annotations

import asyncio

import pytest

from brain_db_sdk.aio import AsyncBrainClient, AsyncPool, with_retry
from brain_db_sdk.aio.retry import RetryPolicy
from brain_db_sdk.errors import ServerError
from brain_db_sdk.verbs import EncodeBuilder, RecallBuilder
from brain_db_sdk.wire.types import ErrorCategory, MemoryInspectRequest

VISIBILITY_TIMEOUT_S = 5.0


async def _recall_until(client: AsyncBrainClient, cue: str, want: str) -> list[str]:
    """Poll RECALL until ``want`` shows up or the budget runs out.

    ENCODE is durable the instant it acks, but the semantic index becomes
    *searchable* a beat later; without this a read-your-writes assertion is a
    race rather than a test.
    """
    deadline = asyncio.get_running_loop().time() + VISIBILITY_TIMEOUT_S
    texts: list[str] = []
    while True:
        answer = await client.recall(RecallBuilder(cue).limit(20).build())
        texts = [m.text for m in answer.memories]
        if any(want in t for t in texts) or asyncio.get_running_loop().time() >= deadline:
            return texts
        await asyncio.sleep(0.15)


async def test_encode_then_recall_round_trips(it) -> None:
    client, _ = await it.connect_fresh_async()
    async with client:
        response = await client.encode(EncodeBuilder("Ada Lovelace works at Arc Labs").build())
        assert response.memory_id
        texts = await _recall_until(client, "where does Ada work?", "Ada Lovelace")
        assert any("Ada Lovelace" in t for t in texts), texts


async def test_concurrent_encodes_over_one_connection(it) -> None:
    """The claim that justifies the tier: one socket, many writes at once,
    against a real server rather than a mock that answers instantly."""
    client, _ = await it.connect_fresh_async()
    async with client:
        responses = await asyncio.gather(
            *(
                client.encode(EncodeBuilder(f"concurrent fact number {i}").build())
                for i in range(10)
            )
        )
        assert len({r.memory_id for r in responses}) == 10


async def test_inspecting_an_absent_memory_is_refused(it) -> None:
    """The live half of the contract change: Brain answers an id that is not
    there with ``NotFound``, not a success carrying ``found = False``."""
    client, _ = await it.connect_fresh_async()
    async with client:
        with pytest.raises(ServerError) as caught:
            await client.memory_inspect(MemoryInspectRequest(memory_id=99_999_999))
        assert caught.value.category == ErrorCategory.NOT_FOUND


async def test_inspect_returns_the_write_artifacts_for_a_real_memory(it) -> None:
    """The id ENCODE returns goes straight into MEMORY_INSPECT.

    It did not used to: ENCODE answered with a CBOR integer while
    MEMORY_INSPECT took and returned a 16-byte string, so chaining the two
    was refused with ``invalid length 9, expected a byte array of length 16``
    and every caller had to convert. Both are the integer now, and this test
    is the one that would have caught it — the earlier suites called the two
    verbs but never fed one to the other.
    """
    client, _ = await it.connect_fresh_async()
    async with client:
        written = await client.encode(EncodeBuilder("Brain is a memory database").build())
        inspected = await client.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert inspected.memory_id == written.memory_id
        assert inspected.text == "Brain is a memory database"
        # `edges` is the field that replaced the old `found` flag; an absent id
        # is now the refusal the test above asserts, not a success with a
        # falsy flag.
        assert inspected.edges == []


async def test_capabilities_and_ping_answer(it) -> None:
    client, _ = await it.connect_fresh_async()
    async with client:
        pong = await client.ping()
        assert pong.server_timestamp_unix_nanos > 0
        caps = await client.capabilities()
        assert caps.capabilities.vector_dim > 0


async def test_a_pool_spreads_work_over_real_sockets(it) -> None:
    token_client, space = await it.connect_fresh_async()
    await token_client.aclose()
    # Re-mint against the same space so every pool member shares an identity.
    from brain_db_sdk import Auth, ClientConfig

    secret = await asyncio.to_thread(it.mint, space)
    pool = await AsyncPool.connect_with(
        it.data_host, it.data_port, 3, ClientConfig(auth=Auth.token(secret.encode()))
    )
    async with pool:
        assert pool.size() == 3
        responses = await asyncio.gather(
            *(pool.get().encode(EncodeBuilder(f"pooled fact {i}").build()) for i in range(6))
        )
        assert len({r.memory_id for r in responses}) == 6


async def test_retry_passes_a_successful_call_straight_through(it) -> None:
    """Not a fault-injection test — a real server is the wrong place to force
    a transient failure. What this pins is that the wrapper does not disturb
    the happy path, which the offline suite cannot show end to end."""
    client, _ = await it.connect_fresh_async()
    async with client:
        request = EncodeBuilder("retried fact").build()
        response = await with_retry(
            lambda: client.encode(request), RetryPolicy(max_attempts=3, base_delay=0.05)
        )
        assert response.memory_id
