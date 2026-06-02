"""A fixed-size connection pool over :class:`~brain_db_sdk.client.BrainClient`.

Each :class:`BrainClient` is already a *multiplexed* connection — one socket
serving many concurrent requests demultiplexed by ``stream_id`` — so a pool
isn't needed for concurrency. What a pool buys is **socket-level
parallelism**: spreading load across N independent TCP connections (and thus N
server-side connection slots), and isolating a single slow or stalled socket
from the rest of the workload.

:meth:`Pool.connect` opens ``size`` connections up front, each running its own
handshake. :meth:`Pool.get` hands back a :class:`BrainClient` by round-robin;
callers issue verbs on it directly. The same client may be handed to several
threads at once (its verbs are thread-safe over the mux reader).

Deferred (later work): transparent reconnect of a dropped member, health-
checking. :meth:`Pool.close` sends BYE + closes every member; dropping the pool
without ``close`` just drops the clients (each closes its socket).
"""

from __future__ import annotations

import itertools
import threading

from .client import BrainClient, ClientConfig, new_id
from .errors import ProtocolError


class Pool:
    """A fixed-size set of :class:`BrainClient` connections handed out
    round-robin."""

    def __init__(self, clients: list[BrainClient]) -> None:
        self._clients = clients
        self._counter = itertools.count()
        self._lock = threading.Lock()

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        size: int,
        config: ClientConfig | None = None,
    ) -> "Pool":
        """Open ``size`` connections to ``host:port``, each running its own
        handshake, and return the pool. A fresh ``agent_id`` is minted per
        member (so they are distinguishable server-side) unless ``config``
        pins one. Raises :class:`~brain_db_sdk.errors.ProtocolError` if
        ``size < 1``; on a mid-open failure, closes the members already opened
        and re-raises."""
        if size < 1:
            raise ProtocolError("connection pool size must be >= 1")
        template = config or ClientConfig()
        clients: list[BrainClient] = []
        try:
            for _ in range(size):
                cfg = replace_agent_id(template)
                clients.append(BrainClient.connect(host, port, cfg))
        except Exception:
            for client in clients:
                try:
                    client.close()
                except Exception:  # noqa: BLE001 — best-effort cleanup
                    pass
            raise
        return cls(clients)

    def size(self) -> int:
        """The number of pooled connections."""
        return len(self._clients)

    def get(self) -> BrainClient:
        """Borrow the next connection, round-robin. Thread-safe; the returned
        client multiplexes concurrent requests itself."""
        with self._lock:
            idx = next(self._counter) % len(self._clients)
        return self._clients[idx]

    def close(self) -> None:
        """Send BYE and close every pooled connection (best-effort)."""
        for client in self._clients:
            try:
                client.close()
            except Exception:  # noqa: BLE001 — best-effort
                pass

    def __enter__(self) -> "Pool":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def replace_agent_id(template: ClientConfig) -> ClientConfig:
    """Copy ``template`` with a freshly-minted ``agent_id`` so each pooled
    socket is individually identifiable server-side."""
    import dataclasses

    return dataclasses.replace(template, agent_id=new_id())


__all__ = ["Pool"]
