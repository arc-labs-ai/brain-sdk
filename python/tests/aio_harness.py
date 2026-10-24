"""A scripted BRN0 server on a real socket, for the offline ``aio`` suites.

Needs no server, no network and no environment — unlike the integration
fixtures in ``conftest.py``, these always run.

A real :func:`asyncio.start_server` on ``127.0.0.1:0`` rather than an in-memory
double. The point of the ``aio`` tests is the transport — partial reads, EOF
mid-frame, backpressure, one event loop demultiplexing one socket — and a fake
stream pair would be testing the fake.

Importable from the feature folders because ``pythonpath = ["tests"]`` is set
in ``pyproject.toml``; the folders themselves deliberately have no
``__init__.py`` (see the pytest config), so this is how they share code.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Optional

from brain_db_sdk.aio.transport import read_frame as aio_read_frame
from brain_db_sdk.aio.transport import write_frame as aio_write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthOkPayload,
    AuthPayload,
    EncodeResponse,
    ErrorCategory,
    ErrorResponse,
    HelloPayload,
    MemoryKind,
    ServerFeatures,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

MOCK_SPACE_ID = b"\x22" * 16
MOCK_CONNECTION_ID = b"\xab" * 16
# Small enough that a test can exceed it without allocating anything large.
MOCK_MAX_PAYLOAD = 1 << 20
# `ErrorCode` only names the handful of codes the client branches on; the rest
# are plain wire integers, so the mock uses the server's real values rather
# than inventing names. 0x0050 is MemoryNotFound (brain-protocol
# `shared/enums.rs`), which `memory_inspect` now returns for an absent id.
MOCK_INTERNAL_CODE = 0x0001
MEMORY_NOT_FOUND_CODE = 0x0050


class MockSession:
    """One accepted connection, scripted by a test's handler coroutine."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._buf = bytearray()
        self.hello: Optional[HelloPayload] = None
        self.auth: Optional[AuthPayload] = None

    async def read(self) -> Frame:
        """Read one whole frame the client sent."""
        return await aio_read_frame(self._reader, self._buf)

    async def write(
        self,
        opcode: Opcode,
        stream_id: int,
        payload: bytes = b"",
        flags: int = FLAG_EOS,
    ) -> None:
        """Write one frame back."""
        await aio_write_frame(
            self._writer,
            Frame(opcode=int(opcode), flags=flags, stream_id=stream_id, payload=payload),
        )

    async def write_raw(self, data: bytes) -> None:
        """Write arbitrary bytes, for tests that need to split or corrupt a
        frame rather than send a well-formed one."""
        self._writer.write(data)
        await self._writer.drain()

    async def error(
        self,
        stream_id: int,
        code: int = MOCK_INTERNAL_CODE,
        category: int = ErrorCategory.INTERNAL,
        message: str = "mock failure",
        retry_after_ms: Optional[int] = None,
    ) -> None:
        """Answer a stream with a structured ERROR frame."""
        await self.write(
            Opcode.ERROR,
            stream_id,
            encode_payload(
                ErrorResponse(
                    code=code,
                    category=category,
                    message=message,
                    details=None,
                    retry_after_ms=retry_after_ms,
                )
            ),
        )

    async def handshake(
        self,
        chosen_version: int = 1,
        max_payload_size: int = MOCK_MAX_PAYLOAD,
        namespace: str = "",
    ) -> None:
        """Play the server half of HELLO/WELCOME + AUTH/AUTH_OK."""
        hello_frame = await self.read()
        self.hello = decode_payload(HelloPayload, hello_frame.payload)
        await self.write(
            Opcode.WELCOME,
            0,
            encode_payload(
                WelcomePayload(
                    server_id="mock-brain",
                    chosen_version=chosen_version,
                    connection_id=MOCK_CONNECTION_ID,
                    capabilities=self.hello.capabilities,
                    server_features=ServerFeatures(
                        max_payload_size=max_payload_size,
                        max_concurrent_streams=256,
                        idle_timeout_seconds=300,
                        auth_methods=[],
                    ),
                )
            ),
        )
        auth_frame = await self.read()
        self.auth = decode_payload(AuthPayload, auth_frame.payload)
        await self.write(
            Opcode.AUTH_OK,
            0,
            encode_payload(
                AuthOkPayload(
                    space_id=MOCK_SPACE_ID,
                    bound_shard_id=0,
                    permissions=SpacePermissions(
                        can_encode=True,
                        can_recall=True,
                        can_plan=True,
                        can_reason=True,
                        can_forget=True,
                        can_admin=False,
                    ),
                    namespace=namespace,
                    server_time_unix_nanos=1,
                )
            ),
        )

    async def close(self) -> None:
        """Drop the connection from the server side."""
        self._writer.close()
        with contextlib.suppress(Exception):
            await self._writer.wait_closed()


