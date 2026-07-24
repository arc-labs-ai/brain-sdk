"""Ergonomic request builders for the v1 verbs.

The wire dataclasses in :mod:`brain_db_sdk.wire.types` mirror the protocol
exactly — every field present, in wire order. That is what the codec needs but
a poor calling convention: most fields have an obvious default and only a few
matter per call. These builders fill the defaults, mint a ``request_id``, and
expose just the knobs a caller tunes. The verbs on
:class:`~brain_db_sdk.client.BrainClient` accept either a builder (via
``.build()``) or a hand-built wire dataclass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .client import new_id
from .wire.types import (
    ActAs,
    EncodeRequest,
    ForgetMode,
    ForgetRequest,
    RecallRequest,
    WaitMode,
)


@dataclass
class EncodeBuilder:
    """Builder for an ENCODE request. Stores one text memory in session 0;
    the server owns the embedding, kind classification, salience, and edges.
    ``occurred_at`` optionally records when the event the text describes
    happened (distinct from the ingest time)."""

    text: str
    session_id: int = 0
    occurred_at_unix_nanos: Optional[int] = None
    act_as_identity: Optional[ActAs] = None
    wait_mode: int = WaitMode.ACK
    allow_dups: bool = False

    def session(self, session_id: int) -> "EncodeBuilder":
        """Store the memory under a specific session id instead of the default 0."""
        self.session_id = session_id
        return self

    def occurred_at(self, occurred_at_unix_nanos: Optional[int]) -> "EncodeBuilder":
        """Record when the event the text describes happened (event time),
        distinct from the server's ingest time."""
        self.occurred_at_unix_nanos = occurred_at_unix_nanos
        return self

    def wait(self, mode: int = WaitMode.ACK) -> "EncodeBuilder":
        """Set the write-completion mode. ``WaitMode.ACK`` (the default)
        returns as soon as the write is durable and the async derivation
        stages run in the background; ``WaitMode.DERIVED`` blocks until they
        complete and the :class:`EncodeResponse` carries a populated ``trace``
        describing the write timeline and the artifacts it produced."""
        self.wait_mode = mode
        return self

    def derived(self) -> "EncodeBuilder":
        """Convenience for ``wait(WaitMode.DERIVED)``: block until async
        derivation completes and return the full synchronous write trace."""
        self.wait_mode = WaitMode.DERIVED
        return self

    def act_as(self, namespace: str, space_id: str) -> "EncodeBuilder":
        """Run this encode as the effective identity ``(namespace, space_id)``
        on behalf of the connection principal. ``space_id`` is the human-readable
        structured space string (empty selects the key-bound space). Requires the
        connection's key to hold ``can_act_as``; otherwise the server rejects with
        ``ActAsDenied``. Per-request, so one pooled client can serve many tenants."""
        self.act_as_identity = ActAs(namespace=namespace, space_id=space_id)
        return self

    def allow_duplicates(self, allow: bool = True) -> "EncodeBuilder":
        """Opt out of content dedup and force a distinct memory. By default
        Brain dedupes byte-identical text on ``(space_id, session_id,
        BLAKE3(text))`` and returns the existing memory (``was_deduplicated =
        True``) without writing. Call this when the same text is a genuinely
        distinct observation that must coexist (e.g. the same fact re-stated at
        a different ``occurred_at``)."""
        self.allow_dups = allow
        return self

    def build(self) -> EncodeRequest:
        """Finish into a wire :class:`EncodeRequest`, minting a fresh id."""
        return EncodeRequest(
            text=self.text,
            session_id=self.session_id,
            request_id=new_id(),
            txn_id=None,
            occurred_at_unix_nanos=self.occurred_at_unix_nanos,
            act_as=self.act_as_identity,
            wait=self.wait_mode,
            allow_duplicates=self.allow_dups,
        )


