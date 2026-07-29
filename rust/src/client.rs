//! The high-level client: connect, handshake, and serve the v1 + typed-graph
//! verbs over a multiplexed connection.
//!
//! [`BrainClient::connect`] opens a TCP connection, runs the handshake, and
//! returns a client bound to the session the server granted. The client sits on
//! a [`MuxConnection`], so every verb takes `&self` and many requests run in
//! flight at once over the one connection — share a `BrainClient` across tasks
//! (e.g. behind an `Arc`) and call freely. To add retry, wrap a verb call in
//! [`crate::retry::with_retry`]; the stable `request_id` each builder mints
//! makes the resend idempotent server-side.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpStream;

use crate::error::{BrainError, Result};
use crate::mux::HandshakeOutcome;
use crate::mux::{MuxConnection, Subscription};
use crate::wire::cbor::{f32_slice_to_le_bytes, from_cbor_bytes, to_cbor_bytes};
use crate::wire::opcode::Opcode;
use crate::wire::types::{
    AnswerKindWire, AuthCredentials, AuthMethod, AuthPayload, CancelStreamAck, CancelStreamRequest,
    CancellationReason, EncodeRequest, EncodeResponse, EncodeVectorDirectRequest,
    EntityCreateRequest, EntityCreateResponse, EntityGetRequest, EntityGetResponse, EntityListItem,
    EntityListRequest, EntityListResponseFrame, EntityMergeRequest, EntityMergeResponse,
    EntityRenameRequest, EntityRenameResponse, EntityResolveRequest, EntityResolveResponse,
    EntityTombstoneRequest, EntityTombstoneResponse, EntityUnmergeRequest, EntityUnmergeResponse,
    EntityUpdateRequest, EntityUpdateResponse, ExtractorListRequest, ExtractorListResponseFrame,
    ForgetRequest, ForgetResponse, GetCapabilitiesRequest, GetCapabilitiesResponse, GraphEdge,
    GraphFetchRequest, GraphFetchResponseFrame, GraphNode, HelloCapabilities, HelloPayload,
    InferenceStep, LinkRequest, LinkResponse, MaterializeProceduralRequest,
    MaterializeProceduralResponse, MemoryInspectRequest, MemoryInspectResponse, MemoryListItem,
    MemoryListRequest, MemoryListResponseFrame, MemoryResult, MtlsClaim, PlanRequest,
    PlanResponseFrame, PlanStep, QueryExplainRequest, QueryExplainResponse, QueryTraceRequest,
    QueryTraceResponse, ReasonRequest, ReasonResponseFrame, RecallRequest, RecallResponseFrame,
    RelationCreateRequest, RelationCreateResponse, RelationGetRequest, RelationGetResponse,
    RelationListFromRequest, RelationListFromResponseFrame, RelationListToRequest,
    RelationListToResponseFrame, RelationSupersedeRequest, RelationSupersedeResponse,
    RelationTombstoneRequest, RelationTombstoneResponse, RelationTraverseRequest,
    RelationTraverseResponseFrame, RelationView, SchemaGetRequest, SchemaGetResponse,
    SchemaListItemWire, SchemaListRequest, SchemaListResponseFrame, SchemaReplaceRequest,
    SchemaReplaceResponse, SchemaUploadRequest, SchemaUploadResponse, SchemaValidateRequest,
    SchemaValidateResponse, ServerFeatures, SessionCreateRequest, SessionCreateResponse,
    SessionDeleteRequest, SessionDeleteResponse, SessionListRequest, SessionListResponse,
    SpaceCreateRequest, SpaceCreateResponse, SpaceDeleteRequest, SpaceDeleteResponse,
    SpaceListRequest, SpaceListResponse, SpacePermissions, StatementCreateRequest,
    StatementCreateResponse, StatementGetRequest, StatementGetResponse, StatementHistoryRequest,
    StatementHistoryResponseFrame, StatementListRequest, StatementListResponseFrame,
    StatementRetractRequest, StatementRetractResponse, StatementSupersedeRequest,
    StatementSupersedeResponse, StatementTombstoneRequest, StatementTombstoneResponse,
    StatementView, SubscribeRequest, TraversalPathWire, TxnAbortRequest, TxnAbortResponse,
    TxnBeginRequest, TxnBeginResponse, TxnCommitRequest, TxnCommitResponse, UnlinkRequest,
    UnlinkResponse,
};

/// Default `client_id` advertised in HELLO.
const DEFAULT_CLIENT_ID: &str = "brain-db-sdk-rust";

/// How the client authenticates after WELCOME. Auth is mandatory: there is no
/// anonymous mode. The credential is the connection's whole identity — the
/// server resolves `(namespace, space, permissions)` from it and refuses any
/// connection it cannot resolve.
#[derive(Clone, Debug)]
pub enum Auth {
    /// A shared bearer token.
    Token(Vec<u8>),
    /// An mTLS subject claim.
    Mtls(MtlsClaim),
}

impl Auth {
    fn method(&self) -> AuthMethod {
        match self {
            Auth::Token(_) => AuthMethod::Token,
            Auth::Mtls(_) => AuthMethod::Mtls,
        }
    }

    fn credentials(self) -> AuthCredentials {
        match self {
            Auth::Token(t) => AuthCredentials::Token(t),
            Auth::Mtls(c) => AuthCredentials::Mtls(c),
        }
    }
}

/// Connection configuration. Build one with [`ClientConfig::new`], which takes
/// the mandatory credential and fills the rest with sensible defaults (wire
/// version 1, streaming advertised). There is no `Default`: a connection with
/// no credential cannot exist.
#[derive(Clone, Debug)]
pub struct ClientConfig {
    /// Free-form client identifier sent in HELLO.
    pub client_id: String,
    /// Wire versions the client supports, in preference order. `u8` on the
    /// wire.
    pub supported_versions: Vec<u8>,
    /// Capabilities advertised in HELLO.
    pub capabilities: HelloCapabilities,
    /// How to authenticate after WELCOME. Mandatory — the credential is the
    /// connection's identity; the server assigns the space and namespace.
    pub auth: Auth,
    /// Deadline for the TCP connect. `None` waits indefinitely.
    pub connect_timeout: Option<Duration>,
    /// Per-response read deadline applied after connecting.
    pub request_timeout: Option<Duration>,
}

