"""Values that pass from one op to another must have one shape.

The flow suite (`tests/flows`) proves composition against a real server, which
is the only place semantics can be checked. This is its cheap offline half: it
checks nothing about behaviour, only that the *type* a verb hands back is the
type the next verb accepts.

That sounds too weak to matter. It is exactly the check that was missing: ENCODE
answered with `memory_id` as an integer while MEMORY_INSPECT declared it as
sixteen bytes, and no mock-based test could see it because a mock agrees with
whatever the client sends. The declarations disagreed in plain sight for
months, in all three SDKs at once, because nothing ever read two of them
together.

So the table below is the point of the file. Each row is a real handoff — a
value one op returns and another takes — written down so that breaking the pair
fails the build instead of waiting for someone to try the sequence. It also
reads as documentation: it is the list of things you can do with what Brain
gives you back.

Adding a verb that consumes an id means adding a row.
"""

from __future__ import annotations

import dataclasses
import typing
from typing import Any, Union, get_args, get_origin

import pytest

from brain_db_sdk.wire import types as T

# (producer type, producer field) -> (consumer type, consumer field), with a
# note saying what the handoff *is*. The note is what makes a failure
# actionable: it names the sequence that would break.
HANDOFFS: list[tuple[type, str, type, str, str]] = [
    # --- a memory id, from every op that mints or reports one -------------
    (
        T.EncodeResponse,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "write a memory, then inspect what the write produced",
    ),
    (T.EncodeResponse, "memory_id", T.ForgetRequest, "memory_id", "write a memory, then forget it"),
    (
        T.EncodeResponse,
        "memory_id",
        T.LinkRequest,
        "source",
        "write two memories, then assert an edge between them",
    ),
    (
        T.EncodeResponse,
        "memory_id",
        T.LinkRequest,
        "target",
        "write two memories, then assert an edge between them",
    ),
    (
        T.EncodeResponse,
        "memory_id",
        T.UnlinkRequest,
        "source",
        "remove an edge by the ids that created it",
    ),
    (
        T.EncodeResponse,
        "memory_id",
        T.UnlinkRequest,
        "target",
        "remove an edge by the ids that created it",
    ),
    (
        T.MemoryListItem,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "page the space, then inspect a row",
    ),
    (
        T.MemoryListItem,
        "memory_id",
        T.ForgetRequest,
        "memory_id",
        "page the space, then forget a row",
    ),
    (
        T.MemoryInspectResponse,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "re-inspect what inspect reported",
    ),
    (
        T.MemoryResult,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "recall a memory, then inspect it",
    ),
    (T.MemoryResult, "memory_id", T.ForgetRequest, "memory_id", "recall a memory, then forget it"),
    (
        T.MemoryEdge,
        "peer",
        T.MemoryInspectRequest,
        "memory_id",
        "follow an edge from one memory to the one at its other end",
    ),
    (
        T.SubscriptionEvent,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "see a write on the change feed, then inspect it",
    ),
    (
        T.LinkResponse,
        "source",
        T.MemoryInspectRequest,
        "memory_id",
        "inspect the memory an edge was anchored at",
    ),
    (
        T.EncodeStageRecord,
        "memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "take the id out of a write trace and inspect it",
    ),
    (
        T.EncodeTraceDedup,
        "matched_memory_id",
        T.MemoryInspectRequest,
        "memory_id",
        "a deduplicated write names the memory it collapsed onto; inspect that one",
    ),
    # --- graph ids ---------------------------------------------------------
    (
        T.EntityCreateResponse,
        "entity_id",
        T.EntityGetRequest,
        "entity_id",
        "create an entity, then read it back",
    ),
    (
        T.EntityCreateResponse,
        "entity_id",
        T.StatementCreateRequest,
        "subject",
        "create an entity, then say something about it",
    ),
    (
        T.EntityCreateResponse,
        "entity_id",
        T.RelationCreateRequest,
        "from_entity",
        "create two entities, then relate them",
    ),
    (
        T.EntityCreateResponse,
        "entity_id",
        T.RelationCreateRequest,
        "to_entity",
        "create two entities, then relate them",
    ),
    (
        T.EntityCreateResponse,
        "entity_id",
        T.EntityTombstoneRequest,
        "entity_id",
        "create an entity, then retire it",
    ),
    (
        T.StatementCreateResponse,
        "statement_id",
        T.StatementGetRequest,
        "statement_id",
        "create a statement, then read it back",
    ),
    (
        T.StatementCreateResponse,
        "statement_id",
        T.StatementSupersedeRequest,
        "old_statement_id",
        "create a statement, then revise it",
    ),
    (
        T.StatementCreateResponse,
        "chain_root",
        T.StatementHistoryRequest,
        "anchor_id",
        "walk the version chain a statement belongs to",
    ),
    (
        T.RelationCreateResponse,
        "relation_id",
        T.RelationGetRequest,
        "relation_id",
        "create a relation, then read it back",
    ),
    # --- handles that are not ids but travel the same way ------------------
    (
        T.MemoryListResponseFrame,
        "next_cursor",
        T.MemoryListRequest,
        "cursor",
        "page a listing with the cursor the previous page handed back",
    ),
    (
        T.SessionCreateResponse,
        "session_id",
        T.SessionDeleteRequest,
        "session_id",
        "create a session, then delete it",
    ),
    (
        T.SessionCreateResponse,
        "session_id",
        T.EncodeRequest,
        "session_id",
        "create a session, then write into it",
    ),
    (
        T.SessionView,
        "session_id",
        T.SessionDeleteRequest,
        "session_id",
        "list sessions, then delete one",
    ),
    (
        T.TxnBeginRequest,
        "txn_id",
        T.TxnCommitRequest,
        "txn_id",
        "begin a transaction, then commit it",
    ),
    (
        T.TxnBeginRequest,
        "txn_id",
        T.TxnAbortRequest,
        "txn_id",
        "begin a transaction, then abandon it",
    ),
    (
        T.TxnBeginRequest,
        "txn_id",
        T.EncodeRequest,
        "txn_id",
        "enroll a write in an open transaction",
    ),
]