@dataclass
class RecallBuilder:
    """Builder for a RECALL request. Returns up to 10 of the space's own
    memories with text and edges included; the server runs one unified recall
    path. ``subject`` names the entity a fact lookup is about; ``as_of``
    queries the graph as it stood at a record time (bi-temporal travel)."""

    cue_text: str
    subject_name: str = ""
    max_results: int = 10
    confidence_threshold: float = 0.0
    session_filter: Optional[list[int]] = None
    age_bound_unix_nanos: Optional[int] = None
    as_of_record_time_unix_nanos: Optional[int] = None
    kind_filter: Optional[list[int]] = None
    salience_floor: float = 0.0
    include_edges: bool = True
    include_graph: bool = False
    include_text: bool = True
    trace_enabled: bool = False
    act_as_identity: Optional[ActAs] = None

    def subject(self, subject_name: str) -> "RecallBuilder":
        """Name the entity a fact lookup is about, so recall resolves the
        subject before matching the cue."""
        self.subject_name = subject_name
        return self

    def limit(self, max_results: int) -> "RecallBuilder":
        """Cap how many memories recall returns."""
        self.max_results = max_results
        return self

    def as_of(self, as_of_record_time_unix_nanos: Optional[int]) -> "RecallBuilder":
        """Query the graph as it stood at a record time (bi-temporal travel)."""
        self.as_of_record_time_unix_nanos = as_of_record_time_unix_nanos
        return self

    def confidence(self, threshold: float) -> "RecallBuilder":
        """Drop memories whose salience falls below this floor."""
        self.confidence_threshold = threshold
        return self

    def sessions(self, sessions: list[int]) -> "RecallBuilder":
        """Restrict recall to memories in these session ids."""
        self.session_filter = list(sessions)
        return self

    def kinds(self, kinds: list[int]) -> "RecallBuilder":
        """Restrict recall to these memory kinds (integer discriminants)."""
        self.kind_filter = list(kinds)
        return self

    def salience(self, floor: float) -> "RecallBuilder":
        """Drop memories below this salience floor."""
        self.salience_floor = floor
        return self

    def edges(self, include: bool) -> "RecallBuilder":
        """Include (or omit) each memory's outgoing edges in the response."""
        self.include_edges = include
        return self

    def graph(self, include: bool) -> "RecallBuilder":
        """Include (or omit) the resolved entity/statement/relation graph
        enrichment alongside the memories."""
        self.include_graph = include
        return self

    def text(self, include: bool) -> "RecallBuilder":
        """Include (or omit) the stored memory text in the response."""
        self.include_text = include
        return self

    def trace(self, trace: bool = True) -> "RecallBuilder":
        """Ask for the per-stage read-pipeline trace on the final frame
        (``RecallResponseFrame.trace``). Off by default; costs nothing when
        off."""
        self.trace_enabled = trace
        return self

    def act_as(self, namespace: str, space_id: str) -> "RecallBuilder":
        """Run this recall as the effective identity ``(namespace, space_id)``
        on behalf of the connection principal. ``space_id`` is the human-readable
        structured space string (empty selects the key-bound space). Requires the
        connection's key to hold ``can_act_as``; otherwise the server rejects with
        ``ActAsDenied``. Per-request, so one pooled client can serve many tenants."""
        self.act_as_identity = ActAs(namespace=namespace, space_id=space_id)
        return self

    def build(self) -> RecallRequest:
        """Finish into a wire :class:`RecallRequest`, minting a fresh id."""
        return RecallRequest(
            cue_text=self.cue_text,
            subject_name=self.subject_name,
            max_results=self.max_results,
            confidence_threshold=self.confidence_threshold,
            session_filter=self.session_filter,
            age_bound_unix_nanos=self.age_bound_unix_nanos,
            as_of_record_time_unix_nanos=self.as_of_record_time_unix_nanos,
            kind_filter=self.kind_filter,
            salience_floor=self.salience_floor,
            include_edges=self.include_edges,
            include_graph=self.include_graph,
            include_text=self.include_text,
            request_id=new_id(),
            txn_id=None,
            trace=self.trace_enabled,
            act_as=self.act_as_identity,
        )


@dataclass
class ForgetBuilder:
    """Builder for a FORGET request. Defaults to a soft forget (tombstone
    with a grace period); :meth:`hard` zeroes immediately."""

    memory_id: int
    mode: int = ForgetMode.SOFT
    act_as_identity: Optional[ActAs] = None

    def hard(self) -> "ForgetBuilder":
        """Switch to a hard forget: zero the memory immediately, no grace
        period."""
        self.mode = ForgetMode.HARD
        return self

    def with_mode(self, mode: int) -> "ForgetBuilder":
        """Set the forget mode explicitly (integer discriminant)."""
        self.mode = mode
        return self

    def act_as(self, namespace: str, space_id: str) -> "ForgetBuilder":
        """Run this forget as the effective identity ``(namespace, space_id)``
        on behalf of the connection principal. ``space_id`` is the human-readable
        structured space string (empty selects the key-bound space). Requires the
        connection's key to hold ``can_act_as``; otherwise the server rejects with
        ``ActAsDenied``. Per-request, so one pooled client can serve many tenants."""
        self.act_as_identity = ActAs(namespace=namespace, space_id=space_id)
        return self

    def build(self) -> ForgetRequest:
        """Finish into a wire :class:`ForgetRequest`, minting a fresh id."""
        return ForgetRequest(
            memory_id=self.memory_id,
            mode=self.mode,
            request_id=new_id(),
            txn_id=None,
            act_as=self.act_as_identity,
        )


__all__ = ["EncodeBuilder", "RecallBuilder", "ForgetBuilder"]