impl ClientConfig {
    /// A config for the given credential with default transport settings.
    #[must_use]
    pub fn new(auth: Auth) -> Self {
        Self {
            client_id: DEFAULT_CLIENT_ID.to_string(),
            supported_versions: vec![1],
            capabilities: HelloCapabilities {
                streaming: true,
                compression_zstd: false,
                server_push: false,
            },
            auth,
            connect_timeout: Some(Duration::from_secs(10)),
            request_timeout: Some(Duration::from_secs(30)),
        }
    }
}

/// The connection the server granted at handshake time.
#[derive(Clone, Debug)]
pub struct ConnectionInfo {
    pub space_id: [u8; 16],
    pub server_id: String,
    pub chosen_version: u8,
    /// Per-connection identifier the server minted at WELCOME.
    pub connection_id: [u8; 16],
    pub bound_shard_id: u16,
    pub permissions: SpacePermissions,
    /// Owning tenant the server bound this connection to (server-derived from
    /// auth). Empty when the connection resolves to the reserved `brain`
    /// system namespace. Read-only — the client never sends a namespace.
    pub namespace: String,
    pub server_features: ServerFeatures,
}

/// The drained result of a RECALL. Brain recall is not always top-k: it
/// answers "remember this" the way a real memory does. `answer_kind` reports
/// what shape the answer took (a single memory, many memories, or none);
/// `memories` carries the recalled memory hits.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallAnswer {
    pub answer_kind: AnswerKindWire,
    pub memories: Vec<MemoryResult>,
}

impl RecallAnswer {
    /// True when recall produced no memories.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.memories.is_empty()
    }

    /// The recalled memory hits.
    #[must_use]
    pub fn memories(&self) -> &[MemoryResult] {
        &self.memories
    }
}

/// A connected, handshaken Brain client over a multiplexed connection. Verbs
/// take `&self` and are safe to call concurrently from many tasks.
pub struct BrainClient {
    conn: MuxConnection<TcpStream>,
    connection: ConnectionInfo,
}

impl BrainClient {
    /// Connect to `addr` with the given credential and default transport
    /// settings, then run the handshake. The credential is mandatory — the
    /// server resolves the connection's identity from it.
    pub async fn connect(addr: SocketAddr, auth: Auth) -> Result<Self> {
        Self::connect_with(addr, ClientConfig::new(auth)).await
    }

    /// Connect to `addr` with an explicit configuration and run the handshake.
    pub async fn connect_with(addr: SocketAddr, config: ClientConfig) -> Result<Self> {
        let stream = match config.connect_timeout {
            Some(timeout) => tokio::time::timeout(timeout, TcpStream::connect(addr))
                .await
                .map_err(|_| BrainError::Timeout(timeout))??,
            None => TcpStream::connect(addr).await?,
        };
        // Small request/response frames benefit from disabling Nagle; the
        // transport already writes each frame in one call.
        stream.set_nodelay(true)?;

        Self::handshake_over(stream, config).await
    }

    /// Run the handshake over an already-connected stream, returning the live
    /// multiplexed client. Factored out so the path is exercised by in-process
    /// tests over a loopback socket.
    async fn handshake_over(stream: TcpStream, config: ClientConfig) -> Result<Self> {
        let hello = HelloPayload {
            client_id: config.client_id,
            supported_versions: config.supported_versions,
            capabilities: config.capabilities,
            client_connection_token: None,
        };
        let auth = AuthPayload {
            method: config.auth.method(),
            credentials: config.auth.credentials(),
        };

        let (conn, HandshakeOutcome { welcome, auth_ok }) =
            MuxConnection::handshake(stream, hello, auth, config.request_timeout).await?;

        let connection = ConnectionInfo {
            space_id: auth_ok.space_id,
            server_id: welcome.server_id,
            chosen_version: welcome.chosen_version,
            connection_id: welcome.connection_id,
            bound_shard_id: auth_ok.bound_shard_id,
            permissions: auth_ok.permissions,
            namespace: auth_ok.namespace,
            server_features: welcome.server_features,
        };
        Ok(Self { conn, connection })
    }

    /// The negotiated connection.
    #[must_use]
    pub fn connection(&self) -> &ConnectionInfo {
        &self.connection
    }

    /// The space id this connection acts as.
    #[must_use]
    pub fn space_id(&self) -> [u8; 16] {
        self.connection.space_id
    }

    /// The owning tenant the server bound this connection to (server-derived
    /// from auth). Empty when the connection resolves to the reserved `brain`
    /// system namespace. Read-only — the client never sends a namespace.
    #[must_use]
    pub fn namespace(&self) -> &str {
        &self.connection.namespace
    }

    /// Store a memory from text (ENCODE).
    pub async fn encode(&self, request: &EncodeRequest) -> Result<EncodeResponse> {
        self.unary(
            Opcode::EncodeReq,
            Opcode::EncodeResp,
            "ENCODE_RESP",
            request,
        )
        .await
    }

    /// Retrieve a memory by cue. RECALL streams one or more `RECALL_RESP`
    /// frames terminated by EOS; this drains them into one [`RecallAnswer`].
    /// `answer_kind` is the final frame's verdict; `memories` is concatenated
    /// across every frame in order. Recall is not always top-k: the answer may
    /// be a single memory, many memories, or none. For the raw streamed frames
    /// (cumulative counts, `estimated_remaining`), use [`Self::recall_frames`].
    pub async fn recall(&self, request: &RecallRequest) -> Result<RecallAnswer> {
        let frames = self.recall_frames(request).await?;
        let mut memories = Vec::new();
        // The answer_kind on the final (EOS) frame is the authoritative
        // verdict; default to None if the server sent nothing.
        let mut answer_kind = AnswerKindWire::None;
        for frame in frames {
            answer_kind = frame.answer_kind;
            memories.extend(frame.memories);
        }
        Ok(RecallAnswer {
            answer_kind,
            memories,
        })
    }

