"""The asyncio connection pool.

A pooled client already multiplexes, so the pool is not about concurrency — it
is about spreading load over independent sockets and replacing one that dies.
What is worth pinning is therefore: that opening N connections costs one round
trip rather than N, that a partial failure leaves nothing open, and that a dead
member is replaced exactly once however many tasks notice at the same moment.
"""

from __future__ import annotations

import asyncio

import pytest
from aio_harness import MockBrain, MockSession, mock_encode_response

from brain_db_sdk.aio import AsyncPool
from brain_db_sdk.client import Auth, ClientConfig
from brain_db_sdk.errors import ProtocolError, VersionMismatch
from brain_db_sdk.verbs import EncodeBuilder
from brain_db_sdk.wire.opcode import Opcode

AUTH = Auth.token(b"brain_test")


async def _serve(session: MockSession) -> None:
    await session.handshake()
    while True:
        frame = await session.read()
        if frame.opcode == int(Opcode.BYE):
            return
        await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())


async def test_a_pool_opens_every_member() -> None:
    async with MockBrain(_serve) as server:
        pool = await AsyncPool.connect(server.host, server.port, 4, AUTH)
        try:
            assert pool.size() == 4
            assert len(server.sessions) == 4
            assert len({id(pool.get()) for _ in range(4)}) == 4
        finally:
            await pool.aclose()


async def test_the_handshakes_run_concurrently() -> None:
    """Eight connections should cost about one slow handshake, not eight.

    The mock delays each handshake by 100ms; serially that is 800ms, which the
    budget below excludes by a wide margin — wide enough that a loaded CI box
    does not make it flaky.
    """

    async def slow(session: MockSession) -> None:
        await asyncio.sleep(0.1)
        await _serve(session)

    async with MockBrain(slow) as server:
        started = asyncio.get_running_loop().time()
        pool = await AsyncPool.connect(server.host, server.port, 8, AUTH)
        elapsed = asyncio.get_running_loop().time() - started
        try:
            assert pool.size() == 8
            assert elapsed < 0.5, f"handshakes appear to be serial ({elapsed:.2f}s for 8)"
        finally:
            await pool.aclose()


async def test_a_pool_smaller_than_one_is_refused() -> None:
    for size in (0, -1):
        with pytest.raises(ProtocolError, match="size must be >= 1"):
            await AsyncPool.connect("127.0.0.1", 1, size, AUTH)


async def test_a_partial_failure_closes_what_did_open() -> None:
    """``gather`` lets every dial finish, so some members may connect after
    another has already failed. Dropping the pool on the floor there would
    leak those sockets and their reader tasks."""
    attempt = 0

    async def flaky(session: MockSession) -> None:
        nonlocal attempt
        attempt += 1
        # The third connection is refused at version negotiation; the rest
        # complete normally.
        if attempt == 3:
            await session.handshake(chosen_version=99)
            await asyncio.sleep(0.5)
            return
        await _serve(session)

    before = len(asyncio.all_tasks())
    async with MockBrain(flaky) as server:
        with pytest.raises(VersionMismatch):
            await AsyncPool.connect(server.host, server.port, 5, AUTH)
        await asyncio.sleep(0.05)
        assert len(asyncio.all_tasks()) - before <= 1, (
            "a partially-built pool left reader tasks running"
        )


async def test_members_are_handed_out_round_robin() -> None:
    async with MockBrain(_serve) as server:
        pool = await AsyncPool.connect(server.host, server.port, 3, AUTH)
        try:
            order = [id(pool.get()) for _ in range(6)]
            assert order[:3] == order[3:], "the second lap should repeat the first"
            assert len(set(order)) == 3
        finally:
            await pool.aclose()


async def test_every_member_actually_serves_requests() -> None:
    async with MockBrain(_serve) as server:
        pool = await AsyncPool.connect(server.host, server.port, 3, AUTH)
        try:
            responses = await asyncio.gather(
                *(pool.get().encode(EncodeBuilder(f"m{i}").build()) for i in range(6))
            )
            assert len(responses) == 6
        finally:
            await pool.aclose()


async def test_get_healthy_replaces_a_dead_member() -> None:
    """A server restart otherwise leaves every borrower holding the same dead
    socket until the process is bounced."""
    kill_first = True

    async def sometimes_dies(session: MockSession) -> None:
        nonlocal kill_first
        await session.handshake()
        if kill_first:
            kill_first = False
            await session.close()
            return
        while True:
            frame = await session.read()
            if frame.opcode == int(Opcode.BYE):
                return
            await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())

    async with MockBrain(sometimes_dies) as server:
        pool = await AsyncPool.connect(server.host, server.port, 1, AUTH)
        try:
            original = pool.get()
            for _ in range(100):
                if original.is_closed:
                    break
                await asyncio.sleep(0.01)
            assert original.is_closed

            replacement = await pool.get_healthy()
            assert replacement is not original
            assert not replacement.is_closed
            assert (await replacement.encode(EncodeBuilder("after").build())).memory_id == 1
        finally:
            await pool.aclose()


async def test_concurrent_callers_share_one_reconnect() -> None:
    """Ten tasks finding the same dead slot must open one replacement, not ten
    — the thundering herd a restart would otherwise produce."""
    dialled = 0
    kill_first = True

    async def counting(session: MockSession) -> None:
        nonlocal dialled, kill_first
        dialled += 1
        await session.handshake()
        if kill_first:
            kill_first = False
            await session.close()
            return
        while True:
            frame = await session.read()
            if frame.opcode == int(Opcode.BYE):
                return
            await session.write(Opcode.ENCODE_RESP, frame.stream_id, mock_encode_response())

    async with MockBrain(counting) as server:
        pool = await AsyncPool.connect(server.host, server.port, 1, AUTH)
        try:
            for _ in range(100):
                if pool.get().is_closed:
                    break
                await asyncio.sleep(0.01)
            dialled_before = dialled

            clients = await asyncio.gather(*(pool.get_healthy() for _ in range(10)))
            assert len({id(c) for c in clients}) == 1, "the herd opened more than one socket"
            assert dialled - dialled_before == 1
        finally:
            await pool.aclose()


async def test_a_pool_without_connect_parameters_cannot_reconnect() -> None:
    """``AsyncPool(clients)`` has no dial target; it hands the dead member back
    rather than pretending to heal."""
    from brain_db_sdk.aio import AsyncBrainClient

    async def dies(session: MockSession) -> None:
        await session.handshake()
        await session.close()

    async with MockBrain(dies) as server:
        client = await AsyncBrainClient.connect_with(
            server.host, server.port, ClientConfig(auth=AUTH)
        )
        pool = AsyncPool([client])
        for _ in range(100):
            if client.is_closed:
                break
            await asyncio.sleep(0.01)
        assert await pool.get_healthy() is client


async def test_closing_the_pool_closes_every_member() -> None:
    async with MockBrain(_serve) as server:
        pool = await AsyncPool.connect(server.host, server.port, 3, AUTH)
        members = [pool.get() for _ in range(3)]
        await pool.aclose()
        assert all(m.is_closed for m in members)


async def test_the_async_context_manager_closes_the_pool() -> None:
    async with MockBrain(_serve) as server:
        async with await AsyncPool.connect(server.host, server.port, 2, AUTH) as pool:
            members = [pool.get() for _ in range(2)]
            assert not any(m.is_closed for m in members)
        assert all(m.is_closed for m in members)
