"""Cross-verb flows against a real server.

Every other suite tests one verb at a time: a request goes out, a response is
checked, done. That is why the `memory_id` split survived so long — ENCODE
answered with an integer and MEMORY_INSPECT wanted sixteen bytes, and no test
ever took the first verb's answer and handed it to the second.

So these tests are organised around **handoffs**, not verbs. Each one is a
short journey where the output of one call is the input of the next, with no
conversion in between. The conversion is the thing being tested: if a caller
has to reshape a value to pass it along, the two ops do not actually compose,
and that is a defect however well each one behaves alone.

Three properties make a flow worth having here:

* It passes an identifier, cursor or handle **between** ops.
* It crosses a subsystem boundary — write path to read path, memory to graph,
  wire to storage and back.
* It asserts the *absence* of something after a mutation, not only its
  presence. "The delete worked" is the half of a lifecycle that silently rots.

Gated on `BRAIN_SDK_IT_DATA` like every integration suite; the default offline
run skips them. A mock cannot stand in here — it would agree with whatever the
client sent, which is precisely the agreement that was wrong.
"""

from __future__ import annotations

import asyncio

import pytest

from brain_db_sdk.aio import AsyncBrainClient
from brain_db_sdk.client import new_id
from brain_db_sdk.errors import ServerError
from brain_db_sdk.verbs import EncodeBuilder, ForgetBuilder, RecallBuilder
from brain_db_sdk.wire.types import (
    EdgeDirectionWire,
    EdgeKind,
    ErrorCategory,
    LinkRequest,
    MemoryInspectRequest,
    MemoryListRequest,
    SessionCreateRequest,
    SessionDeleteRequest,
    SessionListRequest,
    SubscribeRequest,
    SubscriptionFilter,
    TxnAbortRequest,
    TxnBeginRequest,
    TxnCommitRequest,
    UnlinkRequest,
)

VISIBILITY_TIMEOUT_S = 8.0


