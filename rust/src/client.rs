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

use crate::connection::HandshakeOutcome;
use crate::error::{BrainError, Result};
use crate::mux::{MuxConnection, Subscription};
use crate::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use crate::wire::opcode::Opcode;
use crate::wire::types::{
    AgentPermissions, AnswerKindWire, AuthCredentials, AuthMethod, AuthPayload, EncodeRequest,
    EncodeResponse, EntityCreateRequest, EntityCreateResponse, EntityGetRequest, EntityGetResponse,
    EntityListItem, EntityListRequest, EntityListResponseFrame, EntityResolveRequest,
    EntityResolveResponse, ForgetRequest, ForgetResponse, GetCapabilitiesRequest,
    GetCapabilitiesResponse, HelloCapabilities, HelloPayload, InferenceStep, LinkRequest,
    LinkResponse, MaterializeProceduralRequest, MaterializeProceduralResponse, MemoryResult,
    MtlsClaim, PlanRequest, PlanResponseFrame, PlanStep, QueryRequest, QueryResponse,
    ReasonRequest, ReasonResponseFrame, RecallRequest, RecallResponseFrame, RelationCreateRequest,
    RelationCreateResponse, RelationListFromRequest, RelationListFromResponseFrame,
    RelationListToRequest, RelationListToResponseFrame, RelationView, SchemaGetRequest,
    SchemaGetResponse, SchemaListItemWire, SchemaListRequest, SchemaListResponseFrame,
    SchemaUploadRequest, SchemaUploadResponse, SchemaValidateRequest, SchemaValidateResponse,
    ServerFeatures, StatementCreateRequest, StatementCreateResponse, StatementGetRequest,
    StatementGetResponse, StatementListRequest, StatementListResponseFrame, StatementView,
    SubscribeRequest, TxnAbortRequest, TxnAbortResponse, TxnBeginRequest, TxnBeginResponse,
    TxnCommitRequest, TxnCommitResponse, UnlinkRequest, UnlinkResponse,
};

/// Default `client_id` advertised in HELLO.
const DEFAULT_CLIENT_ID: &str = "brain-db-sdk-rust";

/// How the client authenticates after WELCOME. Auth is mandatory: there is no
/// anonymous mode. The credential is the connection's whole identity — the
/// server resolves `(namespace, agent, permissions)` from it and refuses any
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
    /// connection's identity; the server assigns the agent and namespace.
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

/// The session the server granted at handshake time.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub agent_id: [u8; 16],
    pub server_id: String,
    pub chosen_version: u8,
    pub session_id: [u8; 16],
    pub bound_shard_id: u16,
    pub permissions: AgentPermissions,
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
    session: SessionInfo,
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
            client_session_token: None,
        };
        let auth = AuthPayload {
            method: config.auth.method(),
            credentials: config.auth.credentials(),
        };

        let (conn, HandshakeOutcome { welcome, auth_ok }) =
            MuxConnection::handshake(stream, hello, auth, config.request_timeout).await?;

        let session = SessionInfo {
            agent_id: auth_ok.agent_id,
            server_id: welcome.server_id,
            chosen_version: welcome.chosen_version,
            session_id: welcome.session_id,
            bound_shard_id: auth_ok.bound_shard_id,
            permissions: auth_ok.permissions,
            namespace: auth_ok.namespace,
            server_features: welcome.server_features,
        };
        Ok(Self { conn, session })
    }

    /// The negotiated session.
    #[must_use]
    pub fn session(&self) -> &SessionInfo {
        &self.session
    }

    /// The agent id this connection acts as.
    #[must_use]
    pub fn agent_id(&self) -> [u8; 16] {
        self.session.agent_id
    }

    /// The owning tenant the server bound this connection to (server-derived
    /// from auth). Empty when the connection resolves to the reserved `brain`
    /// system namespace. Read-only — the client never sends a namespace.
    #[must_use]
    pub fn namespace(&self) -> &str {
        &self.session.namespace
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

    /// Run a typed-graph query (QUERY). Returns fused, ranked results
    /// with per-retriever contributions and outcome diagnostics.
    pub async fn query(&self, request: &QueryRequest) -> Result<QueryResponse> {
        self.unary(Opcode::QueryReq, Opcode::QueryResp, "QUERY_RESP", request)
            .await
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