    /// Retrieve memories by cue, returning each decoded `RECALL_RESP` frame as
    /// streamed (preserving `is_final`, `cumulative_count`,
    /// `estimated_remaining`). The last frame carries the EOS flag.
    pub async fn recall_frames(&self, request: &RecallRequest) -> Result<Vec<RecallResponseFrame>> {
        let frames = self
            .conn
            .request(Opcode::RecallReq, to_cbor_bytes(request))
            .await?;
        let mut out = Vec::with_capacity(frames.len());
        for frame in frames {
            if frame.opcode != Opcode::RecallResp as u16 {
                return Err(BrainError::Protocol(format!(
                    "expected RECALL_RESP ({:#06x}), got {:#06x}",
                    Opcode::RecallResp as u16,
                    frame.opcode
                )));
            }
            out.push(from_cbor_bytes(&frame.payload)?);
        }
        Ok(out)
    }

    /// Forget a memory (soft tombstone or hard zeroing, per the request).
    pub async fn forget(&self, request: &ForgetRequest) -> Result<ForgetResponse> {
        self.unary(
            Opcode::ForgetReq,
            Opcode::ForgetResp,
            "FORGET_RESP",
            request,
        )
        .await
    }

    /// Create or reweight an edge between two memories (LINK). Returns
    /// whether the edge already existed (LINK overwrote its weight).
    pub async fn link(&self, request: &LinkRequest) -> Result<LinkResponse> {
        self.unary(Opcode::LinkReq, Opcode::LinkResp, "LINK_RESP", request)
            .await
    }

    /// Remove an edge identified by `(source, kind, target)` (UNLINK).
    /// Idempotent: removing a non-existent edge succeeds with
    /// `removed = false`.
    pub async fn unlink(&self, request: &UnlinkRequest) -> Result<UnlinkResponse> {
        self.unary(
            Opcode::UnlinkReq,
            Opcode::UnlinkResp,
            "UNLINK_RESP",
            request,
        )
        .await
    }

    /// Plan a path from `start` to `goal` (PLAN), flattening every streamed
    /// frame's `steps` into one ordered list. For the raw streamed frames
    /// (`is_final`, terminal `plan_status`), use [`Self::plan_frames`].
    pub async fn plan(&self, request: &PlanRequest) -> Result<Vec<PlanStep>> {
        let frames = self.plan_frames(request).await?;
        let mut steps = Vec::new();
        for frame in frames {
            steps.extend(frame.steps);
        }
        Ok(steps)
    }

    /// Plan a path, returning each decoded PLAN_RESP frame as streamed
    /// (preserving `is_final` and the terminal `plan_status`).
    pub async fn plan_frames(&self, request: &PlanRequest) -> Result<Vec<PlanResponseFrame>> {
        self.streamed(Opcode::PlanReq, Opcode::PlanResp, "PLAN_RESP", request)
            .await
    }

    /// Reason about an observation (REASON), flattening every streamed
    /// frame's `inferences` into one ordered list. For the raw streamed
    /// frames (`is_final`, terminal `reason_status`), use
    /// [`Self::reason_frames`].
    pub async fn reason(&self, request: &ReasonRequest) -> Result<Vec<InferenceStep>> {
        let frames = self.reason_frames(request).await?;
        let mut inferences = Vec::new();
        for frame in frames {
            inferences.extend(frame.inferences);
        }
        Ok(inferences)
    }

    /// Reason about an observation, returning each decoded REASON_RESP frame
    /// as streamed (preserving `is_final` and the terminal `reason_status`).
    pub async fn reason_frames(&self, request: &ReasonRequest) -> Result<Vec<ReasonResponseFrame>> {
        self.streamed(
            Opcode::ReasonReq,
            Opcode::ReasonResp,
            "REASON_RESP",
            request,
        )
        .await
    }

    /// Create a typed entity (ENTITY_CREATE).
    pub async fn create_entity(
        &self,
        request: &EntityCreateRequest,
    ) -> Result<EntityCreateResponse> {
        self.unary(
            Opcode::EntityCreateReq,
            Opcode::EntityCreateResp,
            "ENTITY_CREATE_RESP",
            request,
        )
        .await
    }

    /// Replace an entity's name, aliases, and attributes (ENTITY_UPDATE).
    pub async fn update_entity(
        &self,
        request: &EntityUpdateRequest,
    ) -> Result<EntityUpdateResponse> {
        self.unary(
            Opcode::EntityUpdateReq,
            Opcode::EntityUpdateResp,
            "ENTITY_UPDATE_RESP",
            request,
        )
        .await
    }

    /// Rename an entity, optionally keeping the old name as an alias
    /// (ENTITY_RENAME).
    pub async fn rename_entity(
        &self,
        request: &EntityRenameRequest,
    ) -> Result<EntityRenameResponse> {
        self.unary(
            Opcode::EntityRenameReq,
            Opcode::EntityRenameResp,
            "ENTITY_RENAME_RESP",
            request,
        )
        .await
    }

    /// Merge two entities that are the same real-world thing (ENTITY_MERGE).
    /// Reversible within the returned grace window via [`Self::unmerge_entity`].
    pub async fn merge_entities(
        &self,
        request: &EntityMergeRequest,
    ) -> Result<EntityMergeResponse> {
        self.unary(
            Opcode::EntityMergeReq,
            Opcode::EntityMergeResp,
            "ENTITY_MERGE_RESP",
            request,
        )
        .await
    }

