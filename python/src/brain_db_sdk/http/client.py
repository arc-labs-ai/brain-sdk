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

from .errors import BrainHttpError
from .retry import HttpRetryPolicy
from .types import (
    Capabilities,
    CreateEntityResult,
    EncodeResult,
    EntityDetail,
    ForgetResult,
    GraphPage,
    LinkResult,
    ListEntitiesResult,
    ListRelationsResult,
    ListStatementsResult,
    MemoryInspect,
    MemoryListPage,
    PlanResult,
    ReasonResult,
    RecallResult,
    RelationDetail,
    ResolveEntityResult,
    Schema,
    SchemaReplace,
    SchemaUpload,
    SchemaValidate,
    StatementDetail,
    TraverseResult,
    UnlinkResult,
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
        body = _compact({"text": text, "session": session, "occurred_at": occurred_at})
        return EncodeResult.from_dict(self._request("POST", "/v1/memories", body, idempotent=True))

    def recall(
        self,
        query: str,
        max_results: Optional[int] = None,
        subject: Optional[str] = None,
    ) -> RecallResult:
        """Recall memories for a cue."""
        body = _compact({"query": query, "max_results": max_results, "subject": subject})
        return RecallResult.from_dict(self._request("POST", "/v1/recall", body))

    def forget(self, memory_id: str, hard: bool = False) -> ForgetResult:
        """Forget a memory."""
        return ForgetResult.from_dict(
            self._request("DELETE", "/v1/memories", {"memory_id": memory_id, "hard": hard})
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
        return UnlinkResult.from_dict(self._request("DELETE", "/v1/links", body))

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
        return PlanResult.from_dict(self._request("POST", "/v1/plan", body))

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
        return ReasonResult.from_dict(self._request("POST", "/v1/reason", body))

    def whoami(self) -> Whoami:
        """The identity Brain resolves from the credential."""
        return Whoami.from_dict(self._request("GET", "/v1/whoami", idempotent=True))

    def capabilities(self) -> Capabilities:
        """What the connected shard supports."""
        return Capabilities.from_dict(self._request("GET", "/v1/capabilities", idempotent=True))

    # --- memories ---------------------------------------------------------

    def list_memories(
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

    def inspect_memory(self, memory_id: str) -> MemoryInspect:
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
    ) -> ListEntitiesResult:
        """Entities in the space, optionally filtered."""
        query = _compact(
            {
                "type_id": type_id,
                "prefix": prefix,
                "mention_count_min": mention_count_min,
                "include_tombstoned": include_tombstoned,
                "include_merged": include_merged,
                "limit": limit,
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

    def traverse(
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
            self._request("POST", f"/v1/entities/{_seg(entity_id)}/traverse", body)
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
    ) -> ListRelationsResult:
        """Relations touching one entity.

        ``relation_type`` goes on the wire as ``type`` — the edge's query struct
        renames it, because ``type`` is a Rust keyword there just as it is a
        builtin here.
        """
        query = _compact(
            {
                "direction": direction,
                "type": relation_type,
                "include_superseded": include_superseded,
                "include_tombstoned": include_tombstoned,
                "limit": limit,
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
    ) -> ListStatementsResult:
        """Statements in the space, optionally filtered."""
        query = _compact(
            {
                "subject": subject,
                "predicate": predicate,
                "kind": kind,
                "min_confidence": min_confidence,
                "only_current": only_current,
                "include_tombstoned": include_tombstoned,
                "limit": limit,
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

    def fetch_graph(
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
                    delay = self._retry.backoff(attempt, getattr(err, "retry_after", None))
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
        try:
            payload = json.loads(e.read().decode())
            err = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(err, dict):
                code = err.get("code", code)
                message = err.get("message", message)
        except Exception:  # noqa: BLE001 - best-effort error body parse
            pass
        out = BrainHttpError(e.code, code, message)
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
