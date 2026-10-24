"""``BrainHttpClient`` — the synchronous HTTP tier of the Brain SDK.

Talks JSON to the Brain HTTP edge (``brain-edge`` self-hosted, or the Arc cloud
gateway). Same verb surface and field names as the Rust and TypeScript HTTP
clients. For the native wire protocol (streaming, transactions, typed-graph
management), use :class:`brain_db_sdk.BrainClient` instead.

Zero third-party dependencies — built on :mod:`urllib.request`.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from typing import Any, Optional

from .errors import BrainHttpError, FieldError
from .retry import HttpRetryPolicy
from .sse import Subscription
from .types import (
    Capabilities,
    CreateEntityResult,
    CreateRelationResult,
    CreateStatementResult,
    DropSchemaResult,
    EncodeResult,
    EntityDetail,
    ForgetResult,
    GraphPage,
    LinkResult,
    ListEntitiesResult,
    ListExtractorsResult,
    ListRelationsResult,
    ListSchemasResult,
    ListSessionsResult,
    ListSpacesResult,
    ListStatementsResult,
    LlmCredential,
    LlmCredentialCheck,
    LlmCredentialDeleted,
    MaterializeProceduralResult,
    MemoryInspect,
    MemoryListPage,
    MergeEntitiesResult,
    PlanResult,
    QueryExplainResult,
    QueryTraceResult,
    ReasonResult,
    RecallResult,
    RelationDetail,
    ResolveEntityResult,
    RetractStatementResult,
    Schema,
    SchemaReplace,
    SchemaUpload,
    SchemaValidate,
    SessionErased,
    SessionProvision,
    SpaceErased,
    SpaceProvision,
    StatementDetail,
    StatementHistoryResult,
    SupersedeRelationResult,
    SupersedeStatementResult,
    TombstoneResult,
    TraverseResult,
    UnlinkResult,
    UnmergeEntityResult,
    Whoami,
)

DEFAULT_BASE_URL = "http://127.0.0.1:8080"


class BrainHttpClient:
    """A synchronous HTTP client for the Brain edge."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        retry: Optional[HttpRetryPolicy] = None,
    ) -> None:
        if not api_key:
            raise BrainHttpError(0, "config", "api_key is required")
        # `urlopen` honours every scheme urllib supports, so a `file://` or
        # `ftp://` base_url would turn an SDK call into a local file read.
        # base_url routinely comes from config or an environment variable, so
        # it is checked here, where it enters, rather than at each call site.
        scheme = urllib.parse.urlparse(base_url).scheme.lower()
        if scheme not in ("http", "https"):
            raise BrainHttpError(
                0,
                "config",
                f"base_url must be http:// or https://, got {scheme or 'no'} scheme",
            )
        self._base = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._retry = retry if retry is not None else HttpRetryPolicy()

    # --- verbs ------------------------------------------------------------

    def encode(
        self,
        text: str,
        session: Optional[int] = None,
        occurred_at: Optional[int] = None,
    ) -> EncodeResult:
        """Store a memory."""
        body = _compact({"text": text, "session": session, "occurred_at_unix_nanos": occurred_at})
        return EncodeResult.from_dict(self._request("POST", "/v1/memories", body, idempotent=True))

    def recall(
        self,
        query: str,
        max_results: Optional[int] = None,
        subject: Optional[str] = None,
        scope: Optional[str] = None,
        include_trace: Optional[bool] = None,
    ) -> RecallResult:
        """Recall memories for a cue.

        ``scope`` says how wide to read: ``"space"`` (the default — the
        caller's own space) or ``"namespace"``, which fans out across every
        space in the caller's namespace and merges the hits. Case-insensitive;
        any other value is rejected rather than quietly narrowed.

        ``include_trace`` returns Brain's read pipeline alongside the hits as
        :attr:`RecallResult.trace` — which retrievers ran, how they were
        fused, what the filter chain dropped, what the reranker did. It is
        several KB per call, so leave it off in hot paths and switch it on
        when chasing a bad answer. The cloud gateway serves it; a server that
        does not support it ignores the field and returns no trace.

        The trace is large and does NOT scale with ``max_results``: it reports
        every candidate each lane considered, so it grows with the size of the
        space. A three-hit recall over ~700 memories measured 121 KB. Leave it
        off in hot paths; it costs nothing when off.
        """
        body = _compact(
            {
                "query": query,
                "max_results": max_results,
                "subject": subject,
                "scope": scope,
                "include_trace": include_trace,
            }
        )
        return RecallResult.from_dict(self._request("POST", "/v1/recall", body, idempotent=True))

    def forget(self, memory_id: str, hard: bool = False) -> ForgetResult:
        """Forget a memory."""
        return ForgetResult.from_dict(
            self._request(
                "DELETE",
                "/v1/memories",
                {"memory_id": memory_id, "hard": hard},
                idempotent=True,
            )
        )

    def link(
        self,
        source: str,
        target: str,
        kind: str,
        weight: Optional[float] = None,
    ) -> LinkResult:
        """Create/overwrite a directed edge between two memories."""
        body = _compact({"source": source, "target": target, "kind": kind, "weight": weight})
        return LinkResult.from_dict(self._request("POST", "/v1/links", body))

    def unlink(self, source: str, target: str, kind: str) -> UnlinkResult:
        """Remove a directed edge (idempotent)."""
        body = {"source": source, "target": target, "kind": kind}
        return UnlinkResult.from_dict(self._request("DELETE", "/v1/links", body, idempotent=True))

    def plan(
        self,
        start: Mapping[str, str],
        goal: Mapping[str, str],
        max_steps: Optional[int] = None,
        max_wall_time_ms: Optional[int] = None,
        max_branches: Optional[int] = None,
        strategy: Optional[str] = None,
    ) -> PlanResult:
        """Plan a path from a start state to a goal state.

        ``start`` / ``goal`` are ``{"text": ...}`` or ``{"memory_id": ...}``.
        """
        body = _compact(
            {
                "start": dict(start),
                "goal": dict(goal),
                "max_steps": max_steps,
                "max_wall_time_ms": max_wall_time_ms,
                "max_branches": max_branches,
                "strategy": strategy,
            }
        )
        return PlanResult.from_dict(self._request("POST", "/v1/plan", body, idempotent=True))

    def reason(
        self,
        observation: Mapping[str, str],
        depth: Optional[int] = None,
        confidence_threshold: Optional[float] = None,
        max_inferences: Optional[int] = None,
        budget_wall_time_ms: Optional[int] = None,
    ) -> ReasonResult:
        """Infer over the graph from an observation.

        ``observation`` is ``{"text": ...}`` or ``{"memory_id": ...}``.
        """
        body = _compact(
            {
                "observation": dict(observation),
                "depth": depth,
                "confidence_threshold": confidence_threshold,
                "max_inferences": max_inferences,
                "budget_wall_time_ms": budget_wall_time_ms,
            }
        )
        return ReasonResult.from_dict(self._request("POST", "/v1/reason", body, idempotent=True))

    def whoami(self) -> Whoami:
        """The identity Brain resolves from the credential."""
        return Whoami.from_dict(self._request("GET", "/v1/whoami", idempotent=True))

    def capabilities(self) -> Capabilities:
        """What the connected shard supports."""
        return Capabilities.from_dict(self._request("GET", "/v1/capabilities", idempotent=True))

    # --- memories ---------------------------------------------------------

    def memory_list(
        self,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        dir: Optional[str] = None,  # noqa: A002 - the edge's query param is `dir`
        include_tombstoned: Optional[bool] = None,
    ) -> MemoryListPage:
        """A page of stored memories, newest first by default.

        ``cursor`` is the previous page's ``next_cursor``; ``dir`` is the scan
        direction the edge understands.
        """
        query = _compact(
            {
                "limit": limit,
                "cursor": cursor,
                "dir": dir,
                "include_tombstoned": include_tombstoned,
            }
        )
        return MemoryListPage.from_dict(
            self._request("GET", "/v1/memories", query=query, idempotent=True)
        )

    def memory_inspect(self, memory_id: str) -> MemoryInspect:
        """The full encode-pipeline artifact behind one memory."""
        return MemoryInspect.from_dict(
            self._request("GET", f"/v1/memories/{_seg(memory_id)}/inspect", idempotent=True)
        )

    # --- entities ---------------------------------------------------------

    def list_entities(
        self,
        type_id: Optional[int] = None,
        prefix: Optional[str] = None,
        mention_count_min: Optional[int] = None,
        include_tombstoned: Optional[bool] = None,
        include_merged: Optional[bool] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ListEntitiesResult:
        """Entities in the space, optionally filtered.
        ``cursor`` resumes after a previous page's ``next_cursor``; keep the
        other filters identical across pages, because the cursor is bound to
        them.
        """
        query = _compact(
            {
                "type_id": type_id,
                "prefix": prefix,
                "mention_count_min": mention_count_min,
                "include_tombstoned": include_tombstoned,
                "include_merged": include_merged,
                "limit": limit,
                "cursor": cursor,
            }
        )
        return ListEntitiesResult.from_dict(
            self._request("GET", "/v1/entities", query=query, idempotent=True)
        )

    def get_entity(self, entity_id: str) -> EntityDetail:
        """One entity by id."""
        return EntityDetail.from_dict(
            self._request("GET", f"/v1/entities/{_seg(entity_id)}", idempotent=True)
        )

    def create_entity(
        self,
        entity_type_id: int,
        canonical_name: str,
        aliases: Optional[Sequence[str]] = None,
    ) -> CreateEntityResult:
        """Create an entity outright, without resolution."""
        body = _compact(
            {
                "entity_type_id": entity_type_id,
                "canonical_name": canonical_name,
                "aliases": list(aliases) if aliases is not None else None,
            }
        )
        return CreateEntityResult.from_dict(self._request("POST", "/v1/entities", body))

    def resolve_entity(
        self,
        candidate_name: str,
        resolution_context: Optional[str] = None,
        type_hint: Optional[int] = None,
        allow_create: Optional[bool] = None,
    ) -> ResolveEntityResult:
        """Resolve a surface name to an existing entity, or (with
        ``allow_create``) mint one."""
        body = _compact(
            {
                "candidate_name": candidate_name,
                "resolution_context": resolution_context,
                "type_hint": type_hint,
                "allow_create": allow_create,
            }
        )
        return ResolveEntityResult.from_dict(self._request("POST", "/v1/entities/resolve", body))

    def traverse_relations(
        self,
        entity_id: str,
        direction: Optional[str] = None,
        relation_types: Optional[Sequence[str]] = None,
        max_depth: Optional[int] = None,
        max_nodes: Optional[int] = None,
        include_superseded: Optional[bool] = None,
    ) -> TraverseResult:
        """Walk the relation graph outward from one entity."""
        body = _compact(
            {
                "direction": direction,
                "relation_types": (list(relation_types) if relation_types is not None else None),
                "max_depth": max_depth,
                "max_nodes": max_nodes,
                "include_superseded": include_superseded,
            }
        )
        return TraverseResult.from_dict(
            self._request(
                "POST",
                f"/v1/entities/{_seg(entity_id)}/traverse",
                body,
                idempotent=True,
            )
        )

    # --- relations --------------------------------------------------------

    def list_relations(
        self,
        entity_id: str,
        direction: Optional[str] = None,
        relation_type: Optional[str] = None,
        include_superseded: Optional[bool] = None,
        include_tombstoned: Optional[bool] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ListRelationsResult:
        """Relations touching one entity.

        ``relation_type`` goes on the wire as ``type`` — the edge's query struct
        renames it, because ``type`` is a Rust keyword there just as it is a
        builtin here.

        ``cursor`` resumes after a previous page's ``next_cursor``; keep the
        other filters identical across pages, because the cursor is bound to
        them.
        """
        query = _compact(
            {
                "direction": direction,
                "type": relation_type,
                "include_superseded": include_superseded,
                "include_tombstoned": include_tombstoned,
                "limit": limit,
                "cursor": cursor,
            }
        )
        return ListRelationsResult.from_dict(
            self._request(
                "GET",
                f"/v1/entities/{_seg(entity_id)}/relations",
                query=query,
                idempotent=True,
            )
        )

    def get_relation(
        self,
        relation_id: str,
        follow_supersession: Optional[bool] = None,
    ) -> RelationDetail:
        """One relation by id."""
        query = _compact({"follow_supersession": follow_supersession})
        return RelationDetail.from_dict(
            self._request("GET", f"/v1/relations/{_seg(relation_id)}", query=query, idempotent=True)
        )

    # --- statements -------------------------------------------------------

    def list_statements(
        self,
        subject: Optional[str] = None,
        predicate: Optional[str] = None,
        kind: Optional[str] = None,
        min_confidence: Optional[float] = None,
        only_current: Optional[bool] = None,
        include_tombstoned: Optional[bool] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ListStatementsResult:
        """Statements in the space, optionally filtered.
        ``cursor`` resumes after a previous page's ``next_cursor``; keep the
        other filters identical across pages, because the cursor is bound to
        them.
        """
        query = _compact(
            {
                "subject": subject,
                "predicate": predicate,
                "kind": kind,
                "min_confidence": min_confidence,
                "only_current": only_current,
                "include_tombstoned": include_tombstoned,
                "limit": limit,
                "cursor": cursor,
            }
        )
        return ListStatementsResult.from_dict(
            self._request("GET", "/v1/statements", query=query, idempotent=True)
        )

    def get_statement(
        self,
        statement_id: str,
        follow_supersession: Optional[bool] = None,
    ) -> StatementDetail:
        """One statement by id."""
        query = _compact({"follow_supersession": follow_supersession})
        return StatementDetail.from_dict(
            self._request(
                "GET",
                f"/v1/statements/{_seg(statement_id)}",
                query=query,
                idempotent=True,
            )
        )

    # --- graph ------------------------------------------------------------

    def graph_fetch(
        self,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        include_statements: Optional[bool] = None,
        include_memories: Optional[bool] = None,
        include_memory_edges: Optional[bool] = None,
        include_tombstoned: Optional[bool] = None,
    ) -> GraphPage:
        """A page of the typed graph: nodes, edges, and a cursor."""
        query = _compact(
            {
                "limit": limit,
                "cursor": cursor,
                "include_statements": include_statements,
                "include_memories": include_memories,
                "include_memory_edges": include_memory_edges,
                "include_tombstoned": include_tombstoned,
            }
        )
        return GraphPage.from_dict(self._request("GET", "/v1/graph", query=query, idempotent=True))

    # --- schema -----------------------------------------------------------

    def get_schema(
        self,
        namespace: Optional[str] = None,
        version: Optional[int] = None,
    ) -> Schema:
        """The active schema document, or a specific ``version`` of it."""
        query = _compact({"namespace": namespace, "version": version})
        return Schema.from_dict(self._request("GET", "/v1/schema", query=query, idempotent=True))

    def upload_schema(
        self,
        schema_document: str,
        dry_run: Optional[bool] = None,
        allow_breaking: Optional[bool] = None,
    ) -> SchemaUpload:
        """Register a new schema version.

        Not retried: an upload that times out may still have landed, and a
        second attempt would mint a second version.
        """
        body = _compact(
            {
                "schema_document": schema_document,
                "dry_run": dry_run,
                "allow_breaking": allow_breaking,
            }
        )
        return SchemaUpload.from_dict(self._request("POST", "/v1/schema", body))

    def validate_schema(self, schema_document: str) -> SchemaValidate:
        """Check a schema document without registering it.

        A pure dry run — nothing on the edge changes — so this one POST is safe
        to retry.
        """
        return SchemaValidate.from_dict(
            self._request(
                "POST",
                "/v1/schema/validate",
                {"schema_document": schema_document},
                idempotent=True,
            )
        )

    def replace_schema(
        self,
        schema_document: str,
        force_drop_existing: bool = False,
    ) -> SchemaReplace:
        """Replace the schema wholesale.

        Destructive: with ``force_drop_existing`` the edge drops data that no
        longer validates. Never retried — a replace that appears to have failed
        may have succeeded, and re-running it would drop a second time against
        a graph that has already moved.
        """
        return SchemaReplace.from_dict(
            self._request(
                "PUT",
                "/v1/schema",
                {
                    "schema_document": schema_document,
                    "force_drop_existing": force_drop_existing,
                },
            )
        )

    # --- space lifecycle --------------------------------------------------
    #
    # All three act on the caller's effective space: Brain resolves it from
    # the credential and never takes it from the request, so none of them
    # names one.

    def create_space(self, metadata: Optional[str] = None) -> SpaceProvision:
        """Provision the caller's space.

        Idempotent — read :attr:`SpaceProvision.created` to tell whether this
        call made it. ``metadata`` is write-only: no op returns it.
        """
        return SpaceProvision.from_dict(
            self._request("POST", "/v1/spaces", _compact({"metadata": metadata}), idempotent=True)
        )

    def list_spaces(self, limit: Optional[int] = None) -> ListSpacesResult:
        """The spaces in the caller's namespace.

        Check :attr:`ListSpacesResult.cross_shard_complete`: ``False`` means
        the listing covered one shard, and treating a partial listing as
        complete is how a caller concludes a space is gone.
        """
        return ListSpacesResult.from_dict(
            self._request("GET", "/v1/spaces", query=_compact({"limit": limit}), idempotent=True)
        )

    def delete_space(self) -> SpaceErased:
        """Erase the caller's space and everything under it. Hard, immediate."""
        # Retryable: a repeat reaches the same end state and answers
        # `existed: False`, which the result models.
        return SpaceErased.from_dict(self._request("DELETE", "/v1/spaces", idempotent=True))

    # --- session lifecycle ------------------------------------------------

    def create_session(self, session_id: int, title: Optional[str] = None) -> SessionProvision:
        """Provision a session in the caller's space.

        The id is client-chosen, so a caller's own conversation id can BE the
        session id rather than needing a mapping. Idempotent on it.
        """
        return SessionProvision.from_dict(
            self._request(
                "POST",
                "/v1/sessions",
                _compact({"session_id": session_id, "title": title}),
                idempotent=True,
            )
        )

    def list_sessions(self, limit: Optional[int] = None) -> ListSessionsResult:
        """The sessions in the caller's space."""
        return ListSessionsResult.from_dict(
            self._request("GET", "/v1/sessions", query=_compact({"limit": limit}), idempotent=True)
        )

    def delete_session(self, session_id: int, hard: bool = False) -> SessionErased:
        """Erase a session. Soft unless ``hard`` is asked for by name."""
        return SessionErased.from_dict(
            self._request(
                "DELETE",
                f"/v1/sessions/{_seg(str(session_id))}",
                query=_compact({"hard": hard or None}),
                idempotent=True,
            )
        )

    # --- entity authoring -------------------------------------------------

    def update_entity(
        self,
        entity_id: str,
        canonical_name: str,
        aliases: Optional[Sequence[str]] = None,
        attributes: Optional[str] = None,
    ) -> EntityDetail:
        """Replace an entity's name, aliases and attribute blob.

        A REPLACE, not a patch: an omitted ``aliases`` or ``attributes``
        CLEARS it. :meth:`get_entity` returns both, so a read-modify-write
        round-trips.
        """
        return EntityDetail.from_dict(
            self._request(
                "PUT",
                f"/v1/entities/{_seg(entity_id)}",
                _compact(
                    {
                        "canonical_name": canonical_name,
                        "aliases": list(aliases) if aliases else None,
                        "attributes": attributes,
                    }
                ),
                idempotent=True,
            )
        )

    def rename_entity(
        self, entity_id: str, new_canonical_name: str, move_to_alias: bool = True
    ) -> EntityDetail:
        """Change an entity's canonical name.

        ``move_to_alias`` defaults to ``True``: a name an entity was known by
        is how a later mention still resolves to it, so dropping it should be
        asked for.
        """
        return EntityDetail.from_dict(
            self._request(
                "POST",
                f"/v1/entities/{_seg(entity_id)}/rename",
                {"new_canonical_name": new_canonical_name, "move_to_alias": move_to_alias},
                idempotent=True,
            )
        )

    def merge_entities(
        self,
        survivor_id: str,
        merged: str,
        confidence: float = 1.0,
        reason: str = "",
    ) -> MergeEntitiesResult:
        """Fold another entity into this one. ``survivor_id`` is what remains.

        Reversible for :attr:`MergeEntitiesResult.grace_period_seconds`, which
        the result carries so a caller need not know the deployment's config.
        """
        # Single-shot: a merge writes an audit record, and a retried one
        # writes a second.
        return MergeEntitiesResult.from_dict(
            self._request(
                "POST",
                f"/v1/entities/{_seg(survivor_id)}/merge",
                _compact({"merged": merged, "confidence": confidence, "reason": reason or None}),
            )
        )

    def unmerge_entity(self, merged_entity_id: str) -> UnmergeEntityResult:
        """Undo a merge. The id is the entity that was merged away."""
        return UnmergeEntityResult.from_dict(
            self._request("POST", f"/v1/entities/{_seg(merged_entity_id)}/unmerge")
        )

    def tombstone_entity(self, entity_id: str, reason: Optional[str] = None) -> TombstoneResult:
        """Tombstone an entity.

        The row stays and reads stop resolving to it, which is what keeps
        statements that referenced it interpretable.
        """
        return TombstoneResult.from_dict(
            self._request(
                "DELETE",
                f"/v1/entities/{_seg(entity_id)}",
                query=_compact({"reason": reason}),
                idempotent=True,
            )
        )

    # --- statement authoring ----------------------------------------------

    def create_statement(
        self,
        kind: str,
        subject: str,
        predicate: str,
        obj: Mapping[str, Any],
        confidence: float = 1.0,
        event_at_unix_nanos: Optional[int] = None,
        valid_from_unix_nanos: Optional[int] = None,
        valid_to_unix_nanos: Optional[int] = None,
        extractor_id: Optional[int] = None,
        schema_version: Optional[int] = None,
        session_id: Optional[int] = None,
        evidence: Optional[Sequence[str]] = None,
    ) -> CreateStatementResult:
        """Assert a claim.

        ``obj`` is the tagged object a read returns, e.g.
        ``{"kind": "value", "value": {"type": "text", "value": "Arc"}}``; a
        memory object's id is a 128-bit decimal string, not a UUID.

        ``event_at`` is when the thing HAPPENED; ``valid_from``/``valid_to``
        are when the claim is held to be true. A meeting that happened Monday
        and is believed from Tuesday has different values for the two.

        Brain may recognise the claim as a revision of an existing one and
        supersede it; :attr:`CreateStatementResult.auto_superseded` says when
        it did.
        """
        return CreateStatementResult.from_dict(
            self._request(
                "POST",
                "/v1/statements",
                self._statement_body(
                    kind,
                    subject,
                    predicate,
                    obj,
                    confidence,
                    event_at_unix_nanos,
                    valid_from_unix_nanos,
                    valid_to_unix_nanos,
                    extractor_id,
                    schema_version,
                    session_id,
                    evidence,
                ),
            )
        )

    def supersede_statement(
        self,
        statement_id: str,
        kind: str,
        subject: str,
        predicate: str,
        obj: Mapping[str, Any],
        confidence: float = 1.0,
        event_at_unix_nanos: Optional[int] = None,
        valid_from_unix_nanos: Optional[int] = None,
        valid_to_unix_nanos: Optional[int] = None,
        extractor_id: Optional[int] = None,
        schema_version: Optional[int] = None,
        session_id: Optional[int] = None,
        evidence: Optional[Sequence[str]] = None,
    ) -> SupersedeStatementResult:
        """Replace a claim with a revised one, keeping both and the link.

        The replacement is a whole statement rather than a patch: a revision
        that changed only the confidence and one that changed the object are
        the same operation to the chain.
        """
        return SupersedeStatementResult.from_dict(
            self._request(
                "POST",
                f"/v1/statements/{_seg(statement_id)}/supersede",
                self._statement_body(
                    kind,
                    subject,
                    predicate,
                    obj,
                    confidence,
                    event_at_unix_nanos,
                    valid_from_unix_nanos,
                    valid_to_unix_nanos,
                    extractor_id,
                    schema_version,
                    session_id,
                    evidence,
                ),
            )
        )

    def tombstone_statement(
        self, statement_id: str, reason: int = 0, message: Optional[str] = None
    ) -> TombstoneResult:
        """Retire a claim. The row stays; reads stop returning it."""
        return TombstoneResult.from_dict(
            self._request(
                "DELETE",
                f"/v1/statements/{_seg(statement_id)}",
                query=_compact({"reason": reason or None, "message": message}),
                idempotent=True,
            )
        )

    def retract_statement(
        self, statement_id: str, reason: int = 0, message: Optional[str] = None
    ) -> RetractStatementResult:
        """Withdraw a claim.

        Stronger than :meth:`tombstone_statement`: the content itself is
        scheduled to be zeroed, and the result says when.
        """
        return RetractStatementResult.from_dict(
            self._request(
                "POST",
                f"/v1/statements/{_seg(statement_id)}/retract",
                query=_compact({"reason": reason or None, "message": message}),
                idempotent=True,
            )
        )

    def statement_history(
        self,
        statement_id: str,
        include_tombstoned: bool = False,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> StatementHistoryResult:
        """Every version of one claim, oldest first."""
        return StatementHistoryResult.from_dict(
            self._request(
                "GET",
                f"/v1/statements/{_seg(statement_id)}/history",
                query=_compact(
                    {
                        "include_tombstoned": include_tombstoned or None,
                        "limit": limit,
                        "cursor": cursor,
                    }
                ),
                idempotent=True,
            )
        )

    # --- relation authoring -----------------------------------------------

    def create_relation(
        self,
        relation_type: str,
        from_entity: str,
        to_entity: str,
        confidence: float = 1.0,
        valid_from_unix_nanos: Optional[int] = None,
        valid_to_unix_nanos: Optional[int] = None,
        extractor_id: Optional[int] = None,
        session_id: Optional[int] = None,
        evidence: Optional[Sequence[str]] = None,
        properties: Optional[str] = None,
    ) -> CreateRelationResult:
        """Assert a typed edge between two entities."""
        return CreateRelationResult.from_dict(
            self._request(
                "POST",
                "/v1/relations",
                self._relation_body(
                    relation_type,
                    from_entity,
                    to_entity,
                    confidence,
                    valid_from_unix_nanos,
                    valid_to_unix_nanos,
                    extractor_id,
                    session_id,
                    evidence,
                    properties,
                ),
            )
        )

    def supersede_relation(
        self,
        relation_id: str,
        relation_type: str,
        from_entity: str,
        to_entity: str,
        confidence: float = 1.0,
        valid_from_unix_nanos: Optional[int] = None,
        valid_to_unix_nanos: Optional[int] = None,
        extractor_id: Optional[int] = None,
        session_id: Optional[int] = None,
        evidence: Optional[Sequence[str]] = None,
        properties: Optional[str] = None,
    ) -> SupersedeRelationResult:
        """Replace an edge with a revised one.

        The replacement REPLACES the property blob, which is why
        :meth:`get_relation` returns ``properties`` — a revision that only
        meant to change validity can carry the old ones back.
        """
        return SupersedeRelationResult.from_dict(
            self._request(
                "POST",
                f"/v1/relations/{_seg(relation_id)}/supersede",
                self._relation_body(
                    relation_type,
                    from_entity,
                    to_entity,
                    confidence,
                    valid_from_unix_nanos,
                    valid_to_unix_nanos,
                    extractor_id,
                    session_id,
                    evidence,
                    properties,
                ),
            )
        )

    def tombstone_relation(self, relation_id: str, reason: Optional[str] = None) -> TombstoneResult:
        """Retire an edge."""
        return TombstoneResult.from_dict(
            self._request(
                "DELETE",
                f"/v1/relations/{_seg(relation_id)}",
                query=_compact({"reason": reason}),
                idempotent=True,
            )
        )

    # --- schema introspection + drop --------------------------------------

    def list_schemas(
        self, limit: Optional[int] = None, cursor: Optional[str] = None
    ) -> ListSchemasResult:
        """The namespace's schema version history.

        Distinct from :meth:`get_schema`, which returns one document: this is
        what a caller about to upload needs to see what it is adding to.
        """
        return ListSchemasResult.from_dict(
            self._request(
                "GET",
                "/v1/schemas",
                query=_compact({"limit": limit, "cursor": cursor}),
                idempotent=True,
            )
        )

    def list_extractors(self) -> ListExtractorsResult:
        """The extractors registered on the shard.

        Read-only: extraction is always-on and cannot be toggled. Here so a
        caller reading ``extractor_id`` on a statement can find out what
        produced it.
        """
        return ListExtractorsResult.from_dict(
            self._request("GET", "/v1/extractors", idempotent=True)
        )

    def drop_schema(self, kind: str, name: str, force: bool = False) -> DropSchemaResult:
        """Drop one declared predicate or relation type.

        ``kind`` is ``predicate`` or ``relation_type``. Entity types are not
        droppable: they are global in the v1 storage model, so dropping one
        would race rows in other namespaces.

        ``force`` is consent to orphan live rows — they survive as plain
        memories no longer enriched from the typed-graph tables. A type
        nothing uses drops without it.
        """
        return DropSchemaResult.from_dict(
            self._request(
                "DELETE",
                f"/v1/schema/{_seg(kind)}/{_seg(name)}",
                query=_compact({"force": force or None}),
            )
        )

    # --- memory extras ----------------------------------------------------

    def encode_vector(
        self,
        text: str,
        vector: Sequence[float],
        model_fingerprint: str,
        session: Optional[int] = None,
        kind: Optional[int] = None,
        salience_hint: Optional[float] = None,
        deduplicate: bool = False,
    ) -> EncodeResult:
        """Store a memory with a caller-supplied embedding.

        ``model_fingerprint`` (16 bytes as 32 hex characters) is required:
        vectors from different models are not comparable, so a recall that
        mixed them would rank nonsense confidently.
        """
        return EncodeResult.from_dict(
            self._request(
                "POST",
                "/v1/memories/vector",
                _compact(
                    {
                        "text": text,
                        "vector": list(vector),
                        "model_fingerprint": model_fingerprint,
                        "session": session,
                        "kind": kind,
                        "salience_hint": salience_hint,
                        "deduplicate": deduplicate or None,
                    }
                ),
                idempotent=True,
            )
        )

    def materialize_procedural(
        self,
        sessions: Optional[Sequence[int]] = None,
        top_k: Optional[int] = None,
        min_confidence: float = 0.0,
        categories: Optional[Sequence[str]] = None,
    ) -> MaterializeProceduralResult:
        """Render the caller's remembered directives into a system-prompt block.

        Check :attr:`MaterializeProceduralResult.trimmed_by_budget`: ``True``
        means directives did not make it in, so the block is not the whole set.
        """
        return MaterializeProceduralResult.from_dict(
            self._request(
                "POST",
                "/v1/procedural/materialize",
                _compact(
                    {
                        "sessions": list(sessions) if sessions else None,
                        "top_k": top_k,
                        "min_confidence": min_confidence,
                        "categories": list(categories) if categories else None,
                    }
                ),
                idempotent=True,
            )
        )

    # --- query introspection ----------------------------------------------

    def query_explain(
        self,
        text: str,
        entity_anchor: Optional[str] = None,
        kinds: Optional[Sequence[str]] = None,
        predicates: Optional[Sequence[str]] = None,
        sessions: Optional[Sequence[int]] = None,
        time_range: Optional[Mapping[str, int]] = None,
        as_of_record_time_unix_nanos: Optional[int] = None,
        confidence_min: Optional[float] = None,
        include_tombstoned: bool = False,
        include_superseded: bool = False,
        limit: Optional[int] = None,
        retrievers: Optional[Sequence[str]] = None,
        fusion: Optional[Mapping[str, float]] = None,
    ) -> QueryExplainResult:
        """The plan Brain would run, and its estimated cost. Does NOT run it.

        ``time_range`` is when the content was true; ``as_of_record_time``
        is what was BELIEVED at a point in time. They are different axes, and
        collapsing them is how bi-temporal data stops being bi-temporal.

        Pin ``retrievers`` (``semantic`` / ``lexical`` / ``graph``) to answer
        "what would THIS plan cost"; leaving it to ``auto`` answers "what
        would the router pick today".
        """
        return QueryExplainResult.from_dict(
            self._request(
                "POST",
                "/v1/query/explain",
                self._query_body(
                    text,
                    entity_anchor,
                    kinds,
                    predicates,
                    sessions,
                    time_range,
                    as_of_record_time_unix_nanos,
                    confidence_min,
                    include_tombstoned,
                    include_superseded,
                    limit,
                    retrievers,
                    fusion,
                ),
                idempotent=True,
            )
        )

    def query_trace(
        self,
        text: str,
        entity_anchor: Optional[str] = None,
        kinds: Optional[Sequence[str]] = None,
        predicates: Optional[Sequence[str]] = None,
        sessions: Optional[Sequence[int]] = None,
        time_range: Optional[Mapping[str, int]] = None,
        as_of_record_time_unix_nanos: Optional[int] = None,
        confidence_min: Optional[float] = None,
        include_tombstoned: bool = False,
        include_superseded: bool = False,
        limit: Optional[int] = None,
        retrievers: Optional[Sequence[str]] = None,
        fusion: Optional[Mapping[str, float]] = None,
    ) -> QueryTraceResult:
        """Run the query and report what happened, with the measured latency.

        Unlike :meth:`query_explain`, this costs what the query costs.
        """
        return QueryTraceResult.from_dict(
            self._request(
                "POST",
                "/v1/query/trace",
                self._query_body(
                    text,
                    entity_anchor,
                    kinds,
                    predicates,
                    sessions,
                    time_range,
                    as_of_record_time_unix_nanos,
                    confidence_min,
                    include_tombstoned,
                    include_superseded,
                    limit,
                    retrievers,
                    fusion,
                ),
                idempotent=True,
            )
        )

    # --- BYOK provider credentials ----------------------------------------

    def put_llm_credential(self, provider: str, model: str, api_key: str) -> LlmCredential:
        """Register (or replace) this tenant's provider key.

        The edge verifies the key with the provider before storing it, and
        seals it on arrival; it is never returned.
        """
        return LlmCredential.from_dict(
            self._request(
                "PUT",
                "/v1/llm-credential",
                {"provider": provider, "model": model, "api_key": api_key},
            )
        )

    def get_llm_credential(self) -> LlmCredential:
        """What is installed for this tenant. Carries no key material."""
        return LlmCredential.from_dict(self._request("GET", "/v1/llm-credential", idempotent=True))

    def delete_llm_credential(self) -> LlmCredentialDeleted:
        """Remove this tenant's provider key.

        ``deleted: False`` means there was nothing there — which matters when
        the call is part of an incident response.
        """
        return LlmCredentialDeleted.from_dict(
            self._request("DELETE", "/v1/llm-credential", idempotent=True)
        )

    def test_llm_credential(self, provider: str, model: str, api_key: str) -> LlmCredentialCheck:
        """Check a key WITHOUT storing it.

        Nothing is written and nothing existing is touched, so this is safe
        against a namespace that already has a working credential.
        """
        return LlmCredentialCheck.from_dict(
            self._request(
                "POST",
                "/v1/llm-credential/test",
                {"provider": provider, "model": model, "api_key": api_key},
                idempotent=True,
            )
        )

    def verify_llm_credential(self) -> LlmCredentialCheck:
        """Re-check the key already stored.

        A key that worked at registration can be revoked or run out of credit
        later, where the first sign is otherwise an opaque upstream 401 on a
        write.
        """
        return LlmCredentialCheck.from_dict(
            self._request("POST", "/v1/llm-credential/verify", idempotent=True)
        )

    # --- change feed ------------------------------------------------------

    def subscribe(
        self,
        sessions: Optional[Sequence[int]] = None,
        kinds: Optional[Sequence[str]] = None,
        memories: Optional[Sequence[str]] = None,
        include_history: bool = False,
        from_lsn: Optional[int] = None,
        max_inflight: Optional[int] = None,
    ) -> Subscription:
        """Open the caller's change feed.

        Returns a :class:`Subscription` you iterate::

            with client.subscribe() as feed:
                for item in feed:
                    ...

        Unsubscribing is closing it — the edge tears the Brain-side
        subscription down when the response closes — so the context manager
        is the whole teardown, including on an exception.

        Every event carries an ``lsn``, and the subscription remembers the
        last one (:attr:`Subscription.last_event_id`). Pass it back as
        ``from_lsn`` on a reconnect to resume exactly rather than replay or
        skip.

        Not retried, deliberately. A retry would reopen the feed at the
        original position and re-deliver everything already seen; where to
        resume is the caller's decision, because only the caller knows where
        it got to.
        """
        query = _compact(
            {
                # Comma-separated on the wire, so a feed subscription is one
                # readable URL that survives being pasted into a shell.
                "sessions": ",".join(str(s) for s in sessions) if sessions else None,
                "kinds": ",".join(kinds) if kinds else None,
                "memories": ",".join(memories) if memories else None,
                "include_history": include_history or None,
                "from_lsn": from_lsn,
                "max_inflight": max_inflight,
            }
        )
        return self._open_stream("GET", "/v1/subscribe", query)

    def _open_stream(
        self, method: str, path: str, query: Optional[Mapping[str, Any]]
    ) -> Subscription:
        """Open a streaming response rather than reading a body to completion.

        Separate from :meth:`_request_once` because the two differ in every
        way that matters: no retry, no body read, and no response timeout —
        a subscription is long-lived by definition, and its liveness signal
        is the edge's keep-alive comment rather than a deadline.
        """
        url = self._base + path + _query_string(query)
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "accept": "text/event-stream",
        }
        req = urllib.request.Request(url, method=method, headers=headers)  # noqa: S310
        try:
            resp = urllib.request.urlopen(req)  # noqa: S310
        except urllib.error.HTTPError as e:
            raise self._error_from(e) from None
        except urllib.error.URLError as e:
            raise BrainHttpError(0, "transport", f"subscribe to {url} failed: {e.reason}") from None
        except (TimeoutError, OSError) as e:
            raise BrainHttpError(0, "transport", f"subscribe to {url} failed: {e}") from None
        return Subscription(resp)

    # --- shared body builders ---------------------------------------------
    #
    # `create` and `supersede` send the same shape for statements and for
    # relations — a supersede IS a create, under an old id — so the body is
    # built once rather than twice in each pair.

    @staticmethod
    def _query_body(
        text: str,
        entity_anchor: Optional[str],
        kinds: Optional[Sequence[str]],
        predicates: Optional[Sequence[str]],
        sessions: Optional[Sequence[int]],
        time_range: Optional[Mapping[str, int]],
        as_of_record_time_unix_nanos: Optional[int],
        confidence_min: Optional[float],
        include_tombstoned: bool,
        include_superseded: bool,
        limit: Optional[int],
        retrievers: Optional[Sequence[str]],
        fusion: Optional[Mapping[str, float]],
    ) -> dict[str, Any]:
        return _compact(
            {
                "text": text,
                "entity_anchor": entity_anchor,
                "kinds": list(kinds) if kinds else None,
                "predicates": list(predicates) if predicates else None,
                "sessions": list(sessions) if sessions else None,
                "time_range": dict(time_range) if time_range else None,
                "as_of_record_time_unix_nanos": as_of_record_time_unix_nanos,
                "confidence_min": confidence_min,
                "include_tombstoned": include_tombstoned or None,
                "include_superseded": include_superseded or None,
                "limit": limit,
                "retrievers": list(retrievers) if retrievers else None,
                "fusion": dict(fusion) if fusion else None,
            }
        )

    @staticmethod
    def _statement_body(
        kind: str,
        subject: str,
        predicate: str,
        obj: Mapping[str, Any],
        confidence: float,
        event_at_unix_nanos: Optional[int],
        valid_from_unix_nanos: Optional[int],
        valid_to_unix_nanos: Optional[int],
        extractor_id: Optional[int],
        schema_version: Optional[int],
        session_id: Optional[int],
        evidence: Optional[Sequence[str]],
    ) -> dict[str, Any]:
        return _compact(
            {
                "kind": kind,
                "subject": subject,
                "predicate": predicate,
                "object": dict(obj),
                "confidence": confidence,
                "event_at_unix_nanos": event_at_unix_nanos,
                "valid_from_unix_nanos": valid_from_unix_nanos,
                "valid_to_unix_nanos": valid_to_unix_nanos,
                "extractor_id": extractor_id,
                "schema_version": schema_version,
                "session_id": session_id,
                "evidence": list(evidence) if evidence else None,
            }
        )

    @staticmethod
    def _relation_body(
        relation_type: str,
        from_entity: str,
        to_entity: str,
        confidence: float,
        valid_from_unix_nanos: Optional[int],
        valid_to_unix_nanos: Optional[int],
        extractor_id: Optional[int],
        session_id: Optional[int],
        evidence: Optional[Sequence[str]],
        properties: Optional[str],
    ) -> dict[str, Any]:
        return _compact(
            {
                "relation_type": relation_type,
                "from_entity": from_entity,
                "to_entity": to_entity,
                "confidence": confidence,
                "valid_from_unix_nanos": valid_from_unix_nanos,
                "valid_to_unix_nanos": valid_to_unix_nanos,
                "extractor_id": extractor_id,
                "session_id": session_id,
                "evidence": list(evidence) if evidence else None,
                "properties": properties,
            }
        )

    # --- transport --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        idempotent: bool = False,
        query: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        """Send the request, retrying idempotent verbs per the policy on ``503``
        and transport/timeout failures. Non-idempotent verbs run exactly once."""
        attempt = 1
        while True:
            try:
                return self._request_once(method, path, body, query)
            except BrainHttpError as err:
                if idempotent and self._retry.should_retry(attempt, err):
                    delay = self._retry.backoff(attempt, err.retry_after)
                    time.sleep(delay)
                    attempt += 1
                    continue
                raise

    def _request_once(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]],
        query: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        url = self._base + path + _query_string(query)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"authorization": f"Bearer {self._api_key}"}
        if data is not None:
            headers["content-type"] = "application/json"
        # `__init__` rejects every scheme but http/https, which ruff cannot
        # see from this call site — hence the two S310 suppressions.
        req = urllib.request.Request(url, data=data, method=method, headers=headers)  # noqa: S310

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310
                text = resp.read().decode()
        except urllib.error.HTTPError as e:
            raise self._error_from(e) from None
        except urllib.error.URLError as e:
            raise BrainHttpError(0, "transport", f"request to {url} failed: {e.reason}") from None
        except (TimeoutError, OSError) as e:
            # A body-read timeout (past the connect handled by URLError above) or
            # a low-level socket error surfaces as transport, never a native raise.
            raise BrainHttpError(0, "transport", f"request to {url} failed: {e}") from None

        return json.loads(text) if text else {}

    @staticmethod
    def _error_from(e: urllib.error.HTTPError) -> BrainHttpError:
        code, message = "http_error", f"HTTP {e.code}"
        field_errors: list[FieldError] = []
        try:
            payload = json.loads(e.read().decode())
            err = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(err, dict):
                # brain-edge's envelope.
                code = err.get("code", code)
                message = err.get("message", message)
            elif isinstance(payload, dict) and isinstance(payload.get("code"), str):
                # The cloud gateway's RFC 9457 `application/problem+json`.
                code = payload["code"]
                for key in ("detail", "title"):
                    if isinstance(payload.get(key), str):
                        message = payload[key]
                        break
                field_errors = _field_errors(payload.get("errors"))
                if field_errors:
                    # "one or more fields are invalid" says nothing; name the
                    # fields. Without this the same 422 that tells a TypeScript
                    # caller `email: must be valid` tells a Python one nothing.
                    message = "; ".join(f"{f.field}: {f.message}" for f in field_errors)
        except Exception:  # noqa: BLE001 - best-effort error body parse
            pass
        out = BrainHttpError(e.code, code, message, field_errors)
        # Attach a server Retry-After hint (integer seconds) for the retry
        # scheduler. Not part of the public {status, code, message} shape.
        out.retry_after = _parse_retry_after(e)
        return out


def _compact(d: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so optional fields are omitted from the body."""
    return {k: v for k, v in d.items() if v is not None}


def _seg(value: str) -> str:
    """One path segment, percent-encoded.

    ``safe=""`` so that a ``/`` inside an id cannot open a second segment and
    silently address a different route.
    """
    return urllib.parse.quote(str(value), safe="")


def _query_string(query: Optional[Mapping[str, Any]]) -> str:
    """``?a=1&b=true`` for a filled query, else the empty string.

    ``None`` values are dropped rather than sent: every optional field on the
    edge's query structs is ``#[serde(default)]``, so an omitted param takes the
    edge's default while an explicit ``none`` would be a parse error. Booleans
    are lowercased — Python's ``True`` is not what serde reads back as ``bool``.
    """
    if not query:
        return ""
    pairs = [
        (k, "true" if v is True else "false" if v is False else str(v))
        for k, v in query.items()
        if v is not None
    ]
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


def _field_errors(raw: object) -> list[FieldError]:
    """The well-formed entries of an RFC 9457 ``errors[]``.

    An entry missing ``field`` or ``message`` is dropped rather than rendered
    as a half-empty ``": "`` line in the joined message.
    """
    if not isinstance(raw, list):
        return []
    out: list[FieldError] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        field, message = item.get("field"), item.get("message")
        if isinstance(field, str) and isinstance(message, str):
            code = item.get("code")
            out.append(FieldError(field, message, code if isinstance(code, str) else None))
    return out


def _parse_retry_after(e: urllib.error.HTTPError) -> Optional[float]:
    """A ``Retry-After`` header expressed as integer seconds, else ``None``
    (HTTP-date form is ignored, leaving the computed backoff in force)."""
    try:
        raw = e.headers.get("Retry-After") if e.headers is not None else None
        if raw is not None:
            return float(int(raw.strip()))
    except (ValueError, AttributeError):
        pass
    return None