    /// Undo a merge within its grace window (ENTITY_UNMERGE).
    pub async fn unmerge_entity(
        &self,
        request: &EntityUnmergeRequest,
    ) -> Result<EntityUnmergeResponse> {
        self.unary(
            Opcode::EntityUnmergeReq,
            Opcode::EntityUnmergeResp,
            "ENTITY_UNMERGE_RESP",
            request,
        )
        .await
    }

    /// Retire an entity with an audit reason (ENTITY_TOMBSTONE). Soft: the row
    /// survives but drops out of resolution and traversal.
    pub async fn tombstone_entity(
        &self,
        request: &EntityTombstoneRequest,
    ) -> Result<EntityTombstoneResponse> {
        self.unary(
            Opcode::EntityTombstoneReq,
            Opcode::EntityTombstoneResp,
            "ENTITY_TOMBSTONE_RESP",
            request,
        )
        .await
    }

    /// Create a statement (STATEMENT_CREATE). The response reports any
    /// auto-superseded prior statement and the supersession chain root.
    pub async fn create_statement(
        &self,
        request: &StatementCreateRequest,
    ) -> Result<StatementCreateResponse> {
        self.unary(
            Opcode::StatementCreateReq,
            Opcode::StatementCreateResp,
            "STATEMENT_CREATE_RESP",
            request,
        )
        .await
    }

    /// Create a relation between two entities (RELATION_CREATE).
    pub async fn create_relation(
        &self,
        request: &RelationCreateRequest,
    ) -> Result<RelationCreateResponse> {
        self.unary(
            Opcode::RelationCreateReq,
            Opcode::RelationCreateResp,
            "RELATION_CREATE_RESP",
            request,
        )
        .await
    }

    /// Upload a schema document (SCHEMA_UPLOAD). With `dry_run` set the server
    /// validates without applying; the response carries any validation errors
    /// and a backward-compatibility verdict.
    pub async fn upload_schema(
        &self,
        request: &SchemaUploadRequest,
    ) -> Result<SchemaUploadResponse> {
        self.unary(
            Opcode::SchemaUploadReq,
            Opcode::SchemaUploadResp,
            "SCHEMA_UPLOAD_RESP",
            request,
        )
        .await
    }

    /// Fetch one relation by id (RELATION_GET). `follow_supersession` returns
    /// the current chain head when the id has been superseded.
    pub async fn get_relation(&self, request: &RelationGetRequest) -> Result<RelationGetResponse> {
        self.unary(
            Opcode::RelationGetReq,
            Opcode::RelationGetResp,
            "RELATION_GET_RESP",
            request,
        )
        .await
    }

    /// Revise a relation, keeping both on one chain (RELATION_SUPERSEDE).
    pub async fn supersede_relation(
        &self,
        request: &RelationSupersedeRequest,
    ) -> Result<RelationSupersedeResponse> {
        self.unary(
            Opcode::RelationSupersedeReq,
            Opcode::RelationSupersedeResp,
            "RELATION_SUPERSEDE_RESP",
            request,
        )
        .await
    }

    /// Soft-retire a relation with a reason (RELATION_TOMBSTONE).
    pub async fn tombstone_relation(
        &self,
        request: &RelationTombstoneRequest,
    ) -> Result<RelationTombstoneResponse> {
        self.unary(
            Opcode::RelationTombstoneReq,
            Opcode::RelationTombstoneResp,
            "RELATION_TOMBSTONE_RESP",
            request,
        )
        .await
    }

    /// Multi-hop walk of the relation graph from an entity (RELATION_TRAVERSE),
    /// flattening every streamed frame's `paths`. For the raw frames (with
    /// `truncated` / `total_paths`), use [`Self::traverse_relations_frames`].
    pub async fn traverse_relations(
        &self,
        request: &RelationTraverseRequest,
    ) -> Result<Vec<TraversalPathWire>> {
        let frames = self.traverse_relations_frames(request).await?;
        let mut paths = Vec::new();
        for frame in frames {
            paths.extend(frame.paths);
        }
        Ok(paths)
    }

    /// Traverse the relation graph, returning each decoded RELATION_TRAVERSE
    /// frame.
    pub async fn traverse_relations_frames(
        &self,
        request: &RelationTraverseRequest,
    ) -> Result<Vec<RelationTraverseResponseFrame>> {
        self.streamed(
            Opcode::RelationTraverseReq,
            Opcode::RelationTraverseResp,
            "RELATION_TRAVERSE_RESP",
            request,
        )
        .await
    }

    /// Return a query's plan without running it (QUERY_EXPLAIN).
    pub async fn query_explain(
        &self,
        request: &QueryExplainRequest,
    ) -> Result<QueryExplainResponse> {
        self.unary(
            Opcode::QueryExplainReq,
            Opcode::QueryExplainResp,
            "QUERY_EXPLAIN_RESP",
            request,
        )
        .await
    }

    /// Run a query and return its per-stage execution trace (QUERY_TRACE).
    pub async fn query_trace(&self, request: &QueryTraceRequest) -> Result<QueryTraceResponse> {
        self.unary(
            Opcode::QueryTraceReq,
            Opcode::QueryTraceResp,
            "QUERY_TRACE_RESP",
            request,
        )
        .await
    }

    /// Write a pre-computed embedding directly (ENCODE_VECTOR_DIRECT), bypassing
    /// the server's owned embedding. The vector rides the trailing raw f32
    /// section of the frame, not the CBOR map.
    pub async fn encode_vector_direct(
        &self,
        request: &EncodeVectorDirectRequest,
    ) -> Result<EncodeResponse> {
        let mut payload = to_cbor_bytes(request);
        payload.extend_from_slice(&f32_slice_to_le_bytes(&request.vector));
        let frame = self
            .conn
            .request_one(Opcode::EncodeVectorDirectReq, payload)
            .await?;
        if frame.opcode != Opcode::EncodeVectorDirectResp as u16 {
            return Err(BrainError::Protocol(format!(
                "expected ENCODE_VECTOR_DIRECT_RESP ({:#06x}), got {:#06x}",
                Opcode::EncodeVectorDirectResp as u16,
                frame.opcode
            )));
        }
        Ok(from_cbor_bytes(&frame.payload)?)
    }

