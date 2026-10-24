"""The asyncio tier: the same Brain wire protocol, awaited.

:class:`~brain_db_sdk.aio.client.AsyncBrainClient` is the asyncio twin of
:class:`~brain_db_sdk.client.BrainClient` — the same 72 verbs with the same
signatures, every one a coroutine. It speaks the same BRN0 frames over the same
multiplexed connection; what changes is that a request in flight suspends its
task rather than blocking a thread, so one connection can carry thousands of
concurrent requests on a single OS thread.

Nothing below the transport is duplicated to get there. The frame codec, the
CBOR payload types, the request builders in :mod:`brain_db_sdk.verbs`, the
error taxonomy, the retry policy and its backoff curve, and the
:class:`~brain_db_sdk.client.Auth` / :class:`~brain_db_sdk.client.ClientConfig`
/ :class:`~brain_db_sdk.client.ConnectionInfo` configuration types are all the
same objects the synchronous tier uses. Only *how the bytes are awaited*
differs:

=========================  ==========================  ==========================
concern                    sync                        asyncio
=========================  ==========================  ==========================
demultiplexing             reader **thread**           reader **task**
per-stream handoff         :class:`queue.Queue`        :class:`asyncio.Queue`
route-table guard          :class:`threading.Lock`     the loop itself
write serialization        :class:`threading.Lock`     :class:`asyncio.Lock`
request deadline           ``Queue.get(timeout=…)``    :func:`asyncio.wait_for`
teardown                   ``close()``                 ``await aclose()``
=========================  ==========================  ==========================

**Pick one tier per program, not per call.** Reaching for the sync client
inside a coroutine blocks the loop; wrapping this one in ``asyncio.run`` from
synchronous code opens and tears down a loop per call and raises outright if a
loop is already running (a FastAPI handler, a notebook). The clients are
cheap to hold open; the loop is not.

A connection belongs to the event loop it was opened on. That binding is
checked on every call rather than left to chance, because a connection driven
from a second loop does not raise — it waits forever on a future nothing will
complete.

    import asyncio
    from brain_db_sdk import Auth, EncodeBuilder, RecallBuilder
    from brain_db_sdk.aio import AsyncBrainClient

    async def main() -> None:
        async with await AsyncBrainClient.connect(
            "127.0.0.1", 18080, Auth.token(b"brain_...")
        ) as client:
            # Independent writes cost one round trip, not three.
            await asyncio.gather(
                client.encode(EncodeBuilder("Ada works at Arc Labs").build()),
                client.encode(EncodeBuilder("Arc Labs builds Brain").build()),
                client.encode(EncodeBuilder("Brain is a memory database").build()),
            )
            answer = await client.recall(RecallBuilder("where does Ada work?").build())
            for memory in answer.memories:
                print(memory.text)

    asyncio.run(main())
"""

from __future__ import annotations

from .client import AsyncBrainClient
from .mux import AsyncMuxConnection, AsyncSubscription
from .pool import AsyncPool
from .retry import RetryPolicy, with_retry
from .transport import read_frame, write_frame

__all__ = [
    "AsyncBrainClient",
    "AsyncMuxConnection",
    "AsyncPool",
    "AsyncSubscription",
    "RetryPolicy",
    "read_frame",
    "with_retry",
    "write_frame",
]
