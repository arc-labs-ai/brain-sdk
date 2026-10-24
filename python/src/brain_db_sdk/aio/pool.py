"""A fixed-size connection pool over :class:`AsyncBrainClient`.

Each :class:`AsyncBrainClient` is already a *multiplexed* connection — one
socket serving many concurrent requests demultiplexed by ``stream_id`` — so a
pool isn't needed for concurrency. What a pool buys is **socket-level
parallelism**: spreading load across N independent TCP connections (and thus N
server-side connection slots), and isolating a single slow or stalled socket
from the rest of the workload.

:meth:`AsyncPool.connect` opens ``size`` connections up front, each running its
own handshake. :meth:`AsyncPool.get` hands back a client by round-robin;
callers issue verbs on it directly. The same client may be handed to several
tasks at once (its verbs multiplex over the one reader task).

Like the client it pools, a pool belongs to the event loop it was opened on.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
from typing import TypeVar

from brain_db_sdk.client import Auth, ClientConfig
from brain_db_sdk.errors import ProtocolError

from .client import AsyncBrainClient

# Stands in for `typing.Self`, which is 3.11+; requires-python here is >=3.10.
_SelfPool = TypeVar("_SelfPool", bound="AsyncPool")


class AsyncPool:
    """A fixed-size set of :class:`AsyncBrainClient` connections handed out
    round-robin."""

    def __init__(
        self,
        clients: list[AsyncBrainClient],
        host: str | None = None,
        port: int | None = None,
        config: ClientConfig | None = None,
    ) -> None:
        self._clients = clients
        self._counter = itertools.count()
        # Retained so :meth:`get_healthy` can dial a replacement member.
        # Optional to keep the plain ``AsyncPool(clients)`` call working; a pool
        # built that way simply has no reconnect target.
        self._host = host
        self._port = port
        self._config = config
        self._reconnect_locks = [asyncio.Lock() for _ in clients]

    @classmethod
    async def connect(
        cls,
        host: str,
        port: int,
        size: int,
        auth: Auth,
    ) -> AsyncPool:
        """Open ``size`` connections to ``host:port`` with the given credential
        and default transport settings, each running its own handshake, and
        return the pool. For full control over the configuration, use
        :meth:`connect_with`."""
        return await cls.connect_with(host, port, size, ClientConfig(auth=auth))

    @classmethod
    async def connect_with(
        cls,
        host: str,
        port: int,
        size: int,
        config: ClientConfig,
    ) -> AsyncPool:
        """Open ``size`` connections to ``host:port`` from an explicit
        configuration template and return the pool.

        The handshakes run **concurrently**, which is the whole reason to pool
        asynchronously: opening eight connections costs one round trip, not
        eight. All members share the template's credential, so the server binds
        them to the same space; they remain individually identifiable by
        connection id.

        Raises :class:`~brain_db_sdk.errors.ProtocolError` if ``size < 1``. If
        any member fails to open, the ones that succeeded are closed before the
        failure propagates — a partially-built pool is never leaked, and a
        caller retrying in a loop does not accumulate sockets.
        """
        if size < 1:
            raise ProtocolError("connection pool size must be >= 1")
        results = await asyncio.gather(
            *(AsyncBrainClient.connect_with(host, port, config) for _ in range(size)),
            return_exceptions=True,
        )
        clients = [r for r in results if isinstance(r, AsyncBrainClient)]
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            # `gather` lets every dial finish, so some may have succeeded after
            # another failed; close those rather than dropping live sockets.
            await _close_all(clients)
            raise failures[0]
        return cls(clients, host, port, config)

    def size(self) -> int:
        """The number of pooled connections."""
        return len(self._clients)

    def get(self) -> AsyncBrainClient:
        """Borrow the next connection, round-robin.

        Not a coroutine: handing out an already-open client involves no I/O,
        and making it one would only add a suspension point for callers to
        await for nothing. The returned client multiplexes concurrent requests
        itself, so several tasks holding the same one is the normal case.
        """
        return self._clients[next(self._counter) % len(self._clients)]

    async def get_healthy(self) -> AsyncBrainClient:
        """Borrow the next connection, reconnecting it first if its socket has
        died.

        A pooled member outlives any single request, so a server restart leaves
        every borrower holding the same dead socket until the process is
        bounced. This checks :attr:`AsyncBrainClient.is_closed` and dials a
        replacement in place. Requests already in flight on the old connection
        fail as before; new ones get the fresh socket.

        Concurrent callers landing on the same dead slot share one reconnect —
        the per-slot lock is what stops N waiting tasks from opening N sockets
        and discarding N-1. Falls back to :meth:`get` when the pool was
        constructed without connect parameters, which has nothing to reconnect
        to.
        """
        idx = next(self._counter) % len(self._clients)
        client = self._clients[idx]
        if not client.is_closed:
            return client
        if self._host is None or self._port is None or self._config is None:
            return client
        async with self._reconnect_locks[idx]:
            # Another task may have reconnected while we waited.
            client = self._clients[idx]
            if not client.is_closed:
                return client
            fresh = await AsyncBrainClient.connect_with(self._host, self._port, self._config)
            self._clients[idx] = fresh
            return fresh

    async def aclose(self) -> None:
        """Send BYE and close every pooled connection (best-effort, in
        parallel)."""
        await _close_all(self._clients)

    async def __aenter__(self: _SelfPool) -> _SelfPool:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


async def _close_all(clients: list[AsyncBrainClient]) -> None:
    """Close every client, tolerating individual failures.

    ``gather`` rather than a loop so one member blocked in BYE does not hold up
    the rest; the suppression is because these are sockets being discarded
    either way and a teardown error is not separately actionable.
    """

    async def _close(client: AsyncBrainClient) -> None:
        with contextlib.suppress(Exception):
            await client.aclose()

    await asyncio.gather(*(_close(c) for c in clients))


__all__ = ["AsyncPool"]