    /// Materialize a procedural-memory system block (MATERIALIZE_PROCEDURAL).
    pub async fn materialize_procedural(
        &self,
        request: &MaterializeProceduralRequest,
    ) -> Result<MaterializeProceduralResponse> {
        self.unary(
            Opcode::MaterializeProceduralReq,
            Opcode::MaterializeProceduralResp,
            "MATERIALIZE_PROCEDURAL_RESP",
            request,
        )
        .await
    }

    /// Introspect the connected shard's live capabilities (GET_CAPABILITIES):
    /// whether the reranker is loaded, which extractor tiers are enabled, the
    /// active user schema namespaces, and the embedding dimensionality.
    pub async fn capabilities(
        &self,
        request: &GetCapabilitiesRequest,
    ) -> Result<GetCapabilitiesResponse> {
        self.unary(
            Opcode::GetCapabilitiesReq,
            Opcode::GetCapabilitiesResp,
            "GET_CAPABILITIES_RESP",
            request,
        )
        .await
    }

    /// List the always-on extractors registered on the connected shard
    /// (EXTRACTOR_LIST): id, namespace, name, kind, schema version, and
    /// creation time. Read-only introspection — extraction is always-on and
    /// cannot be toggled.
    pub async fn extractor_list(
        &self,
        request: &ExtractorListRequest,
    ) -> Result<ExtractorListResponseFrame> {
        self.unary(
            Opcode::ExtractorListReq,
            Opcode::ExtractorListResp,
            "EXTRACTOR_LIST_RESP",
            request,
        )
        .await
    }

    /// Fetch one entity by id (ENTITY_GET).
    pub async fn get_entity(&self, request: &EntityGetRequest) -> Result<EntityGetResponse> {
        self.unary(
            Opcode::EntityGetReq,
            Opcode::EntityGetResp,
            "ENTITY_GET_RESP",
            request,
        )
        .await
    }

    /// Inspect one memory's durable write-artifact bundle (MEMORY_INSPECT):
    /// its text plus the per-stage record of what the write built — the
    /// embedding vector, the stored record, the analyzed keyword terms, the
    /// write-time HyPE questions, and the extracted knowledge graph. Returns
    /// `found = false` (with an empty `artifact`) for an id that doesn't exist
    /// under the caller's scope.
    pub async fn memory_inspect(
        &self,
        request: &MemoryInspectRequest,
    ) -> Result<MemoryInspectResponse> {
        self.unary(
            Opcode::MemoryInspectReq,
            Opcode::MemoryInspectResp,
            "MEMORY_INSPECT_RESP",
            request,
        )
        .await
    }

    /// Resolve a candidate name to an entity (ENTITY_RESOLVE). The server
    /// currently requires `entity_type_hint != 0` and resolves by exact
    /// canonical name; `allow_create` lets it mint a new entity on a miss.
    pub async fn resolve_entity(
        &self,
        request: &EntityResolveRequest,
    ) -> Result<EntityResolveResponse> {
        self.unary(
            Opcode::EntityResolveReq,
            Opcode::EntityResolveResp,
            "ENTITY_RESOLVE_RESP",
            request,
        )
        .await
    }

    /// Fetch one statement by id (STATEMENT_GET). With `follow_supersession`
    /// set, the server may redirect to the current entry in the chain.
    pub async fn get_statement(
        &self,
        request: &StatementGetRequest,
    ) -> Result<StatementGetResponse> {
        self.unary(
            Opcode::StatementGetReq,
            Opcode::StatementGetResp,
            "STATEMENT_GET_RESP",
            request,
        )
        .await
    }

    /// Fetch one schema version (SCHEMA_GET). `version == 0` selects the active
    /// version.
    pub async fn get_schema(&self, request: &SchemaGetRequest) -> Result<SchemaGetResponse> {
        self.unary(
            Opcode::SchemaGetReq,
            Opcode::SchemaGetResp,
            "SCHEMA_GET_RESP",
            request,
        )
        .await
    }

    /// Validate a schema document without persisting it (SCHEMA_VALIDATE).
    pub async fn validate_schema(
        &self,
        request: &SchemaValidateRequest,
    ) -> Result<SchemaValidateResponse> {
        self.unary(
            Opcode::SchemaValidateReq,
            Opcode::SchemaValidateResp,
            "SCHEMA_VALIDATE_RESP",
            request,
        )
        .await
    }

    /// Replace a namespace's schema wholesale (SCHEMA_REPLACE).
    ///
    /// DESTRUCTIVE. Every declared row in the namespace is dropped before the
    /// new document lands; entities whose type disappears survive as orphans,
    /// readable as plain memories but no longer enriched from the typed-graph
    /// tables. Use [`Self::upload_schema`] for the additive, versioned path —
    /// this is the one you reach for when the shape itself is wrong.
    ///
    /// `force_drop_existing` MUST be `true`; the server rejects `false` with
    /// `InvalidRequest`. The SDK does not default it, so the destructive
    /// intent is written at the call site.
    pub async fn replace_schema(
        &self,
        request: &SchemaReplaceRequest,
    ) -> Result<SchemaReplaceResponse> {
        self.unary(
            Opcode::SchemaReplaceReq,
            Opcode::SchemaReplaceResp,
            "SCHEMA_REPLACE_RESP",
            request,
        )
        .await
    }