def _annotation(cls: type, field: str) -> Any:
    hints = typing.get_type_hints(cls)
    if field not in hints:
        available = ", ".join(sorted(f.name for f in dataclasses.fields(cls)))
        pytest.fail(f"{cls.__name__} has no field `{field}`. It has: {available}")
    return hints[field]


def _core(annotation: Any) -> Any:
    """Strip `Optional` and list wrappers down to the shape that is carried.

    An optional id and a required one are the same shape for this purpose —
    what matters is whether the value is bytes or an integer, not whether it
    might be absent.
    """
    origin = get_origin(annotation)
    if origin is Union:
        args = [a for a in get_args(annotation) if a is not type(None)]
        if len(args) == 1:
            return _core(args[0])
    if origin in (list, set, tuple):
        args = get_args(annotation)
        if args:
            return _core(args[0])
    return annotation


def _name(annotation: Any) -> str:
    return getattr(annotation, "__name__", str(annotation))


@pytest.mark.parametrize(
    ("producer", "out_field", "consumer", "in_field", "story"),
    HANDOFFS,
    ids=[f"{p.__name__}.{o}->{c.__name__}.{i}" for p, o, c, i, _ in HANDOFFS],
)
def test_a_value_one_op_returns_is_the_shape_the_next_op_takes(
    producer: type, out_field: str, consumer: type, in_field: str, story: str
) -> None:
    out = _core(_annotation(producer, out_field))
    inp = _core(_annotation(consumer, in_field))
    assert out == inp, (
        f"{producer.__name__}.{out_field} is {_name(out)} but "
        f"{consumer.__name__}.{in_field} is {_name(inp)}, so you cannot "
        f"{story} without converting. Pick one shape — this is how `memory_id` "
        f"came to be a u128 on ENCODE and 16 bytes on MEMORY_INSPECT."
    )


def test_the_table_covers_every_memory_id_consumer() -> None:
    """A guard on the table: a new op that takes a `memory_id` must be listed.

    Without this the table silently stops being the list of handoffs and
    becomes the list of handoffs someone remembered.
    """
    consumers = {(c, f) for _, _, c, f, _ in HANDOFFS}
    missing = []
    for name in dir(T):
        obj = getattr(T, name)
        if not (isinstance(obj, type) and dataclasses.is_dataclass(obj)):
            continue
        if not name.endswith("Request"):
            continue
        missing.extend(
            f"{name}.{field.name}"
            for field in dataclasses.fields(obj)
            if field.name == "memory_id" and (obj, field.name) not in consumers
        )
    assert not missing, (
        f"these request types take a memory_id but no handoff names them: {missing}. "
        "Add a row to HANDOFFS saying where the id comes from."
    )


def test_the_table_is_not_trivially_empty() -> None:
    assert len(HANDOFFS) >= 25, f"only {len(HANDOFFS)} handoffs; the table has been gutted"


def test_every_handoff_names_a_real_sequence() -> None:
    for producer, out_field, consumer, in_field, story in HANDOFFS:
        assert story and story[0].islower(), (
            f"{producer.__name__}.{out_field} -> {consumer.__name__}.{in_field} "
            "needs a note saying what the sequence is"
        )