def _list_request(*, limit: int = 50) -> MemoryListRequest:
    """A plain enumeration of the caller's space, newest first."""
    return MemoryListRequest(
        sort=0,
        dir=0,
        limit=limit,
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


def _edges_to(
    inspected: object, peer: int, kind: int, direction: int = EdgeDirectionWire.OUTGOING
) -> list:
    """The edges of one kind between two memories, in one direction.

    Filtering by kind is not tidiness. A write has a synchronous half and an
    asynchronous one, and the async half derives its own edges — `FOLLOWED_BY`
    between consecutive writes, `SIMILAR_TO` between related ones. Those land
    between the same two memories, after the ENCODE that returned, on no
    schedule a test controls. An assertion that counts *all* edges to a peer is
    therefore counting a race: it passed 19 times in 20 here and failed the
    twentieth, when derivation happened to land first.

    What a test can assert deterministically is the edge it asked for.
    """
    return [
        e
        for e in inspected.edges  # type: ignore[attr-defined]
        if e.peer == peer and e.direction == direction and e.kind == kind
    ]


async def _recall_until(
    client: AsyncBrainClient, cue: str, want: str, *, timeout: float = VISIBILITY_TIMEOUT_S
) -> list[str]:
    """Poll RECALL until `want` appears, or give up.

    ENCODE is durable the instant it acks, but the semantic index becomes
    *searchable* a beat later. Without the poll a read-your-writes assertion is
    a race dressed up as a test.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    texts: list[str] = []
    while True:
        answer = await client.recall(RecallBuilder(cue).limit(25).build())
        texts = [m.text for m in answer.memories]
        if any(want in t for t in texts) or loop.time() >= deadline:
            return texts
        await asyncio.sleep(0.15)


# ---------------------------------------------------------------------------
# The memory lifecycle: write, find, inspect, forget, confirm gone.
# ---------------------------------------------------------------------------


async def test_a_memory_can_be_written_found_inspected_and_forgotten(it) -> None:
    """The whole arc on one id, handed from each call to the next.

    This is the flow that would have caught the `memory_id` split: the id comes
    from ENCODE and is passed, untouched, to MEMORY_INSPECT and FORGET. Three
    ops, three subsystems — writer, artifact store, tombstone path — one value.
    """
    client, _ = await it.connect_fresh_async()
    async with client:
        written = await client.encode(EncodeBuilder("the kettle whistled at dawn").build())
        assert written.memory_id

        texts = await _recall_until(client, "what whistled?", "kettle")
        assert any("kettle" in t for t in texts), texts

        listed = await client.memory_list(_list_request())
        assert written.memory_id in [i.memory_id for i in listed], (
            "the id MEMORY_LIST reports must be the id ENCODE returned"
        )

        inspected = await client.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert inspected.memory_id == written.memory_id
        assert inspected.text == "the kettle whistled at dawn"

        forgotten = await client.forget(ForgetBuilder(written.memory_id).hard().build())
        assert forgotten.memory_id == written.memory_id

        # The half that rots silently: confirm it is actually gone.
        with pytest.raises(ServerError) as caught:
            await client.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert caught.value.category == ErrorCategory.NOT_FOUND

        after = await client.memory_list(_list_request())
        assert written.memory_id not in [i.memory_id for i in after]


async def test_a_second_forget_is_idempotent(it) -> None:
    """FORGET is lenient by design — a retry after a dropped response must not
    look like a new failure, which is what makes the retry helper safe to wrap
    around it."""
    client, _ = await it.connect_fresh_async()
    async with client:
        written = await client.encode(EncodeBuilder("ephemeral note").build())
        first = await client.forget(ForgetBuilder(written.memory_id).hard().build())
        second = await client.forget(ForgetBuilder(written.memory_id).hard().build())
        assert first.was_already_forgotten is False
        assert second.was_already_forgotten is True


# ---------------------------------------------------------------------------
# Edges: assert one, read it back, remove it, confirm.
# ---------------------------------------------------------------------------


async def test_an_edge_between_two_memories_is_readable_and_removable(it) -> None:
    """LINK was write-only over the wire until MEMORY_INSPECT grew `edges`:
    a client could assert an edge and had no operation that could read it back.

    The flow is what proves the pair now composes — two ids from ENCODE into
    LINK, then the same ids back out of MEMORY_INSPECT.
    """
    client, _ = await it.connect_fresh_async()
    async with client:
        a = await client.encode(EncodeBuilder("the power cut out").build())
        b = await client.encode(EncodeBuilder("the lights went off").build())

        linked = await client.link(
            LinkRequest(
                source=a.memory_id,
                target=b.memory_id,
                kind=EdgeKind.CAUSED,
                weight=0.9,
                request_id=new_id(),
                txn_id=None,
            )
        )
        assert linked.already_existed is False
        assert (linked.source, linked.target) == (a.memory_id, b.memory_id)

        src = await client.memory_inspect(MemoryInspectRequest(memory_id=a.memory_id))
        assert _edges_to(src, b.memory_id, EdgeKind.CAUSED), (
            f"the edge LINK created is not in the source's outgoing edges: {src.edges}"
        )

        # The other end sees it too, as an incoming edge.
        dst = await client.memory_inspect(MemoryInspectRequest(memory_id=b.memory_id))
        assert _edges_to(dst, a.memory_id, EdgeKind.CAUSED, EdgeDirectionWire.INCOMING), dst.edges

        removed = await client.unlink(
            UnlinkRequest(
                source=a.memory_id,
                target=b.memory_id,
                kind=EdgeKind.CAUSED,
                request_id=new_id(),
                txn_id=None,
            )
        )
        assert removed.removed is True

        after = await client.memory_inspect(MemoryInspectRequest(memory_id=a.memory_id))
        assert not _edges_to(after, b.memory_id, EdgeKind.CAUSED), "the edge survived UNLINK"


async def test_relinking_the_same_pair_reweights_rather_than_duplicates(it) -> None:
    """LINK is an upsert on `(source, kind, target)`. A second call must report
    the edge already existed, not quietly produce a parallel one."""
    client, _ = await it.connect_fresh_async()
    async with client:
        a = await client.encode(EncodeBuilder("first observation").build())
        b = await client.encode(EncodeBuilder("second observation").build())

        def link(weight: float) -> LinkRequest:
            return LinkRequest(
                source=a.memory_id,
                target=b.memory_id,
                kind=EdgeKind.SUPPORTS,
                weight=weight,
                request_id=new_id(),
                txn_id=None,
            )

        assert (await client.link(link(0.2))).already_existed is False
        assert (await client.link(link(0.8))).already_existed is True

        src = await client.memory_inspect(MemoryInspectRequest(memory_id=a.memory_id))
        matching = _edges_to(src, b.memory_id, EdgeKind.SUPPORTS)
        assert len(matching) == 1, f"re-linking duplicated the edge: {matching}"
        assert matching[0].weight == pytest.approx(0.8), (
            "the second LINK must reweight the existing edge, not leave the first weight"
        )


# ---------------------------------------------------------------------------
# Sessions: a grouping that memories land in and leave with.
# ---------------------------------------------------------------------------


async def test_a_session_scopes_its_memories_and_deleting_it_takes_them(it) -> None:
    """Create a session, write into it, then delete it and watch the memory go
    with it — the write path, the session registry and the cascade, in one
    pass."""
    client, _ = await it.connect_fresh_async()
    async with client:
        session_id = 4242
        created = await client.create_session(
            SessionCreateRequest(session_id=session_id, request_id=new_id(), title="a flow")
        )
        assert created.session_id == session_id

        written = await client.encode(
            EncodeBuilder("a note inside the session").session(session_id).build()
        )

        inspected = await client.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert inspected.memory_id == written.memory_id

        sessions = await client.list_sessions(SessionListRequest(limit=50))
        assert session_id in [s.session_id for s in sessions.sessions], (
            "SESSION_LIST must report the session SESSION_CREATE just made"
        )

        deleted = await client.delete_session(
            SessionDeleteRequest(session_id=session_id, request_id=new_id(), hard=True)
        )
        assert deleted.session_id == session_id

        with pytest.raises(ServerError) as caught:
            await client.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert caught.value.category == ErrorCategory.NOT_FOUND


# ---------------------------------------------------------------------------
# Transactions: the tier HTTP cannot reach.
# ---------------------------------------------------------------------------


async def test_a_committed_transaction_is_visible_and_an_aborted_one_is_not(it) -> None:
    """Both halves in one flow, because only the pair says anything: a commit
    that lands proves nothing if an abort also lands."""
    client, _ = await it.connect_fresh_async()
    async with client:
        committed_txn = new_id()
        await client.txn_begin(TxnBeginRequest(txn_id=committed_txn, timeout_seconds=30))
        kept = EncodeBuilder("this one is committed").build()
        kept.txn_id = committed_txn
        kept_resp = await client.encode(kept)
        await client.txn_commit(TxnCommitRequest(txn_id=committed_txn))

        aborted_txn = new_id()
        await client.txn_begin(TxnBeginRequest(txn_id=aborted_txn, timeout_seconds=30))
        dropped = EncodeBuilder("this one is abandoned").build()
        dropped.txn_id = aborted_txn
        dropped_resp = await client.encode(dropped)
        await client.txn_abort(TxnAbortRequest(txn_id=aborted_txn))

        inspected = await client.memory_inspect(MemoryInspectRequest(memory_id=kept_resp.memory_id))
        assert inspected.memory_id == kept_resp.memory_id

        with pytest.raises(ServerError) as caught:
            await client.memory_inspect(MemoryInspectRequest(memory_id=dropped_resp.memory_id))
        assert caught.value.category == ErrorCategory.NOT_FOUND, (
            "an aborted transaction's write must not be readable"
        )


# ---------------------------------------------------------------------------
# Subscriptions: a write made after the subscription opens must reach it.
# ---------------------------------------------------------------------------


async def test_a_write_reaches_an_open_subscription(it) -> None:
    """The change feed is the one read path that is pushed rather than polled,
    so it is the one place a write can be lost without any read failing."""
    client, _ = await it.connect_fresh_async()
    async with client:
        sub = await client.subscribe(
            SubscribeRequest(
                # `spaces` must name the connection's own effective space — the
                # server refuses a subscription that reaches wider, which is
                # what makes the feed safe to expose per-tenant. `space_id` on
                # the client is the resolved id the handshake handed back, so
                # there is nothing to derive here.
                filter=SubscriptionFilter(
                    session_filter=None,
                    kinds=None,
                    similar_to=None,
                    spaces=[client.space_id],
                ),
                include_history=False,
                from_lsn=None,
                max_inflight=16,
            )
        )
        try:
            written = await client.encode(EncodeBuilder("an event worth hearing").build())

            async def first_matching() -> int | None:
                async for event in sub:
                    if event.memory_id == written.memory_id:
                        return event.memory_id
                return None

            seen = await asyncio.wait_for(first_matching(), timeout=VISIBILITY_TIMEOUT_S)
            assert seen == written.memory_id, "the subscription must report the id ENCODE returned"
        finally:
            await sub.aclose()


# ---------------------------------------------------------------------------
# Tenancy: one space's memories must not surface in another's.
# ---------------------------------------------------------------------------


async def test_one_space_cannot_see_another_space_s_memory(it) -> None:
    """Isolation is a property of a *pair* of connections, so it cannot be
    tested from one. The absent-id answer is deliberately the same as a
    not-yours answer, so the verb is not an existence oracle."""
    first, _ = await it.connect_fresh_async()
    second, _ = await it.connect_fresh_async()
    async with first, second:
        written = await first.encode(EncodeBuilder("a private matter").build())

        assert (
            await first.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        ).memory_id == written.memory_id

        with pytest.raises(ServerError) as caught:
            await second.memory_inspect(MemoryInspectRequest(memory_id=written.memory_id))
        assert caught.value.category == ErrorCategory.NOT_FOUND, (
            "another space's memory must read as absent, not as forbidden"
        )

        listed = await second.memory_list(_list_request())
        assert written.memory_id not in [i.memory_id for i in listed]


# ---------------------------------------------------------------------------
# Pagination: a cursor from one page must drive the next.
# ---------------------------------------------------------------------------


async def test_a_list_cursor_carries_from_one_page_to_the_next(it) -> None:
    """A cursor is a handoff too, and an opaque one — the only thing that can
    check it is feeding it back."""
    client, _ = await it.connect_fresh_async()
    async with client:
        written = [
            (await client.encode(EncodeBuilder(f"page item {i}").build())).memory_id
            for i in range(5)
        ]

        first = (await client.memory_list_frames(_list_request(limit=2)))[-1]
        assert len(first.items) <= 2
        assert first.next_cursor, "a truncated listing must hand back a cursor"

        follow = _list_request(limit=2)
        follow.cursor = first.next_cursor
        second = (await client.memory_list_frames(follow))[-1]

        page_one = [i.memory_id for i in first.items]
        page_two = [i.memory_id for i in second.items]
        assert page_one, "the first page is empty"
        assert page_two, "the cursor returned nothing"
        assert not set(page_one) & set(page_two), (
            f"the cursor replayed rows from the first page: {set(page_one) & set(page_two)}"
        )
        assert set(page_one + page_two) <= set(written), (
            "paging returned ids this test never wrote, so the listing is not scoped "
            "to the caller's space"
        )