def mock_encode_response(memory_id: int = 1) -> bytes:
    """A plausible ENCODE_RESP payload — the stock answer for write tests."""
    return encode_payload(
        EncodeResponse(
            memory_id=memory_id,
            was_deduplicated=False,
            salience=0.5,
            auto_edges_added=0,
            lsn=1,
            space_id=MOCK_SPACE_ID,
            session_id=0,
            kind=MemoryKind.SEMANTIC,
            created_at_unix_nanos=1,
            edges_out_count=0,
            embedding_model_fp=b"\x00" * 16,
            pending_stages=[],
            has_active_schema=True,
        )
    )


class MockBrain:
    """A scripted BRN0 server on an ephemeral loopback port.

    Used as an async context manager; ``host`` / ``port`` are the address to
    dial. ``handler`` is run once per accepted connection and owns the whole
    conversation, so a test says exactly what the server does and in what
    order — including the orders a real server would never choose, which is
    where the interesting failures live.
    """

    def __init__(self, handler: Callable[[MockSession], Awaitable[None]]) -> None:
        self._handler = handler
        self._server: Optional[asyncio.AbstractServer] = None
        self._tasks: set[asyncio.Task[None]] = set()
        self.sessions: list[MockSession] = []
        self.host = "127.0.0.1"
        self.port = 0

    async def __aenter__(self) -> MockBrain:
        self._server = await asyncio.start_server(self._accept, self.host, 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        assert self._server is not None
        self._server.close()
        # Order matters, and getting it wrong hangs rather than fails.
        # `Server.wait_closed` does not return until every *connection* the
        # server accepted has finished, so the handlers have to be stopped and
        # their sockets closed first — otherwise a test whose script ends
        # mid-conversation waits forever on its own mock.
        for task in list(self._tasks):
            task.cancel()
        # Gathered rather than left pending: an un-awaited cancelled task makes
        # the loop emit "Task was destroyed but it is pending", which turns
        # into noise in every later test rather than a failure in this one.
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for session in self.sessions:
            await session.close()
        with contextlib.suppress(Exception):
            await self._server.wait_closed()

    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        session = MockSession(reader, writer)
        self.sessions.append(session)
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        try:
            await self._handler(session)
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
            # The client hanging up mid-script is the expected end of most of
            # these conversations, not a test failure.
            pass
        finally:
            if task is not None:
                self._tasks.discard(task)
            # The server half of the socket is this coroutine's to close. A
            # handler that simply returns leaves the connection open, and the
            # server then never finishes closing.
            await session.close()


async def serve_handshake_then(
    session: MockSession,
    responder: Optional[Callable[[MockSession, Frame], Awaitable[None]]] = None,
) -> None:
    """Handshake, then answer each request frame with ``responder`` until the
    client goes away. The shape most tests want."""
    await session.handshake()
    while True:
        frame = await session.read()
        if frame.opcode == int(Opcode.BYE):
            return
        if responder is not None:
            await responder(session, frame)