    /// Cancel an in-flight stream (CANCEL_STREAM).
    ///
    /// `target_stream_id` is the id of the stream to stop — take it from the
    /// frames a streaming call is yielding (`*_frames` methods expose
    /// `stream_id`). The request travels on its OWN stream id, so it does not
    /// queue behind the frames it is cancelling; the server replies
    /// `CANCEL_STREAM_ACK` and stops emitting for the target.
    ///
    /// This is why it cannot use the `unary` helper's request/response pairing
    /// on a single stream: the acknowledgement and the cancelled stream are
    /// deliberately different streams.
    ///
    /// Cancelling a stream that already finished is not an error — the server
    /// acknowledges it regardless, so a racing consumer does not have to
    /// coordinate with the reader loop.
    pub async fn cancel_stream(
        &self,
        target_stream_id: u32,
        reason: CancellationReason,
    ) -> Result<CancelStreamAck> {
        let request = CancelStreamRequest {
            target_stream_id,
            reason,
        };
        self.unary(
            Opcode::CancelStream,
            Opcode::CancelStreamAck,
            "CANCEL_STREAM_ACK",
            &request,
        )
        .await
    }

    /// List entities (ENTITY_LIST), flattening every streamed frame's `items`
    /// into one ordered list. For the raw streamed frames (cursors, cumulative
    /// counts, `is_final`), use [`Self::list_entities_frames`].
    pub async fn list_entities(&self, request: &EntityListRequest) -> Result<Vec<EntityListItem>> {
        let frames = self.list_entities_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List entities, returning each decoded ENTITY_LIST_RESP frame as streamed
    /// (preserving `next_cursor`, `cumulative_count`, `is_final`).
    pub async fn list_entities_frames(
        &self,
        request: &EntityListRequest,
    ) -> Result<Vec<EntityListResponseFrame>> {
        self.streamed(
            Opcode::EntityListReq,
            Opcode::EntityListResp,
            "ENTITY_LIST_RESP",
            request,
        )
        .await
    }

    /// List memories (MEMORY_LIST), flattening every streamed frame's `items`
    /// into one ordered list. This is a pure paginated enumeration of the
    /// caller's `(namespace, space)` memories — no query, no ranking. For the
    /// raw streamed frames (cursors, cumulative counts, `is_final`), use
    /// [`Self::memory_list_frames`].
    pub async fn memory_list(&self, request: &MemoryListRequest) -> Result<Vec<MemoryListItem>> {
        let frames = self.memory_list_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List memories, returning each decoded MEMORY_LIST_RESP frame as streamed
    /// (preserving `next_cursor`, `cumulative_count`, `is_final`).
    pub async fn memory_list_frames(
        &self,
        request: &MemoryListRequest,
    ) -> Result<Vec<MemoryListResponseFrame>> {
        self.streamed(
            Opcode::MemoryListReq,
            Opcode::MemoryListResp,
            "MEMORY_LIST_RESP",
            request,
        )
        .await
    }

    /// Export the caller's typed graph (GRAPH_FETCH), flattening every streamed
    /// frame's nodes + edges into two ordered lists. Nodes/edges may repeat
    /// across pages (completeness, not disjointness) — dedup by id if needed.
    /// For the raw streamed frames (cursors, `is_final`), use
    /// [`Self::graph_fetch_frames`].
    pub async fn graph_fetch(
        &self,
        request: &GraphFetchRequest,
    ) -> Result<(Vec<GraphNode>, Vec<GraphEdge>)> {
        let frames = self.graph_fetch_frames(request).await?;
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for frame in frames {
            nodes.extend(frame.nodes);
            edges.extend(frame.edges);
        }
        Ok((nodes, edges))
    }

    /// Export the typed graph, returning each decoded GRAPH_FETCH_RESP frame as
    /// streamed (preserving `next_cursor`, `is_final`).
    pub async fn graph_fetch_frames(
        &self,
        request: &GraphFetchRequest,
    ) -> Result<Vec<GraphFetchResponseFrame>> {
        self.streamed(
            Opcode::GraphFetchReq,
            Opcode::GraphFetchResp,
            "GRAPH_FETCH_RESP",
            request,
        )
        .await
    }

    /// List statements (STATEMENT_LIST), flattening every streamed frame's
    /// `items`. For the raw frames, use [`Self::list_statements_frames`].
    pub async fn list_statements(
        &self,
        request: &StatementListRequest,
    ) -> Result<Vec<StatementView>> {
        let frames = self.list_statements_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List statements, returning each decoded STATEMENT_LIST_RESP frame.
    pub async fn list_statements_frames(
        &self,
        request: &StatementListRequest,
    ) -> Result<Vec<StatementListResponseFrame>> {
        self.streamed(
            Opcode::StatementListReq,
            Opcode::StatementListResp,
            "STATEMENT_LIST_RESP",
            request,
        )
        .await
    }

    /// Replace a statement with a revised one (STATEMENT_SUPERSEDE), keeping
    /// both on the same chain so history is preserved.
    pub async fn supersede_statement(
        &self,
        request: &StatementSupersedeRequest,
    ) -> Result<StatementSupersedeResponse> {
        self.unary(
            Opcode::StatementSupersedeReq,
            Opcode::StatementSupersedeResp,
            "STATEMENT_SUPERSEDE_RESP",
            request,
        )
        .await
    }

    /// Retire a statement with a coded reason (STATEMENT_TOMBSTONE). Soft and
    /// recoverable.
    pub async fn tombstone_statement(
        &self,
        request: &StatementTombstoneRequest,
    ) -> Result<StatementTombstoneResponse> {
        self.unary(
            Opcode::StatementTombstoneReq,
            Opcode::StatementTombstoneResp,
            "STATEMENT_TOMBSTONE_RESP",
            request,
        )
        .await
    }

    /// Assert a statement was wrong (STATEMENT_RETRACT). Unlike a tombstone,
    /// retraction schedules a hard-zero so a genuine mistake gets scrubbed.
    pub async fn retract_statement(
        &self,
        request: &StatementRetractRequest,
    ) -> Result<StatementRetractResponse> {
        self.unary(
            Opcode::StatementRetractReq,
            Opcode::StatementRetractResp,
            "STATEMENT_RETRACT_RESP",
            request,
        )
        .await
    }

    /// Walk a claim's full version chain (STATEMENT_HISTORY), flattening every
    /// streamed frame's `items`. For the raw frames, use
    /// [`Self::statement_history_frames`].
    pub async fn statement_history(
        &self,
        request: &StatementHistoryRequest,
    ) -> Result<Vec<StatementView>> {
        let frames = self.statement_history_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// Walk a claim's version chain, returning each decoded STATEMENT_HISTORY
    /// frame (with `total_versions` / `is_final`).
    pub async fn statement_history_frames(
        &self,
        request: &StatementHistoryRequest,
    ) -> Result<Vec<StatementHistoryResponseFrame>> {
        self.streamed(
            Opcode::StatementHistoryReq,
            Opcode::StatementHistoryResp,
            "STATEMENT_HISTORY_RESP",
            request,
        )
        .await
    }

    /// List relations originating from an entity (RELATION_LIST_FROM),
    /// flattening every streamed frame's `items`. For the raw frames, use
    /// [`Self::list_relations_from_frames`].
    pub async fn list_relations_from(
        &self,
        request: &RelationListFromRequest,
    ) -> Result<Vec<RelationView>> {
        let frames = self.list_relations_from_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List relations from an entity, returning each decoded
    /// RELATION_LIST_FROM_RESP frame.
    pub async fn list_relations_from_frames(
        &self,
        request: &RelationListFromRequest,
    ) -> Result<Vec<RelationListFromResponseFrame>> {
        self.streamed(
            Opcode::RelationListFromReq,
            Opcode::RelationListFromResp,
            "RELATION_LIST_FROM_RESP",
            request,
        )
        .await
    }

    /// List relations pointing to an entity (RELATION_LIST_TO), flattening every
    /// streamed frame's `items`. For the raw frames, use
    /// [`Self::list_relations_to_frames`].
    pub async fn list_relations_to(
        &self,
        request: &RelationListToRequest,
    ) -> Result<Vec<RelationView>> {
        let frames = self.list_relations_to_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List relations to an entity, returning each decoded
    /// RELATION_LIST_TO_RESP frame.
    pub async fn list_relations_to_frames(
        &self,
        request: &RelationListToRequest,
    ) -> Result<Vec<RelationListToResponseFrame>> {
        self.streamed(
            Opcode::RelationListToReq,
            Opcode::RelationListToResp,
            "RELATION_LIST_TO_RESP",
            request,
        )
        .await
    }

    /// List schema versions in a namespace (SCHEMA_LIST), flattening every
    /// streamed frame's `items`. For the raw frames, use
    /// [`Self::list_schemas_frames`].
    pub async fn list_schemas(
        &self,
        request: &SchemaListRequest,
    ) -> Result<Vec<SchemaListItemWire>> {
        let frames = self.list_schemas_frames(request).await?;
        let mut items = Vec::new();
        for frame in frames {
            items.extend(frame.items);
        }
        Ok(items)
    }

    /// List schema versions, returning each decoded SCHEMA_LIST_RESP frame.
    pub async fn list_schemas_frames(
        &self,
        request: &SchemaListRequest,
    ) -> Result<Vec<SchemaListResponseFrame>> {
        self.streamed(
            Opcode::SchemaListReq,
            Opcode::SchemaListResp,
            "SCHEMA_LIST_RESP",
            request,
        )
        .await
    }

    /// Begin a transaction (TXN_BEGIN). The client mints `txn_id`; subsequent
    /// writes carry it to enroll in the transaction until commit or abort.
    pub async fn txn_begin(&self, request: &TxnBeginRequest) -> Result<TxnBeginResponse> {
        self.unary(
            Opcode::TxnBegin,
            Opcode::TxnBeginResp,
            "TXN_BEGIN_RESP",
            request,
        )
        .await
    }

    /// Commit a transaction (TXN_COMMIT). The response reports how many
    /// operations were applied.
    pub async fn txn_commit(&self, request: &TxnCommitRequest) -> Result<TxnCommitResponse> {
        self.unary(
            Opcode::TxnCommit,
            Opcode::TxnCommitResp,
            "TXN_COMMIT_RESP",
            request,
        )
        .await
    }

    /// Abort a transaction (TXN_ABORT), discarding its buffered operations.
    pub async fn txn_abort(&self, request: &TxnAbortRequest) -> Result<TxnAbortResponse> {
        self.unary(
            Opcode::TxnAbort,
            Opcode::TxnAbortResp,
            "TXN_ABORT_RESP",
            request,
        )
        .await
    }

    /// Provision the caller's effective space explicitly (SPACE_CREATE).
    /// Idempotent: a create for an existing space returns the existing row
    /// with `created = false`.
    pub async fn create_space(&self, request: &SpaceCreateRequest) -> Result<SpaceCreateResponse> {
        self.unary(
            Opcode::SpaceCreateReq,
            Opcode::SpaceCreateResp,
            "SPACE_CREATE_RESP",
            request,
        )
        .await
    }

    /// List the caller's namespace's spaces (SPACE_LIST). `cross_shard_complete`
    /// is `false` while the listing covers only the caller's shard.
    pub async fn list_spaces(&self, request: &SpaceListRequest) -> Result<SpaceListResponse> {
        self.unary(
            Opcode::SpaceListReq,
            Opcode::SpaceListResp,
            "SPACE_LIST_RESP",
            request,
        )
        .await
    }

    /// Erase the caller's effective space and every row under it
    /// (SPACE_DELETE). Hard/immediate GDPR erasure.
    pub async fn delete_space(&self, request: &SpaceDeleteRequest) -> Result<SpaceDeleteResponse> {
        self.unary(
            Opcode::SpaceDeleteReq,
            Opcode::SpaceDeleteResp,
            "SPACE_DELETE_RESP",
            request,
        )
        .await
    }

    /// Provision a session under the caller's effective space explicitly
    /// (SESSION_CREATE). Idempotent.
    pub async fn create_session(
        &self,
        request: &SessionCreateRequest,
    ) -> Result<SessionCreateResponse> {
        self.unary(
            Opcode::SessionCreateReq,
            Opcode::SessionCreateResp,
            "SESSION_CREATE_RESP",
            request,
        )
        .await
    }

    /// List one space's sessions newest-first (SESSION_LIST). A first-class
    /// end-user feature — the client's session picker reads this.
    pub async fn list_sessions(&self, request: &SessionListRequest) -> Result<SessionListResponse> {
        self.unary(
            Opcode::SessionListReq,
            Opcode::SessionListResp,
            "SESSION_LIST_RESP",
            request,
        )
        .await
    }

    /// Delete a session's memories + graph rows (SESSION_DELETE). Soft by
    /// default (7-day grace); `hard = true` zeroes immediately. The default
    /// session (`session_id = 0`) is non-deletable.
    pub async fn delete_session(
        &self,
        request: &SessionDeleteRequest,
    ) -> Result<SessionDeleteResponse> {
        self.unary(
            Opcode::SessionDeleteReq,
            Opcode::SessionDeleteResp,
            "SESSION_DELETE_RESP",
            request,
        )
        .await
    }

    /// Open a long-lived change-feed subscription (SUBSCRIBE). Returns a
    /// [`Subscription`] handle the caller drains with `next().await`; call
    /// `unsubscribe().await` for a clean teardown. The server pushes
    /// `SUBSCRIBE_EVENT` frames until the subscription is torn down, so this
    /// does not block on a single response.
    pub async fn subscribe(&self, request: &SubscribeRequest) -> Result<Subscription<TcpStream>> {
        self.conn.subscribe(request).await
    }

    /// Send a CBOR-encoded request and decode every streamed response frame up
    /// to and including EOS, asserting each frame's opcode. The shape every
    /// LIST verb's `*_frames` method shares (mirrors [`Self::recall_frames`]).
    async fn streamed<Req, Frame>(
        &self,
        req_opcode: Opcode,
        resp_opcode: Opcode,
        resp_name: &str,
        request: &Req,
    ) -> Result<Vec<Frame>>
    where
        Req: serde::Serialize,
        Frame: serde::de::DeserializeOwned,
    {
        let frames = self
            .conn
            .request(req_opcode, to_cbor_bytes(request))
            .await?;
        let mut out = Vec::with_capacity(frames.len());
        for frame in frames {
            if frame.opcode != resp_opcode as u16 {
                return Err(BrainError::Protocol(format!(
                    "expected {resp_name} ({:#06x}), got {:#06x}",
                    resp_opcode as u16, frame.opcode
                )));
            }
            out.push(from_cbor_bytes(&frame.payload)?);
        }
        Ok(out)
    }

    /// Send a CBOR-encoded request and decode a single typed response frame,
    /// asserting the response opcode. The shape every single-shot verb shares.
    async fn unary<Req, Resp>(
        &self,
        req_opcode: Opcode,
        resp_opcode: Opcode,
        resp_name: &str,
        request: &Req,
    ) -> Result<Resp>
    where
        Req: serde::Serialize,
        Resp: serde::de::DeserializeOwned,
    {
        let frame = self
            .conn
            .request_one(req_opcode, to_cbor_bytes(request))
            .await?;
        if frame.opcode != resp_opcode as u16 {
            return Err(BrainError::Protocol(format!(
                "expected {resp_name} ({:#06x}), got {:#06x}",
                resp_opcode as u16, frame.opcode
            )));
        }
        Ok(from_cbor_bytes(&frame.payload)?)
    }

    /// Send BYE and drop the connection.
    pub async fn close(self) -> Result<()> {
        self.conn.send_bye().await
    }
}

/// Mint a fresh 16-byte identifier from a time-ordered UUIDv7.
#[must_use]
pub fn new_id() -> [u8; 16] {
    *uuid::Uuid::now_v7().as_bytes()
}

/// Root namespace UUID for space-id derivation: the 16 bytes of the ASCII
/// string `"brain-space-root"`. Must match the server's frozen seed.
const BRAIN_ROOT_NAMESPACE_UUID: uuid::Uuid = uuid::Uuid::from_bytes([
    0x6b, 0x72, 0x61, 0x69, 0x6e, 0x2d, 0x73, 0x70, 0x61, 0x63, 0x65, 0x2d, 0x72, 0x6f, 0x6f, 0x74,
]);

/// Derive the 16-byte storage space id from a structured space string, exactly
/// as the server does at request ingress: `UUIDv5(UUIDv5(ROOT, namespace),
/// space)`. Folding the namespace makes equal strings under different
/// namespaces diverge. Clients only ever *send* the space string; this is for
/// the rare cases that need the resolved id locally — e.g. a `SubscriptionFilter`
/// whose `spaces` names the effective space by its resolved id. The seed is
/// frozen and pinned by a golden test on both sides; changing it re-keys every
/// space.
#[must_use]
pub fn derive_space_id(namespace: &str, space: &str) -> [u8; 16] {
    let ns = uuid::Uuid::new_v5(&BRAIN_ROOT_NAMESPACE_UUID, namespace.as_bytes());
    *uuid::Uuid::new_v5(&ns, space.as_bytes()).as_bytes()
}

#[cfg(test)]
mod space_id_tests {
    use super::derive_space_id;

    #[test]
    fn derive_space_id_matches_server_golden() {
        // The same frozen vector the server pins in brain-core: changing the
        // seed on either side would break client/server agreement.
        let id = derive_space_id("acme", "support-bot:user123");
        assert_eq!(
            uuid::Uuid::from_bytes(id).to_string(),
            "119061cc-b6db-5cde-8edd-0cefa33452eb"
        );
    }

    #[test]
    fn same_space_diverges_across_namespaces() {
        assert_ne!(derive_space_id("ns_a", "u1"), derive_space_id("ns_b", "u1"));
    }
}
