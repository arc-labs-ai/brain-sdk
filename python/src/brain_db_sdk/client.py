"""The high-level client: connect, handshake, and serve the v1 +
typed-graph verbs over a multiplexed connection.

:meth:`BrainClient.connect` opens a TCP connection, runs the handshake,
and returns a client bound to the session the server granted. The client
sits on a :class:`~brain_db_sdk.mux.MuxConnection`, so every verb shares
one socket and many requests run in flight at once from multiple threads.
The API is synchronous. To add retry, wrap a verb call in
:func:`~brain_db_sdk.retry.with_retry`; the stable ``request_id`` each
builder mints makes the resend idempotent server-side.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import TypeVar

from .errors import ProtocolError
from .mux import MuxConnection, Subscription
from .wire.opcode import Opcode
from .wire.types import (
    AnswerKind,
    AuthCredentials,
    AuthMethod,
    AuthPayload,
    CancelStreamAck,
    CancelStreamRequest,
    EncodeRequest,
    EncodeResponse,
    EncodeVectorDirectRequest,
    EntityCreateRequest,
    EntityCreateResponse,
    EntityGetRequest,
    EntityGetResponse,
    EntityListItem,
    EntityListRequest,
    EntityListResponseFrame,
    EntityMergeRequest,
    EntityMergeResponse,
    EntityRenameRequest,
    EntityRenameResponse,
    EntityResolveRequest,
    EntityResolveResponse,
    EntityTombstoneRequest,
    EntityTombstoneResponse,
    EntityUnmergeRequest,
    EntityUnmergeResponse,
    EntityUpdateRequest,
    EntityUpdateResponse,
    ExtractorListRequest,
    ExtractorListResponseFrame,
    ForgetRequest,
    ForgetResponse,
    GetCapabilitiesRequest,
    GetCapabilitiesResponse,
    GraphEdge,
    GraphFetchRequest,
    GraphFetchResponseFrame,
    GraphNode,
    HelloCapabilities,
    HelloPayload,
    InferenceStep,
    LinkRequest,
    LinkResponse,
    MaterializeProceduralRequest,
    MaterializeProceduralResponse,
    MemoryInspectRequest,
    MemoryInspectResponse,
    MemoryListItem,
    MemoryListRequest,
    MemoryListResponseFrame,
    MemoryResult,
    MtlsClaim,
    PlanRequest,
    PlanResponseFrame,
    PlanStep,
    QueryExplainRequest,
    QueryExplainResponse,
    QueryTraceRequest,
    QueryTraceResponse,
    ReasonRequest,
    ReasonResponseFrame,
    RecallAnswer,
    RecallRequest,
    RecallResponseFrame,
    RelationCreateRequest,
    RelationCreateResponse,
    RelationGetRequest,
    RelationGetResponse,
    RelationListFromRequest,
    RelationListFromResponseFrame,
    RelationListToRequest,
    RelationListToResponseFrame,
    RelationSupersedeRequest,
    RelationSupersedeResponse,
    RelationTombstoneRequest,
    RelationTombstoneResponse,
    RelationTraverseRequest,
    RelationTraverseResponseFrame,
    RelationView,
    SchemaGetRequest,
    SchemaGetResponse,
    SchemaListItem,
    SchemaListRequest,
    SchemaListResponseFrame,
    SchemaReplaceRequest,
    SchemaReplaceResponse,
    SchemaUploadRequest,
    SchemaUploadResponse,
    SchemaValidateRequest,
    SchemaValidateResponse,
    ServerFeatures,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionDeleteRequest,
    SessionDeleteResponse,
    SessionListRequest,
    SessionListResponse,
    SpaceCreateRequest,
    SpaceCreateResponse,
    SpaceDeleteRequest,
    SpaceDeleteResponse,
    SpaceListRequest,
    SpaceListResponse,
    SpacePermissions,
    StatementCreateRequest,
    StatementCreateResponse,
    StatementGetRequest,
    StatementGetResponse,
    StatementHistoryRequest,
    StatementHistoryResponseFrame,
    StatementListRequest,
    StatementListResponseFrame,
    StatementRetractRequest,
    StatementRetractResponse,
    StatementSupersedeRequest,
    StatementSupersedeResponse,
    StatementTombstoneRequest,
    StatementTombstoneResponse,
    StatementView,
    SubscribeRequest,
    TraversalPathWire,
    TxnAbortRequest,
    TxnAbortResponse,
    TxnBeginRequest,
    TxnBeginResponse,
    TxnCommitRequest,
    TxnCommitResponse,
    UnlinkRequest,
    UnlinkResponse,
    _WirePayload,
    decode_payload,
    encode_payload,
)

# Default ``client_id`` advertised in HELLO.
DEFAULT_CLIENT_ID = "brain-db-sdk-python"


def new_id() -> bytes:
    """Mint a fresh 16-byte identifier (a random UUID's bytes)."""
    return uuid.uuid4().bytes


# Root namespace UUID for space-id derivation. The server's frozen seed — the
# exact 16 bytes it pins in brain-core, replicated here byte-for-byte (they must
# match, or a space string resolves to different ids on each side). The seed is
# pinned by a golden test on both sides.
_BRAIN_ROOT_NAMESPACE_UUID = uuid.UUID(
    bytes=bytes(
        [
            0x6B,
            0x72,
            0x61,
            0x69,
            0x6E,
            0x2D,
            0x73,
            0x70,
            0x61,
            0x63,
            0x65,
            0x2D,
            0x72,
            0x6F,
            0x6F,
            0x74,
        ]
    )
)


def derive_space_id(namespace: str, space: str) -> bytes:
    """Derive the 16-byte storage space id from a structured space string,
    exactly as the server does at ingress: ``UUIDv5(UUIDv5(ROOT, namespace),
    space)``. Folding the namespace makes equal strings under different
    namespaces diverge. Clients only ever *send* the space string; this is for
    the rare cases that need the resolved id locally — e.g. a subscription
    filter naming the effective space by its resolved id. The seed is frozen and
    pinned by a golden test on both sides."""
    ns = uuid.uuid5(_BRAIN_ROOT_NAMESPACE_UUID, namespace)
    return uuid.uuid5(ns, space).bytes


@dataclass(frozen=True)
class Auth:
    """How the client authenticates after WELCOME. Auth is mandatory: there is
    no anonymous mode. The credential is the connection's whole identity — the
    server resolves ``(namespace, space, permissions)`` from it and refuses any
    connection it cannot resolve."""

    # The on-wire discriminant. `AuthMethod` is a constant namespace, not
    # a type — annotating this as `AuthMethod` claimed the field holds an
    # instance of that class while every value assigned is an int, which
    # a type checker rejects at both the construction and the handoff to
    # `AuthPayload`. See `AuthMethod.TOKEN` / `AuthMethod.MTLS`.
    method: int
    credentials: AuthCredentials

    @staticmethod
    def token(token: bytes) -> Auth:
        """A shared bearer token."""
        return Auth(AuthMethod.TOKEN, AuthCredentials.token(token))

    @staticmethod
    def mtls(claim: MtlsClaim) -> Auth:
        """An mTLS subject claim."""
        return Auth(AuthMethod.MTLS, AuthCredentials.mtls(claim))


@dataclass
class ClientConfig:
    """Connection configuration. ``auth`` is mandatory — the credential is the
    connection's identity and the server assigns the space and namespace; a
    config cannot be built without one. The remaining fields default to a
    local/dev server: wire version 1, streaming advertised."""

    auth: Auth
    client_id: str = DEFAULT_CLIENT_ID
    supported_versions: list[int] = field(default_factory=lambda: [1])
    capabilities: HelloCapabilities = field(
        default_factory=lambda: HelloCapabilities(
            streaming=True, compression_zstd=False, server_push=False
        )
    )
    connect_timeout: float | None = 10.0
    request_timeout: float | None = 30.0


@dataclass(frozen=True)
class ConnectionInfo:
    """The connection the server granted at handshake time."""

    space_id: bytes
    server_id: str
    chosen_version: int
    connection_id: bytes
    bound_shard_id: int
    permissions: SpacePermissions
    # Owning tenant the server bound this connection to (server-derived from
    # auth). Empty when the connection resolves to the reserved `brain` system
    # namespace. Read-only — the client never sends a namespace.
    namespace: str
    server_features: ServerFeatures


# `type[_T]` on the decode helpers below: the response type a caller passes in
# is the type that comes back, which an un-annotated parameter could not say.
_T = TypeVar("_T")
# Stands in for `typing.Self`, which is 3.11+; requires-python here is >=3.9.
_SelfClient = TypeVar("_SelfClient", bound="BrainClient")


class BrainClient:
    """A connected, handshaken Brain client over a multiplexed connection.

    Verbs are served on a :class:`~brain_db_sdk.mux.MuxConnection`, whose
    background reader thread demultiplexes responses by ``stream_id`` — so a
    single client serves many requests in flight at once from multiple threads.
    """

    def __init__(self, conn: MuxConnection, connection: ConnectionInfo) -> None:
        self._conn = conn
        self._connection = connection

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        auth: Auth,
    ) -> BrainClient:
        """Connect to ``host:port`` with the given credential and default
        transport settings, run the handshake, and return the bound client. The
        credential is mandatory — the server resolves the connection's identity
        from it. For full control over the configuration, use
        :meth:`connect_with`."""
        return cls.connect_with(host, port, ClientConfig(auth=auth))

    @classmethod
    def connect_with(
        cls,
        host: str,
        port: int,
        config: ClientConfig,
    ) -> BrainClient:
        """Connect to ``host:port`` with an explicit configuration, run the
        handshake, and return the bound client."""
        hello = HelloPayload(
            client_id=config.client_id,
            supported_versions=list(config.supported_versions),
            capabilities=config.capabilities,
            client_connection_token=None,
        )
        auth = AuthPayload(
            method=config.auth.method,
            credentials=config.auth.credentials,
        )
        conn, outcome = MuxConnection.connect(
            host,
            port,
            hello,
            auth,
            connect_timeout=config.connect_timeout,
            request_timeout=config.request_timeout,
        )
        # AUTH_OK decodes ``permissions`` as a raw map; lift it to the typed
        # form so callers get attribute access.
        permissions = outcome.auth_ok.permissions
        if isinstance(permissions, dict):
            permissions = SpacePermissions.from_map(permissions)
        connection = ConnectionInfo(
            space_id=outcome.auth_ok.space_id,
            server_id=outcome.welcome.server_id,
            chosen_version=outcome.welcome.chosen_version,
            connection_id=outcome.welcome.connection_id,
            bound_shard_id=outcome.auth_ok.bound_shard_id,
            permissions=permissions,
            namespace=outcome.auth_ok.namespace,
            server_features=outcome.welcome.server_features,
        )
        return cls(conn, connection)

    @property
    def connection(self) -> ConnectionInfo:
        """The negotiated connection."""
        return self._connection

    @property
    def space_id(self) -> bytes:
        """The space id (derived 16-byte storage id) this connection acts as."""
        return self._connection.space_id

    @property
    def namespace(self) -> str:
        """The owning tenant the server bound this connection to (server-derived
        from auth). Empty when the connection resolves to the reserved ``brain``
        system namespace. Read-only — the client never sends a namespace."""
        return self._connection.namespace

    def encode(self, request: EncodeRequest) -> EncodeResponse:
        """Store a memory from text (ENCODE). The server owns the embedding,
        kind classification, salience, and edge extraction."""
        frame = self._conn.request_one(Opcode.ENCODE_REQ, encode_payload(request))
        if frame.opcode != int(Opcode.ENCODE_RESP):
            raise ProtocolError(
                f"expected ENCODE_RESP ({int(Opcode.ENCODE_RESP):#06x}), got {frame.opcode:#06x}"
            )
        return decode_payload(EncodeResponse, frame.payload)

    def encode_vector_direct(self, request: EncodeVectorDirectRequest) -> EncodeResponse:
        """Write a pre-computed embedding directly (ENCODE_VECTOR_DIRECT),
        bypassing the server's owned embedding. The vector rides the trailing
        raw little-endian f32 section of the frame, not the CBOR map;
        ``encode_payload`` appends it at the codec seam."""
        return self._unary(
            Opcode.ENCODE_VECTOR_DIRECT_REQ,
            Opcode.ENCODE_VECTOR_DIRECT_RESP,
            EncodeResponse,
            request,
        )

    def recall(self, request: RecallRequest) -> RecallAnswer:
        """Retrieve the memory for a cue. RECALL streams one or more
        ``RECALL_RESP`` frames terminated by EOS; this drains them into a
        :class:`RecallAnswer` whose ``answer_kind`` is the terminal frame's and
        whose ``memories`` are concatenated across every frame.

        ``answer_kind`` says how to read it: ``Single`` / ``Many`` carry the
        answering ``memories``; ``None`` carries an empty list (nothing stored
        answers the cue). Use :meth:`recall_frames` for the raw streamed frames
        (cumulative counts, ``estimated_remaining``).
        """
        frames = self.recall_frames(request)
        memories: list[MemoryResult] = []
        answer_kind = AnswerKind.NONE
        for frame in frames:
            memories.extend(frame.memories)
            answer_kind = frame.answer_kind
        return RecallAnswer(answer_kind=answer_kind, memories=memories)

    def recall_frames(self, request: RecallRequest) -> list[RecallResponseFrame]:
        """Retrieve memories by cue, returning each decoded ``RECALL_RESP``
        frame as streamed (preserving ``is_final`` / ``cumulative_count`` /
        ``estimated_remaining``). The last frame carries the EOS flag."""
        frames = self._conn.request(Opcode.RECALL_REQ, encode_payload(request))
        out: list[RecallResponseFrame] = []
        for frame in frames:
            if frame.opcode != int(Opcode.RECALL_RESP):
                raise ProtocolError(
                    f"expected RECALL_RESP ({int(Opcode.RECALL_RESP):#06x}), got "
                    f"{frame.opcode:#06x}"
                )
            out.append(decode_payload(RecallResponseFrame, frame.payload))
        return out

    def forget(self, request: ForgetRequest) -> ForgetResponse:
        """Forget a memory (soft tombstone or hard zeroing, per the request)."""
        frame = self._conn.request_one(Opcode.FORGET_REQ, encode_payload(request))
        if frame.opcode != int(Opcode.FORGET_RESP):
            raise ProtocolError(
                f"expected FORGET_RESP ({int(Opcode.FORGET_RESP):#06x}), got {frame.opcode:#06x}"
            )
        return decode_payload(ForgetResponse, frame.payload)

    def memory_list(self, request: MemoryListRequest) -> list[MemoryListItem]:
        """List memories (MEMORY_LIST), flattening every streamed frame's
        ``items`` into one ordered list. This is a pure paginated enumeration of
        the caller's ``(namespace, space)`` memories — no query, no ranking. For
        the raw streamed frames (cursors, cumulative counts, ``is_final``), use
        :meth:`memory_list_frames`."""
        items: list[MemoryListItem] = []
        for frame in self.memory_list_frames(request):
            items.extend(frame.items)
        return items

    def memory_list_frames(self, request: MemoryListRequest) -> list[MemoryListResponseFrame]:
        """List memories, returning each decoded MEMORY_LIST_RESP frame as
        streamed (preserving ``next_cursor`` / ``cumulative_count`` /
        ``is_final``)."""
        return self._streamed(
            Opcode.MEMORY_LIST_REQ,
            Opcode.MEMORY_LIST_RESP,
            MemoryListResponseFrame,
            request,
        )

    def memory_inspect(self, request: MemoryInspectRequest) -> MemoryInspectResponse:
        """Inspect one memory's durable write-artifact bundle (MEMORY_INSPECT):
        its text plus the per-stage record of what the write built — the
        embedding vector, the stored record, the analyzed keyword terms, the
        write-time HyPE questions, and the extracted knowledge graph. Returns
        ``found = False`` (with an empty ``artifact``) for an id that doesn't
        exist under the caller's scope."""
        return self._unary(
            Opcode.MEMORY_INSPECT_REQ,
            Opcode.MEMORY_INSPECT_RESP,
            MemoryInspectResponse,
            request,
        )

    def graph_fetch(self, request: GraphFetchRequest) -> tuple[list[GraphNode], list[GraphEdge]]:
        """Export the caller's typed graph (GRAPH_FETCH), flattening every
        streamed frame's nodes + edges into two ordered lists. Nodes/edges may
        repeat across pages (completeness, not disjointness) — dedup by id if
        needed. For the raw streamed frames (cursors, ``is_final``), use
        :meth:`graph_fetch_frames`."""
        nodes: list[GraphNode] = []
        edges: list[GraphEdge] = []
        for frame in self.graph_fetch_frames(request):
            nodes.extend(frame.nodes)
            edges.extend(frame.edges)
        return nodes, edges

    def graph_fetch_frames(self, request: GraphFetchRequest) -> list[GraphFetchResponseFrame]:
        """Export the typed graph, returning each decoded GRAPH_FETCH_RESP frame
        as streamed (preserving ``next_cursor`` / ``is_final``)."""
        return self._streamed(
            Opcode.GRAPH_FETCH_REQ,
            Opcode.GRAPH_FETCH_RESP,
            GraphFetchResponseFrame,
            request,
        )

    def create_entity(self, request: EntityCreateRequest) -> EntityCreateResponse:
        """Create a typed entity (ENTITY_CREATE)."""
        return self._unary(
            Opcode.ENTITY_CREATE_REQ, Opcode.ENTITY_CREATE_RESP, EntityCreateResponse, request
        )

    def create_statement(self, request: StatementCreateRequest) -> StatementCreateResponse:
        """Create a statement (STATEMENT_CREATE). The response reports any
        auto-superseded prior statement and the supersession chain root."""
        return self._unary(
            Opcode.STATEMENT_CREATE_REQ,
            Opcode.STATEMENT_CREATE_RESP,
            StatementCreateResponse,
            request,
        )

    def update_entity(self, request: EntityUpdateRequest) -> EntityUpdateResponse:
        """Replace an entity's name, aliases, and attributes (ENTITY_UPDATE)."""
        return self._unary(
            Opcode.ENTITY_UPDATE_REQ, Opcode.ENTITY_UPDATE_RESP, EntityUpdateResponse, request
        )

    def rename_entity(self, request: EntityRenameRequest) -> EntityRenameResponse:
        """Rename an entity, optionally keeping the old name as an alias
        (ENTITY_RENAME)."""
        return self._unary(
            Opcode.ENTITY_RENAME_REQ, Opcode.ENTITY_RENAME_RESP, EntityRenameResponse, request
        )

    def merge_entities(self, request: EntityMergeRequest) -> EntityMergeResponse:
        """Merge two entities that are the same real-world thing (ENTITY_MERGE).
        Reversible within the returned grace window via :meth:`unmerge_entity`."""
        return self._unary(
            Opcode.ENTITY_MERGE_REQ, Opcode.ENTITY_MERGE_RESP, EntityMergeResponse, request
        )

    def unmerge_entity(self, request: EntityUnmergeRequest) -> EntityUnmergeResponse:
        """Undo a merge within its grace window (ENTITY_UNMERGE)."""
        return self._unary(
            Opcode.ENTITY_UNMERGE_REQ, Opcode.ENTITY_UNMERGE_RESP, EntityUnmergeResponse, request
        )

    def tombstone_entity(self, request: EntityTombstoneRequest) -> EntityTombstoneResponse:
        """Retire an entity with an audit reason (ENTITY_TOMBSTONE). Soft: the
        row survives but drops out of resolution and traversal."""
        return self._unary(
            Opcode.ENTITY_TOMBSTONE_REQ,
            Opcode.ENTITY_TOMBSTONE_RESP,
            EntityTombstoneResponse,
            request,
        )

    def supersede_statement(self, request: StatementSupersedeRequest) -> StatementSupersedeResponse:
        """Replace a statement with a revised one (STATEMENT_SUPERSEDE), keeping
        both on the same chain so history is preserved."""
        return self._unary(
            Opcode.STATEMENT_SUPERSEDE_REQ,
            Opcode.STATEMENT_SUPERSEDE_RESP,
            StatementSupersedeResponse,
            request,
        )

    def tombstone_statement(self, request: StatementTombstoneRequest) -> StatementTombstoneResponse:
        """Retire a statement with a coded reason (STATEMENT_TOMBSTONE). Soft and
        recoverable."""
        return self._unary(
            Opcode.STATEMENT_TOMBSTONE_REQ,
            Opcode.STATEMENT_TOMBSTONE_RESP,
            StatementTombstoneResponse,
            request,
        )

    def retract_statement(self, request: StatementRetractRequest) -> StatementRetractResponse:
        """Assert a statement was wrong (STATEMENT_RETRACT). Unlike a tombstone,
        retraction schedules a hard-zero so a genuine mistake gets scrubbed."""
        return self._unary(
            Opcode.STATEMENT_RETRACT_REQ,
            Opcode.STATEMENT_RETRACT_RESP,
            StatementRetractResponse,
            request,
        )

    def statement_history(self, request: StatementHistoryRequest) -> list[StatementView]:
        """Walk a claim's full version chain (STATEMENT_HISTORY), flattening
        every streamed frame's ``items``. For the raw frames, use
        :meth:`statement_history_frames`."""
        items: list[StatementView] = []
        for frame in self.statement_history_frames(request):
            items.extend(frame.items)
        return items

    def statement_history_frames(
        self, request: StatementHistoryRequest
    ) -> list[StatementHistoryResponseFrame]:
        """Walk a claim's version chain, returning each decoded STATEMENT_HISTORY
        frame (with ``total_versions`` / ``is_final``)."""
        return self._streamed(
            Opcode.STATEMENT_HISTORY_REQ,
            Opcode.STATEMENT_HISTORY_RESP,
            StatementHistoryResponseFrame,
            request,
        )

    def create_relation(self, request: RelationCreateRequest) -> RelationCreateResponse:
        """Create a relation between two entities (RELATION_CREATE)."""
        return self._unary(
            Opcode.RELATION_CREATE_REQ,
            Opcode.RELATION_CREATE_RESP,
            RelationCreateResponse,
            request,
        )

    def get_relation(self, request: RelationGetRequest) -> RelationGetResponse:
        """Fetch one relation by id (RELATION_GET). ``follow_supersession``
        returns the current chain head when the id has been superseded."""
        return self._unary(
            Opcode.RELATION_GET_REQ, Opcode.RELATION_GET_RESP, RelationGetResponse, request
        )

    def supersede_relation(self, request: RelationSupersedeRequest) -> RelationSupersedeResponse:
        """Revise a relation, keeping both on one chain (RELATION_SUPERSEDE)."""
        return self._unary(
            Opcode.RELATION_SUPERSEDE_REQ,
            Opcode.RELATION_SUPERSEDE_RESP,
            RelationSupersedeResponse,
            request,
        )

    def tombstone_relation(self, request: RelationTombstoneRequest) -> RelationTombstoneResponse:
        """Soft-retire a relation with a reason (RELATION_TOMBSTONE)."""
        return self._unary(
            Opcode.RELATION_TOMBSTONE_REQ,
            Opcode.RELATION_TOMBSTONE_RESP,
            RelationTombstoneResponse,
            request,
        )

    def traverse_relations(self, request: RelationTraverseRequest) -> list[TraversalPathWire]:
        """Multi-hop walk of the relation graph from an entity
        (RELATION_TRAVERSE), flattening every streamed frame's ``paths`` into
        one ordered list. For the raw frames (with ``truncated`` /
        ``total_paths``), use :meth:`traverse_relations_frames`."""
        paths: list[TraversalPathWire] = []
        for frame in self.traverse_relations_frames(request):
            paths.extend(frame.paths)
        return paths

    def traverse_relations_frames(
        self, request: RelationTraverseRequest
    ) -> list[RelationTraverseResponseFrame]:
        """Traverse the relation graph, returning each decoded
        RELATION_TRAVERSE_RESP frame."""
        return self._streamed(
            Opcode.RELATION_TRAVERSE_REQ,
            Opcode.RELATION_TRAVERSE_RESP,
            RelationTraverseResponseFrame,
            request,
        )

    def upload_schema(self, request: SchemaUploadRequest) -> SchemaUploadResponse:
        """Upload a schema document (SCHEMA_UPLOAD). With ``dry_run`` set the
        server validates without applying; the response carries any validation
        errors and a backward-compatibility verdict."""
        return self._unary(
            Opcode.SCHEMA_UPLOAD_REQ, Opcode.SCHEMA_UPLOAD_RESP, SchemaUploadResponse, request
        )

    def query_explain(self, request: QueryExplainRequest) -> QueryExplainResponse:
        """Return a query's plan without running it (QUERY_EXPLAIN)."""
        return self._unary(
            Opcode.QUERY_EXPLAIN_REQ, Opcode.QUERY_EXPLAIN_RESP, QueryExplainResponse, request
        )

    def query_trace(self, request: QueryTraceRequest) -> QueryTraceResponse:
        """Run a query and return its per-stage execution trace (QUERY_TRACE)."""
        return self._unary(
            Opcode.QUERY_TRACE_REQ, Opcode.QUERY_TRACE_RESP, QueryTraceResponse, request
        )

    def materialize_procedural(
        self, request: MaterializeProceduralRequest
    ) -> MaterializeProceduralResponse:
        """Materialize a procedural-memory system block (MATERIALIZE_PROCEDURAL)."""
        return self._unary(
            Opcode.MATERIALIZE_PROCEDURAL_REQ,
            Opcode.MATERIALIZE_PROCEDURAL_RESP,
            MaterializeProceduralResponse,
            request,
        )

    def create_space(self, request: SpaceCreateRequest) -> SpaceCreateResponse:
        """Provision the caller's effective space explicitly (SPACE_CREATE).
        Idempotent: a create for an existing space returns the existing row
        with ``created=False``."""
        return self._unary(
            Opcode.SPACE_CREATE_REQ, Opcode.SPACE_CREATE_RESP, SpaceCreateResponse, request
        )

    def list_spaces(self, request: SpaceListRequest) -> SpaceListResponse:
        """List the caller's namespace's spaces (SPACE_LIST). ``limit == 0``
        means no cap; ``cross_shard_complete`` is False when the listing covers
        only the caller-shard's spaces."""
        return self._unary(
            Opcode.SPACE_LIST_REQ, Opcode.SPACE_LIST_RESP, SpaceListResponse, request
        )

    def delete_space(self, request: SpaceDeleteRequest) -> SpaceDeleteResponse:
        """GDPR-erase the caller's effective space (SPACE_DELETE): every row
        under ``(namespace, space)``, hard and immediate."""
        return self._unary(
            Opcode.SPACE_DELETE_REQ, Opcode.SPACE_DELETE_RESP, SpaceDeleteResponse, request
        )

    def create_session(self, request: SessionCreateRequest) -> SessionCreateResponse:
        """Provision a session under the caller's effective space
        (SESSION_CREATE). Idempotent."""
        return self._unary(
            Opcode.SESSION_CREATE_REQ,
            Opcode.SESSION_CREATE_RESP,
            SessionCreateResponse,
            request,
        )

    def list_sessions(self, request: SessionListRequest) -> SessionListResponse:
        """List one space's sessions newest-first (SESSION_LIST). ``limit == 0``
        means no cap. A first-class end-user feature for enumerating a space's
        conversation/run groupings."""
        return self._unary(
            Opcode.SESSION_LIST_REQ, Opcode.SESSION_LIST_RESP, SessionListResponse, request
        )

    def delete_session(self, request: SessionDeleteRequest) -> SessionDeleteResponse:
        """Delete a session's memories + graph rows (SESSION_DELETE). Soft
        (7-day grace) by default; ``hard=True`` zeroes immediately. The default
        session (``session_id = 0``) is non-deletable."""
        return self._unary(
            Opcode.SESSION_DELETE_REQ,
            Opcode.SESSION_DELETE_RESP,
            SessionDeleteResponse,
            request,
        )

    def link(self, request: LinkRequest) -> LinkResponse:
        """Create or reweight an edge between two memories (LINK). Returns
        whether the edge already existed (LINK overwrote its weight)."""
        return self._unary(Opcode.LINK_REQ, Opcode.LINK_RESP, LinkResponse, request)

    def unlink(self, request: UnlinkRequest) -> UnlinkResponse:
        """Remove an edge identified by ``(source, kind, target)`` (UNLINK).
        Idempotent: removing a non-existent edge succeeds with ``removed=False``.
        """
        return self._unary(Opcode.UNLINK_REQ, Opcode.UNLINK_RESP, UnlinkResponse, request)

    def capabilities(
        self, request: GetCapabilitiesRequest | None = None
    ) -> GetCapabilitiesResponse:
        """Introspect the connected shard's live capabilities (GET_CAPABILITIES):
        whether the reranker is loaded, which extractor tiers are enabled, the
        active user schema namespaces, and the embedding dimensionality."""
        request = request or GetCapabilitiesRequest()
        return self._unary(
            Opcode.GET_CAPABILITIES_REQ,
            Opcode.GET_CAPABILITIES_RESP,
            GetCapabilitiesResponse,
            request,
        )

    def extractor_list(
        self, request: ExtractorListRequest | None = None
    ) -> ExtractorListResponseFrame:
        """List the connected shard's registered extractors (EXTRACTOR_LIST):
        each extractor's id, namespace, name, tier kind, schema version, and
        creation time. Read-only introspection — extraction is always-on and
        cannot be toggled at runtime."""
        request = request or ExtractorListRequest()
        return self._unary(
            Opcode.EXTRACTOR_LIST_REQ,
            Opcode.EXTRACTOR_LIST_RESP,
            ExtractorListResponseFrame,
            request,
        )

    def get_entity(self, request: EntityGetRequest) -> EntityGetResponse:
        """Fetch one entity by id (ENTITY_GET)."""
        return self._unary(
            Opcode.ENTITY_GET_REQ, Opcode.ENTITY_GET_RESP, EntityGetResponse, request
        )

    def resolve_entity(self, request: EntityResolveRequest) -> EntityResolveResponse:
        """Resolve a candidate name to an entity (ENTITY_RESOLVE). The server
        currently requires ``entity_type_hint != 0`` and resolves by exact
        canonical name; ``allow_create`` lets it mint a new entity on a miss."""
        return self._unary(
            Opcode.ENTITY_RESOLVE_REQ,
            Opcode.ENTITY_RESOLVE_RESP,
            EntityResolveResponse,
            request,
        )

    def get_statement(self, request: StatementGetRequest) -> StatementGetResponse:
        """Fetch one statement by id (STATEMENT_GET). With ``follow_supersession``
        set, the server may redirect to the current entry in the chain."""
        return self._unary(
            Opcode.STATEMENT_GET_REQ,
            Opcode.STATEMENT_GET_RESP,
            StatementGetResponse,
            request,
        )

    def get_schema(self, request: SchemaGetRequest) -> SchemaGetResponse:
        """Fetch one schema version (SCHEMA_GET). ``version == 0`` selects the
        active version."""
        return self._unary(
            Opcode.SCHEMA_GET_REQ, Opcode.SCHEMA_GET_RESP, SchemaGetResponse, request
        )

    def validate_schema(self, request: SchemaValidateRequest) -> SchemaValidateResponse:
        """Validate a schema document without persisting it (SCHEMA_VALIDATE)."""
        return self._unary(
            Opcode.SCHEMA_VALIDATE_REQ,
            Opcode.SCHEMA_VALIDATE_RESP,
            SchemaValidateResponse,
            request,
        )

    def replace_schema(self, request: SchemaReplaceRequest) -> SchemaReplaceResponse:
        """Replace a namespace's schema wholesale (SCHEMA_REPLACE).

        DESTRUCTIVE. Every declared row in the namespace is dropped before the
        new document lands; entities whose type disappears survive as orphans,
        readable as plain memories but no longer enriched from the typed-graph
        tables. Use :meth:`upload_schema` for the additive, versioned path —
        this is for when the shape itself is wrong.

        ``request.force_drop_existing`` must be ``True``; the server rejects
        ``False`` with ``InvalidRequest``.
        """
        return self._unary(
            Opcode.SCHEMA_REPLACE_REQ,
            Opcode.SCHEMA_REPLACE_RESP,
            SchemaReplaceResponse,
            request,
        )

    def cancel_stream(
        self, target_stream_id: int, reason: object = "ClientUnneeded"
    ) -> CancelStreamAck:
        """Cancel an in-flight stream (CANCEL_STREAM).

        ``target_stream_id`` is the id of the stream to stop — the ``*_frames``
        methods expose it. The request travels on its OWN stream id, so it does
        not queue behind the frames it is cancelling; the server replies
        CANCEL_STREAM_ACK and stops emitting for the target.

        Without this, a consumer that abandons a streamed ``recall`` leaves the
        server producing frames nobody reads.

        Cancelling a stream that already finished is not an error — the server
        acknowledges regardless, so a racing consumer needn't coordinate with
        the reader loop.
        """
        return self._unary(
            Opcode.CANCEL_STREAM,
            Opcode.CANCEL_STREAM_ACK,
            CancelStreamAck,
            CancelStreamRequest(target_stream_id, reason),
        )

    def txn_begin(self, request: TxnBeginRequest) -> TxnBeginResponse:
        """Begin a transaction (TXN_BEGIN). The client mints ``txn_id``;
        subsequent writes carry it to enroll until commit or abort."""
        return self._unary(Opcode.TXN_BEGIN, Opcode.TXN_BEGIN_RESP, TxnBeginResponse, request)

    def txn_commit(self, request: TxnCommitRequest) -> TxnCommitResponse:
        """Commit a transaction (TXN_COMMIT)."""
        return self._unary(Opcode.TXN_COMMIT, Opcode.TXN_COMMIT_RESP, TxnCommitResponse, request)

    def txn_abort(self, request: TxnAbortRequest) -> TxnAbortResponse:
        """Abort a transaction (TXN_ABORT), discarding its buffered operations."""
        return self._unary(Opcode.TXN_ABORT, Opcode.TXN_ABORT_RESP, TxnAbortResponse, request)

    def plan(self, request: PlanRequest) -> list[PlanStep]:
        """Plan a path from ``start`` to ``goal`` (PLAN), flattening every
        streamed frame's ``steps`` into one ordered list. For the raw frames
        (``is_final``, terminal ``plan_status``), use :meth:`plan_frames`."""
        steps: list[PlanStep] = []
        for frame in self.plan_frames(request):
            steps.extend(frame.steps)
        return steps

    def plan_frames(self, request: PlanRequest) -> list[PlanResponseFrame]:
        """Plan a path, returning each decoded PLAN_RESP frame as streamed."""
        return self._streamed(Opcode.PLAN_REQ, Opcode.PLAN_RESP, PlanResponseFrame, request)

    def reason(self, request: ReasonRequest) -> list[InferenceStep]:
        """Reason about an observation (REASON), flattening every streamed
        frame's ``inferences`` into one ordered list. For the raw frames, use
        :meth:`reason_frames`."""
        inferences: list[InferenceStep] = []
        for frame in self.reason_frames(request):
            inferences.extend(frame.inferences)
        return inferences

    def reason_frames(self, request: ReasonRequest) -> list[ReasonResponseFrame]:
        """Reason about an observation, returning each decoded REASON_RESP frame."""
        return self._streamed(Opcode.REASON_REQ, Opcode.REASON_RESP, ReasonResponseFrame, request)

    def list_entities(self, request: EntityListRequest) -> list[EntityListItem]:
        """List entities (ENTITY_LIST), flattening every streamed frame's
        ``items``. For the raw frames, use :meth:`list_entities_frames`."""
        items: list[EntityListItem] = []
        for frame in self.list_entities_frames(request):
            items.extend(frame.items)
        return items

    def list_entities_frames(self, request: EntityListRequest) -> list[EntityListResponseFrame]:
        """List entities, returning each decoded ENTITY_LIST_RESP frame."""
        return self._streamed(
            Opcode.ENTITY_LIST_REQ, Opcode.ENTITY_LIST_RESP, EntityListResponseFrame, request
        )

    def list_statements(self, request: StatementListRequest) -> list[StatementView]:
        """List statements (STATEMENT_LIST), flattening every streamed frame's
        ``items``. For the raw frames, use :meth:`list_statements_frames`."""
        items: list[StatementView] = []
        for frame in self.list_statements_frames(request):
            items.extend(frame.items)
        return items

    def list_statements_frames(
        self, request: StatementListRequest
    ) -> list[StatementListResponseFrame]:
        """List statements, returning each decoded STATEMENT_LIST_RESP frame."""
        return self._streamed(
            Opcode.STATEMENT_LIST_REQ,
            Opcode.STATEMENT_LIST_RESP,
            StatementListResponseFrame,
            request,
        )

    def list_relations_from(self, request: RelationListFromRequest) -> list[RelationView]:
        """List relations originating from an entity (RELATION_LIST_FROM),
        flattening every streamed frame's ``items``. For the raw frames, use
        :meth:`list_relations_from_frames`."""
        items: list[RelationView] = []
        for frame in self.list_relations_from_frames(request):
            items.extend(frame.items)
        return items

    def list_relations_from_frames(
        self, request: RelationListFromRequest
    ) -> list[RelationListFromResponseFrame]:
        """List relations from an entity, returning each decoded
        RELATION_LIST_FROM_RESP frame."""
        return self._streamed(
            Opcode.RELATION_LIST_FROM_REQ,
            Opcode.RELATION_LIST_FROM_RESP,
            RelationListFromResponseFrame,
            request,
        )

    def list_relations_to(self, request: RelationListToRequest) -> list[RelationView]:
        """List relations pointing to an entity (RELATION_LIST_TO), flattening
        every streamed frame's ``items``. For the raw frames, use
        :meth:`list_relations_to_frames`."""
        items: list[RelationView] = []
        for frame in self.list_relations_to_frames(request):
            items.extend(frame.items)
        return items

    def list_relations_to_frames(
        self, request: RelationListToRequest
    ) -> list[RelationListToResponseFrame]:
        """List relations to an entity, returning each decoded
        RELATION_LIST_TO_RESP frame."""
        return self._streamed(
            Opcode.RELATION_LIST_TO_REQ,
            Opcode.RELATION_LIST_TO_RESP,
            RelationListToResponseFrame,
            request,
        )

    def list_schemas(self, request: SchemaListRequest) -> list[SchemaListItem]:
        """List schema versions in a namespace (SCHEMA_LIST), flattening every
        streamed frame's ``items``. For the raw frames, use
        :meth:`list_schemas_frames`."""
        items: list[SchemaListItem] = []
        for frame in self.list_schemas_frames(request):
            items.extend(frame.items)
        return items

    def list_schemas_frames(self, request: SchemaListRequest) -> list[SchemaListResponseFrame]:
        """List schema versions, returning each decoded SCHEMA_LIST_RESP frame."""
        return self._streamed(
            Opcode.SCHEMA_LIST_REQ, Opcode.SCHEMA_LIST_RESP, SchemaListResponseFrame, request
        )

    def subscribe(self, request: SubscribeRequest) -> Subscription:
        """Open a long-lived change-feed subscription (SUBSCRIBE). Returns a
        :class:`~brain_db_sdk.mux.Subscription` the caller drains with
        ``next()`` (or by iterating it); call ``unsubscribe()`` for a clean
        teardown. The server pushes ``SUBSCRIBE_EVENT`` frames until the
        subscription is torn down, so this does not block on a single response.
        """
        return self._conn.subscribe(request)

    def _streamed(
        self,
        req_opcode: Opcode,
        resp_opcode: Opcode,
        resp_type: type[_T],
        request: _WirePayload,
    ) -> list[_T]:
        """Send one request and decode every streamed response frame up to and
        including EOS, asserting each frame's opcode. The shape every LIST/streamed
        verb's ``*_frames`` method shares (mirrors :meth:`recall_frames`)."""
        frames = self._conn.request(req_opcode, encode_payload(request))
        out: list[_T] = []
        for frame in frames:
            if frame.opcode != int(resp_opcode):
                raise ProtocolError(
                    f"expected {resp_opcode.name} ({int(resp_opcode):#06x}), got "
                    f"{frame.opcode:#06x}"
                )
            out.append(decode_payload(resp_type, frame.payload))
        return out

    def _unary(
        self,
        req_opcode: Opcode,
        resp_opcode: Opcode,
        resp_type: type[_T],
        request: _WirePayload,
    ) -> _T:
        """Send one request and decode a single typed response frame, asserting
        the response opcode. The shape every single-shot typed-graph verb shares.
        """
        frame = self._conn.request_one(req_opcode, encode_payload(request))
        if frame.opcode != int(resp_opcode):
            raise ProtocolError(
                f"expected {resp_opcode.name} ({int(resp_opcode):#06x}), got {frame.opcode:#06x}"
            )
        return decode_payload(resp_type, frame.payload)

    def close(self) -> None:
        """Send BYE and close the socket."""
        try:
            self._conn.send_bye()
        finally:
            self._conn.close()

    def __enter__(self: _SelfClient) -> _SelfClient:
        """Enter a context that closes the connection on exit."""
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


__all__ = [
    "Auth",
    "BrainClient",
    "ClientConfig",
    "ConnectionInfo",
    "new_id",
]
