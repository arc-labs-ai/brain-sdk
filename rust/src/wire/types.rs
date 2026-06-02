//! Wire payload structs for the handshake + the v1 verbs + the
//! typed-graph ops the conformance corpus exercises.
//!
//! Field names, field order, and serde attributes match the server's
//! payload structs exactly, because CBOR struct encoding is field-order
//! sensitive and the corpus pins it byte-for-byte. The seam is the
//! `(struct, Option<vector>)` shape: only `EncodeVectorDirectRequest`
//! carries a trailing raw-vector section; every other payload is pure
//! CBOR.

use serde::{Deserialize, Serialize};

/// 16-byte UUID-shaped identifier (agent id, request id, txn id, …).
pub type WireUuid = [u8; 16];
/// `ContextId` on the wire — a `u64`.
pub type WireContextId = u64;
/// Packed `MemoryId` — a `u128`.
pub type WireMemoryId = u128;

// ===========================================================================
// Shared enums.
// ===========================================================================

/// Durable memory kind. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum MemoryKindWire {
    Episodic = 0,
    Semantic = 1,
    Consolidated = 2,
}

/// Edge kind for memory-to-memory links. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum EdgeKindWire {
    Caused = 0,
    FollowedBy = 1,
    DerivedFrom = 2,
    SimilarTo = 3,
    Contradicts = 4,
    Supports = 5,
    References = 6,
    PartOf = 7,
}

/// Soft tombstone vs. hard erase. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum ForgetMode {
    Soft = 0,
    Hard = 1,
}

/// Background stage a write queues. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum StageKind {
    AutoEdge = 0,
    TemporalEdge = 1,
    Extractor = 2,
}

// ===========================================================================
// Handshake.
// ===========================================================================

/// Feature flags exchanged during the handshake.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HelloCapabilities {
    pub streaming: bool,
    pub compression_zstd: bool,
    pub server_push: bool,
}

/// Authentication method. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum AuthMethod {
    Token = 0,
    Mtls = 1,
    None = 2,
}

/// Credentials carried in an AUTH frame. Externally-tagged enum (CBOR
/// map keyed by the variant name), matching the server.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum AuthCredentials {
    Token(Vec<u8>),
    Mtls(MtlsClaim),
    None,
}

/// mTLS claim accompanying an mTLS auth.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MtlsClaim {
    #[serde(with = "serde_bytes")]
    pub cert_fingerprint: [u8; 32],
    pub asserted_subject: String,
}

/// Agent permissions confirmed in AUTH_OK.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentPermissions {
    pub can_encode: bool,
    pub can_recall: bool,
    pub can_plan: bool,
    pub can_reason: bool,
    pub can_forget: bool,
    pub can_admin: bool,
}

/// Server-declared parameters carried in WELCOME.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServerFeatures {
    pub max_payload_size: u32,
    pub max_concurrent_streams: u32,
    pub idle_timeout_seconds: u32,
    pub auth_methods: Vec<AuthMethod>,
}

/// HELLO (`0x0001`) — first client frame after connect.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HelloPayload {
    pub client_id: String,
    pub supported_versions: Vec<u8>,
    pub capabilities: HelloCapabilities,
    /// Reserved for session resumption; `None` encodes as CBOR null.
    #[serde(with = "serde_bytes")]
    pub client_session_token: Option<[u8; 32]>,
}

/// WELCOME (`0x0081`) — server reply to HELLO.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WelcomePayload {
    pub server_id: String,
    pub chosen_version: u8,
    #[serde(with = "serde_bytes")]
    pub session_id: [u8; 16],
    pub capabilities: HelloCapabilities,
    pub server_features: ServerFeatures,
}

/// AUTH (`0x0002`) — client credentials.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthPayload {
    pub method: AuthMethod,
    #[serde(with = "serde_bytes")]
    pub agent_id: WireUuid,
    pub credentials: AuthCredentials,
}

/// AUTH_OK (`0x0082`) — server acknowledgment.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthOkPayload {
    #[serde(with = "serde_bytes")]
    pub agent_id: WireUuid,
    pub bound_shard_id: u16,
    pub permissions: AgentPermissions,
    pub server_time_unix_nanos: u64,
}

// ===========================================================================
// ENCODE / ENCODE_VECTOR_DIRECT.
// ===========================================================================

/// Edge attached to an ENCODE request.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EdgeRequest {
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    pub weight: f32,
}

/// ENCODE (`0x0020`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeRequest {
    pub text: String,
    pub context_id: WireContextId,
    pub kind: MemoryKindWire,
    pub salience_hint: f32,
    pub edges: Vec<EdgeRequest>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    pub deduplicate: bool,
}

/// ENCODE_VECTOR_DIRECT (`0x002A`). The embedding rides the trailing raw
/// little-endian f32 section, never the CBOR map, so `vector` is skipped
/// from CBOR and reattached at the payload codec seam.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeVectorDirectRequest {
    pub text: String,
    /// Carried in the trailing raw section, not the CBOR map.
    #[serde(skip, default)]
    pub vector: Vec<f32>,
    #[serde(with = "serde_bytes")]
    pub model_fingerprint: [u8; 16],
    pub context_id: WireContextId,
    pub kind: MemoryKindWire,
    pub salience_hint: f32,
    pub edges: Vec<EdgeRequest>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    pub deduplicate: bool,
}

/// ENCODE_RESP (`0x00A0`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeResponse {
    pub memory_id: WireMemoryId,
    pub was_deduplicated: bool,
    pub salience: f32,
    pub auto_edges_added: u32,
    pub lsn: u64,
    #[serde(with = "serde_bytes")]
    pub agent_id: WireUuid,
    pub context_id: WireContextId,
    pub kind: MemoryKindWire,
    pub created_at_unix_nanos: u64,
    pub edges_out_count: u32,
    #[serde(with = "serde_bytes")]
    pub embedding_model_fp: [u8; 16],
    pub pending_stages: Vec<StageKind>,
    pub has_active_schema: bool,
}

// ===========================================================================
// RECALL.
// ===========================================================================

/// RECALL (`0x0021`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallRequest {
    pub cue_text: String,
    pub top_k: u32,
    pub confidence_threshold: f32,
    pub context_filter: Option<Vec<WireContextId>>,
    pub age_bound_unix_nanos: Option<u64>,
    pub kind_filter: Option<Vec<MemoryKindWire>>,
    pub salience_floor: f32,
    pub include_edges: bool,
    pub include_graph: bool,
    pub include_text: bool,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::vec_byte_array16")]
    pub agent_filter: Vec<WireUuid>,
    pub include_other_agents: bool,
}

/// One streaming RECALL_RESP frame (`0x00A1`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallResponseFrame {
    pub results: Vec<MemoryResult>,
    pub is_final: bool,
    pub cumulative_count: u32,
    pub estimated_remaining: Option<u32>,
}

/// A single recalled memory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryResult {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub similarity_score: f32,
    pub confidence: f32,
    pub salience: f32,
    pub kind: MemoryKindWire,
    #[serde(with = "serde_bytes")]
    pub agent_id: WireUuid,
    pub context_id: WireContextId,
    pub created_at_unix_nanos: u64,
    pub last_accessed_at_unix_nanos: u64,
    pub edges: Option<Vec<EdgeView>>,
    pub contributing_retrievers: Vec<RetrieverNameWire>,
    pub fused_score: f32,
    pub rerank_score: Option<f32>,
    pub salience_initial: f32,
    pub access_count: u32,
    pub lsn: u64,
    pub flags: u32,
    pub consolidated_at_unix_nanos: Option<u64>,
    pub edges_out_count: u32,
    pub edges_in_count: u32,
    pub graph: Option<GraphEnrichment>,
}

/// Retriever family that surfaced a memory. Integer discriminant.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum RetrieverNameWire {
    Semantic = 0,
    Lexical = 1,
    Graph = 2,
}

/// Outgoing edge view on a recalled memory.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EdgeView {
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    pub weight: f32,
}

/// Per-hit typed-graph enrichment.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphEnrichment {
    pub entities: Vec<EnrichedEntity>,
    pub statements: Vec<EnrichedStatement>,
    pub relations: Vec<EnrichedRelation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrichedEntity {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub name: String,
    pub type_qname: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrichedStatement {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub subject_name: String,
    pub predicate: String,
    pub object_label: String,
    pub confidence: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrichedRelation {
    pub from_name: String,
    pub predicate: String,
    pub to_name: String,
}

// ===========================================================================
// FORGET.
// ===========================================================================

/// FORGET (`0x0024`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetRequest {
    pub memory_id: WireMemoryId,
    pub mode: ForgetMode,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
}

/// FORGET_RESP (`0x00A4`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetResponse {
    pub memory_id: WireMemoryId,
    pub was_already_forgotten: bool,
    pub edges_removed: u32,
}

// ===========================================================================
// LINK / UNLINK.
// ===========================================================================

/// LINK (`0x0025`). Creates (or reweights) an edge between two memories.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkRequest {
    pub source: WireMemoryId,
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    /// `[0, 1]` for most kinds; `[-1, 1]` for `Contradicts`.
    pub weight: f32,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
}

/// LINK_RESP (`0x00A5`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LinkResponse {
    pub source: WireMemoryId,
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    pub weight: f32,
    pub created_at_unix_nanos: u64,
    /// `true` if the edge already existed (LINK overwrote its weight);
    /// `false` if newly created.
    pub already_existed: bool,
}

/// UNLINK (`0x0026`). Removes the edge identified by the
/// `(source, kind, target)` triple.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnlinkRequest {
    pub source: WireMemoryId,
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
}

/// UNLINK_RESP (`0x00A6`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlinkResponse {
    pub source: WireMemoryId,
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    /// `true` if the edge existed and was removed; `false` if it didn't
    /// exist (UNLINK is idempotent — non-existent = no-op).
    pub removed: bool,
}

// ===========================================================================
// PLAN.
// ===========================================================================

/// Plan-strategy hint. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum PlanStrategy {
    Auto = 0,
    AStar = 1,
    Mcts = 2,
    AttractorRollout = 3,
}

/// Plan endpoint specification. Externally-tagged enum (CBOR map keyed by
/// the variant name), matching the server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum PlanState {
    ByMemoryId(WireMemoryId),
    ByText(String),
    ByVector { offset: u32, dim: u16 },
}

/// Plan budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanBudget {
    pub max_steps: u32,
    pub max_wall_time_ms: u32,
    pub max_branches_explored: u32,
}

/// PLAN (`0x0022`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanRequest {
    pub start: PlanState,
    pub goal: PlanState,
    pub budget: PlanBudget,
    pub strategy_hint: Option<PlanStrategy>,
    pub context_filter: Option<Vec<WireContextId>>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
}

/// Plan terminal status, set on the final frame only. Integer discriminant.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum PlanStatus {
    GoalReached = 0,
    BudgetExhausted = 1,
    NoPathFound = 2,
    Cancelled = 3,
}

/// Transition kind between plan steps. Externally-tagged enum, matching the
/// server (`Other` carries a free-form string).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TransitionKind {
    Initial,
    Causal,
    Temporal,
    Similarity,
    Other(String),
}

/// One step in a plan.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanStep {
    pub step_index: u32,
    pub memory_id: WireMemoryId,
    pub text: String,
    pub transition_kind: TransitionKind,
    pub confidence: f32,
    pub estimated_distance_to_goal: f32,
}

/// One streaming PLAN_RESP frame (`0x00A2`). The last frame carries
/// `is_final = true` and a populated `plan_status`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanResponseFrame {
    pub steps: Vec<PlanStep>,
    pub is_final: bool,
    pub plan_status: Option<PlanStatus>,
}

// ===========================================================================
// REASON.
// ===========================================================================

/// What to reason about. Externally-tagged enum, matching the server.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ObservationInput {
    ByMemoryId(WireMemoryId),
    ByText(String),
}

/// REASON (`0x0023`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonRequest {
    pub observation: ObservationInput,
    pub depth: u32,
    pub confidence_threshold: f32,
    pub context_filter: Option<Vec<WireContextId>>,
    pub max_inferences: u32,
    pub budget_wall_time_ms: u32,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
}

/// Reason terminal status, set on the final frame only. Integer discriminant.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum ReasonStatus {
    Complete = 0,
    BudgetExhausted = 1,
    DepthLimitReached = 2,
    Cancelled = 3,
}

/// Inference kind. Externally-tagged enum, matching the server (`Other`
/// carries a free-form string).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum InferenceKind {
    CausalExplanation,
    EvidenceAccumulation,
    AnalogicalInference,
    Other(String),
}

/// One inference step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InferenceStep {
    pub step_index: u32,
    pub claim: String,
    pub supporting_memories: Vec<WireMemoryId>,
    pub contradicting_memories: Vec<WireMemoryId>,
    pub confidence: f32,
    pub inference_kind: InferenceKind,
}

/// One streaming REASON_RESP frame (`0x00A3`). The last frame carries
/// `is_final = true` and a populated `reason_status`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonResponseFrame {
    pub inferences: Vec<InferenceStep>,
    pub is_final: bool,
    pub reason_status: Option<ReasonStatus>,
}

// ===========================================================================
// ERROR.
// ===========================================================================

/// Error category — the retry axis. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum ErrorCategoryWire {
    Protocol = 0,
    Authentication = 1,
    Authorization = 2,
    Validation = 3,
    NotFound = 4,
    Conflict = 5,
    ResourceExhausted = 6,
    Internal = 7,
    Unavailable = 8,
}

/// Wire error code (`u16`). Carried in an ERROR frame; the integer value
/// is the stable programmatic handle.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u16)]
pub enum ErrorCodeWire {
    // Protocol.
    BadMagic = 0x0001,
    BadHeaderCrc = 0x0002,
    BadPayloadCrc = 0x0003,
    BadOpcode = 0x0004,
    BadVersion = 0x0005,
    BadFrame = 0x0006,
    OversizePayload = 0x0007,
    ReservedFieldNonZero = 0x0008,
    BadFlagCombination = 0x0009,
    MalformedPayload = 0x000A,
    MalformedVector = 0x000B,
    // Connection / handshake.
    VersionNotSupported = 0x0020,
    NoSuchAuthMethod = 0x0021,
    Unauthenticated = 0x0022,
    NotAuthenticated = 0x0023,
    AuthBackendUnavailable = 0x0024,
    SessionExpired = 0x0025,
    // Authorization.
    PermissionDenied = 0x0030,
    AdminPermissionRequired = 0x0031,
    WrongShard = 0x0032,
    // Validation.
    InvalidArgument = 0x0040,
    MissingRequiredField = 0x0041,
    TextTooLarge = 0x0042,
    TextEmpty = 0x0043,
    BadContextId = 0x0044,
    BadMemoryKind = 0x0045,
    BadEdgeKind = 0x0046,
    BadStrategyHint = 0x0047,
    TopKOutOfRange = 0x0048,
    BudgetTooLarge = 0x0049,
    BadModelFingerprint = 0x004A,
    PredicateNotInSchema = 0x004B,
    RelationTypeNotInSchema = 0x004C,
    // Not found.
    MemoryNotFound = 0x0050,
    ContextNotFound = 0x0051,
    SubscriptionNotFound = 0x0052,
    SnapshotNotFound = 0x0053,
    TxnNotFound = 0x0054,
    // Conflict.
    IdempotencyConflict = 0x0060,
    TransactionConflict = 0x0061,
    TransactionTimeout = 0x0062,
    StreamIdInUse = 0x0063,
    SubscriptionLsnTooOld = 0x0064,
    CardinalityViolation = 0x0065,
    // Resource exhausted.
    OutOfSlots = 0x0070,
    OutOfDisk = 0x0071,
    OutOfMemory = 0x0072,
    RateLimited = 0x0073,
    StreamLimitExceeded = 0x0074,
    ConnectionLimitExceeded = 0x0075,
    TransactionLimitExceeded = 0x0076,
    TransactionTooLarge = 0x0077,
    // Internal.
    Internal = 0x0080,
    StorageError = 0x0081,
    IndexError = 0x0082,
    EmbeddingError = 0x0083,
    MetadataError = 0x0084,
    Cancelled = 0x0085,
    // Unavailable.
    ShardUnavailable = 0x0090,
    Overloaded = 0x0091,
    Restarting = 0x0092,
    Maintenance = 0x0093,
    RetrieverDegraded = 0x0094,
    // Typed-graph.
    SchemaInvalid = 0x0120,
    SchemaMigrationRequired = 0x0121,
    EntityNotFound = 0x0130,
    EntityTypeMismatch = 0x0131,
    EntityAmbiguous = 0x0132,
    EntityMergeConflict = 0x0133,
    StatementNotFound = 0x0140,
    StatementObjectTypeMismatch = 0x0141,
    StatementContradictsExisting = 0x0142,
    QueryTimeout = 0x0160,
    QueryOverBudget = 0x0161,
    ExtractorDisabled = 0x0170,
    ExtractorBudgetExceeded = 0x0171,
    ExtractionFailed = 0x0172,
}

/// Structured detail attached to an error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorDetails {
    pub field: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
}

/// ERROR (`0x00FF`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub code: ErrorCodeWire,
    pub category: ErrorCategoryWire,
    pub message: String,
    pub details: Option<ErrorDetails>,
    pub retry_after_ms: Option<u32>,
}

// ===========================================================================
// Typed-graph payloads exercised by the corpus.
// ===========================================================================

/// Statement kind. Encodes as a CBOR **string** unit variant (plain
/// serde, not an integer discriminant) — the server does the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatementKindWire {
    Fact,
    Preference,
    Event,
}

/// Scalar object value. Externally-tagged.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum StatementValueWire {
    Text(String),
    Integer(i64),
    Float(f64),
    Bool(bool),
    UnixNanos(u64),
    Blob(Vec<u8>),
}

/// Statement object. Each id variant is a CBOR byte string.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum StatementObjectWire {
    EntityRef(#[serde(with = "serde_bytes")] WireUuid),
    Value(StatementValueWire),
    MemoryRef(#[serde(with = "serde_bytes")] [u8; 16]),
    StatementRef(#[serde(with = "serde_bytes")] WireUuid),
}

/// Evidence reference. `Inline` is an array of byte-string memory ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EvidenceRefWire {
    Inline(#[serde(with = "crate::wire::cbor::vec_byte_array16")] Vec<[u8; 16]>),
    Overflow(#[serde(with = "serde_bytes")] WireUuid),
}

/// ENTITY_CREATE (`0x0130`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityCreateRequest {
    pub entity_type_id: u32,
    pub canonical_name: String,
    pub aliases: Vec<String>,
    pub attributes_blob: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_CREATE_RESP (`0x01B0`). The id is a plain CBOR array of bytes,
/// not a byte string — the server's response struct omits `serde_bytes`
/// on this field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityCreateResponse {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
}

/// STATEMENT_CREATE (`0x0140`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementCreateRequest {
    pub kind: StatementKindWire,
    #[serde(with = "serde_bytes")]
    pub subject: WireUuid,
    pub predicate: String,
    pub object: StatementObjectWire,
    pub confidence: f32,
    pub evidence: EvidenceRefWire,
    pub extractor_id: u32,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    pub event_at_unix_nanos: u64,
    pub schema_version: u32,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// STATEMENT_CREATE_RESP (`0x01C0`). All ids encode as CBOR byte strings
/// (major type 2), matching the server's uniform 16-byte id encoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementCreateResponse {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub auto_superseded: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
}

/// RELATION_CREATE (`0x0150`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationCreateRequest {
    pub relation_type: String,
    #[serde(with = "serde_bytes")]
    pub from_entity: WireUuid,
    #[serde(with = "serde_bytes")]
    pub to_entity: WireUuid,
    pub properties_blob: Vec<u8>,
    pub evidence: EvidenceRefWire,
    pub extractor_id: u32,
    pub confidence: f32,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// RELATION_CREATE_RESP (`0x01D0`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationCreateResponse {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
}

/// SCHEMA_UPLOAD (`0x0120`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaUploadRequest {
    pub schema_document: String,
    pub dry_run: bool,
    pub allow_breaking: bool,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// One structured schema parse/validate error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaValidationErrorWire {
    pub code: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub severity: u8,
}

/// SCHEMA_UPLOAD_RESP (`0x01A0`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaUploadResponse {
    pub namespace: String,
    pub schema_version: u32,
    pub validation_errors: Vec<SchemaValidationErrorWire>,
    pub backward_compatible: bool,
    pub migration_summary_blob: Vec<u8>,
}

/// Time window for a query. `None` bounds are open-ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRangeWire {
    pub from_unix_ms: Option<u64>,
    pub to_unix_ms: Option<u64>,
}

/// Retriever family selector enum. Integer discriminant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum RetrieverWire {
    Semantic = 0,
    Lexical = 1,
    Graph = 2,
}

/// Auto-routing vs explicit retriever list. Externally tagged (`"Auto"`
/// string or `{"Explicit": [...]}` map), matching the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RetrieverSelectionWire {
    Auto,
    Explicit(Vec<RetrieverWire>),
}

/// Per-query fusion override.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FusionConfigWire {
    pub k: u32,
    pub semantic_weight: f32,
    pub lexical_weight: f32,
    pub graph_weight: f32,
}

/// QUERY (`0x0160`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryRequest {
    pub text: String,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub entity_anchor: Option<WireUuid>,
    pub kind_filter: Vec<u8>,
    pub predicate_filter: Vec<String>,
    pub time_filter: Option<TimeRangeWire>,
    pub confidence_min: Option<f32>,
    pub include_tombstoned: bool,
    pub include_superseded: bool,
    pub limit: u32,
    pub retrievers: RetrieverSelectionWire,
    pub fusion_config: Option<FusionConfigWire>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// 4-variant ranked-item id projected to the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemIdWire {
    pub kind: u8,
    #[serde(with = "serde_bytes")]
    pub bytes: [u8; 16],
}

/// Per-retriever contribution to a fused item.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RetrieverContributionWire {
    pub retriever: RetrieverWire,
    pub rank: u32,
    pub raw_score: f32,
}

/// Retriever outcome summary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RetrieverOutcomeWire {
    pub retriever: RetrieverWire,
    pub status: u8,
    pub message: String,
    pub latency_ms: f64,
    pub result_count: u32,
}

/// One fused query result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryResultItem {
    pub id: ItemIdWire,
    pub fused_score: f64,
    pub contributing: Vec<RetrieverContributionWire>,
}

/// QUERY_RESP (`0x01E0`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryResponse {
    pub items: Vec<QueryResultItem>,
    pub total_latency_ms: f64,
    pub retriever_outcomes: Vec<RetrieverOutcomeWire>,
}

/// MATERIALIZE_PROCEDURAL (`0x0164`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterializeProceduralRequest {
    #[serde(with = "serde_bytes")]
    pub agent_id: WireUuid,
    pub context_filter: WireContextId,
    pub top_k: u32,
    pub min_confidence: f32,
    pub categories: Vec<String>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// MATERIALIZE_PROCEDURAL_RESP (`0x01E4`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterializeProceduralResponse {
    pub system_block: String,
    /// Each id encodes as a CBOR byte string (major type 2) inside the
    /// array, matching the server's uniform 16-byte id encoding.
    #[serde(with = "crate::wire::cbor::vec_byte_array16")]
    pub statement_ids: Vec<WireUuid>,
    pub total_candidates: u32,
    pub trimmed_by_budget: bool,
}

// ===========================================================================
// TXN_BEGIN / TXN_COMMIT / TXN_ABORT.
// ===========================================================================

/// TXN_BEGIN (`0x0040`). The client mints the `txn_id`; the server binds the
/// transaction to it for the duration of the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnBeginRequest {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
    pub timeout_seconds: u32,
}

/// TXN_BEGIN_RESP (`0x00C0`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnBeginResponse {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
    pub timeout_seconds: u32,
    pub started_at_unix_nanos: u64,
}

/// TXN_COMMIT (`0x0041`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnCommitRequest {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
}

/// TXN_COMMIT_RESP (`0x00C1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnCommitResponse {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
    pub committed_at_unix_nanos: u64,
    pub operations_applied: u32,
}

/// TXN_ABORT (`0x0042`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnAbortRequest {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
}

/// TXN_ABORT_RESP (`0x00C2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnAbortResponse {
    #[serde(with = "serde_bytes")]
    pub txn_id: WireUuid,
    pub operations_discarded: u32,
}

// ===========================================================================
// SUBSCRIBE / UNSUBSCRIBE + the subscription event union.
// ===========================================================================

/// Subscription event kind. Integer discriminant on the wire (mirrors the
/// server's `EventType`). The four cognitive variants populate the
/// `SubscriptionEvent` cognitive fields; the typed-graph variants zero-fill
/// them and carry their body in `graph_payload`.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum EventType {
    // Cognitive events.
    Encoded = 0,
    Forgotten = 1,
    Reclaimed = 2,
    KindChanged = 3,

    // Typed-graph events (graph_payload populated).
    EntityCreated = 16,
    EntityUpdated = 17,
    EntityRenamed = 18,
    EntityMerged = 19,
    EntityUnmerged = 20,
    EntityTombstoned = 21,
    StatementCreated = 22,
    StatementSuperseded = 23,
    StatementTombstoned = 24,
    RelationCreated = 25,
    RelationSuperseded = 26,
    StageCompleted = 27,
    SchemaUpdated = 29,
    RelationTombstoned = 30,

    // Unified-edge change feed (edge_payload populated).
    EdgeAdded = 31,
    EdgeRemoved = 32,
    EdgeSuperseded = 33,
}

/// Verdict of a completed background stage. Integer discriminant.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum StageOutcome {
    Ok = 0,
    Empty = 1,
    Failed = 2,
}

/// Audit verdict for an extractor stage. Integer discriminant.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum StageAuditStatus {
    Succeeded = 0,
    PartiallyApplied = 1,
    Failed = 2,
    Skipped = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageAutoEdgePayload {
    pub edges_written: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageTemporalEdgePayload {
    pub edges_written: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageExtractorPayload {
    pub entity_count: u32,
    pub statement_count: u32,
    pub relation_count: u32,
    pub audit_status: StageAuditStatus,
    /// Populated only when `audit_status == Failed`; empty otherwise.
    pub error_message: String,
}

/// Per-stage detail sidecar on `StageCompleted` events. Externally-tagged
/// enum (CBOR map keyed by the variant name), matching the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StagePayload {
    AutoEdge(StageAutoEdgePayload),
    TemporalEdge(StageTemporalEdgePayload),
    Extractor(StageExtractorPayload),
}

/// Vector-similarity subscription filter.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimilarityFilter {
    pub reference_memory_id: WireMemoryId,
    pub threshold: f32,
}

/// Selects which events a subscription receives. All fields `None`/empty
/// means "everything routed to this shard".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionFilter {
    pub contexts: Option<Vec<WireContextId>>,
    pub kinds: Option<Vec<MemoryKindWire>>,
    pub similar_to: Option<SimilarityFilter>,
    /// Subset of agent ids whose events the subscriber wants. `None` or
    /// empty = all agents on the shard.
    #[serde(with = "crate::wire::cbor::opt_vec_byte_array16")]
    pub agents: Option<Vec<WireUuid>>,
}

/// SUBSCRIBE (`0x0030`). Opens a long-lived push stream; the server emits
/// `SUBSCRIBE_EVENT` (`0x00B0`) frames on the subscription's stream id until
/// the client sends `UNSUBSCRIBE` (`0x0031`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubscribeRequest {
    pub filter: SubscriptionFilter,
    pub include_history: bool,
    pub from_lsn: Option<u64>,
    pub max_inflight: u32,
}

/// Side-channel payload on an `EdgeAdded` / `EdgeRemoved` / `EdgeSuperseded`
/// event. Covers both memory-graph edges and typed-graph relations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EdgeEventPayload {
    /// `0` = Memory, `1` = Entity.
    pub from_kind: u8,
    #[serde(with = "serde_bytes")]
    pub from_id: WireUuid,
    pub to_kind: u8,
    #[serde(with = "serde_bytes")]
    pub to_id: WireUuid,
    /// `0` = Builtin memory-graph kind, `1` = Mentions, `2` = Typed relation.
    pub edge_kind_tag: u8,
    pub edge_kind_byte: u8,
    /// `Some(_)` for typed-relation events.
    pub relation_type_id: Option<u32>,
    pub weight: f32,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub relation_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub superseded_relation_id: Option<WireUuid>,
    /// `0` = EXPLICIT, `1` = AUTO_DERIVED.
    pub origin: u8,
}

/// SUBSCRIBE_EVENT (`0x00B0`) — a single server-push event frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionEvent {
    pub event_type: EventType,
    pub memory_id: WireMemoryId,
    pub context_id: WireContextId,
    pub text: String,
    pub kind: MemoryKindWire,
    pub salience: f32,
    pub timestamp_unix_nanos: u64,
    pub lsn: u64,
    /// `None` for cognitive events; `Some(_)` for typed-graph events.
    pub graph_payload: Option<GraphEventPayload>,
    /// `Some(_)` for `EdgeAdded` / `EdgeRemoved` / `EdgeSuperseded`.
    pub edge_payload: Option<EdgeEventPayload>,
    /// `Some(_)` when `event_type == StageCompleted`.
    pub stage_kind: Option<StageKind>,
    pub stage_outcome: Option<StageOutcome>,
    pub stage_payload: Option<StagePayload>,
}

/// UNSUBSCRIBE (`0x0031`). `target_stream_id` is the stream id of the
/// subscription to tear down.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsubscribeRequest {
    pub target_stream_id: u32,
}

/// UNSUBSCRIBE_RESP (`0x00B1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsubscribeResponse {
    pub target_stream_id: u32,
    pub final_lsn: u64,
}

// ---------------------------------------------------------------------------
// Typed-graph subscription event bodies.
// ---------------------------------------------------------------------------

/// Typed payload for a typed-graph SUBSCRIBE event. Externally-tagged enum
/// (CBOR map keyed by the variant name), matching the server. Discriminated
/// at the application level by [`SubscriptionEvent::event_type`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum GraphEventPayload {
    EntityCreated(EntityCreatedEvent),
    EntityUpdated(EntityUpdatedEvent),
    EntityRenamed(EntityRenamedEvent),
    EntityMerged(EntityMergedEvent),
    EntityUnmerged(EntityUnmergedEvent),
    EntityTombstoned(EntityTombstonedEvent),
    StatementCreated(StatementCreatedEvent),
    StatementSuperseded(StatementSupersededEvent),
    StatementTombstoned(StatementTombstonedEvent),
    RelationCreated(RelationCreatedEvent),
    RelationSuperseded(RelationSupersededEvent),
    RelationTombstoned(RelationTombstonedEvent),
    SchemaUpdated(SchemaUpdatedEvent),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityCreatedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub entity_type_id: u32,
    pub canonical_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityUpdatedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub entity_type_id: u32,
    pub canonical_name: String,
    pub embedding_version_changed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityRenamedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub old_canonical_name: String,
    pub new_canonical_name: String,
    pub old_moved_to_alias: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityMergedEvent {
    #[serde(with = "serde_bytes")]
    pub survivor: WireUuid,
    #[serde(with = "serde_bytes")]
    pub merged: WireUuid,
    #[serde(with = "serde_bytes")]
    pub audit_id: WireUuid,
    pub confidence: f32,
    pub statements_rerouted: u32,
    pub relations_rerouted: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityUnmergedEvent {
    #[serde(with = "serde_bytes")]
    pub restored_entity_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub from_survivor: WireUuid,
    #[serde(with = "serde_bytes")]
    pub audit_id: WireUuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementCreatedEvent {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    /// 1=Fact, 2=Preference, 3=Event.
    pub kind: u8,
    #[serde(with = "serde_bytes")]
    pub subject: WireUuid,
    pub predicate: String,
    pub confidence: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementSupersededEvent {
    #[serde(with = "serde_bytes")]
    pub old_statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub new_statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationCreatedEvent {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    pub relation_type: String,
    #[serde(with = "serde_bytes")]
    pub from: WireUuid,
    #[serde(with = "serde_bytes")]
    pub to: WireUuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationSupersededEvent {
    #[serde(with = "serde_bytes")]
    pub old_relation_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub new_relation_id: WireUuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaUpdatedEvent {
    pub namespace: String,
    pub from_version: u32,
    pub to_version: u32,
    /// Always `true` in v1.
    pub backward_compatible: bool,
}

// ===========================================================================
// GET_CAPABILITIES.
// ===========================================================================

/// GET_CAPABILITIES (`0x0032`). Empty request — capabilities are
/// server-side state, so the client has nothing to send. Kept as a
/// struct (not a unit type) so the encoding matches every other request
/// body (a CBOR map, here empty).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetCapabilitiesRequest {}

/// Capability snapshot returned by the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// True when the cross-encoder reranker is loaded on this shard.
    pub rerank: bool,
    /// True when the LLM extractor tier is enabled.
    pub llm_extractor: bool,
    /// True when the classifier (GLiNER) extractor tier is enabled.
    pub classifier_extractor: bool,
    /// True when the pattern extractor tier is enabled.
    pub pattern_extractor: bool,
    /// User schema namespaces currently active on the shard (excludes the
    /// always-on `brain` system namespace).
    pub schema_namespaces: Vec<String>,
    /// Embedding vector dimensionality the shard's embedder produces.
    pub vector_dim: u16,
}

/// GET_CAPABILITIES_RESP (`0x00B2`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetCapabilitiesResponse {
    pub capabilities: Capabilities,
}

// ===========================================================================
// ENTITY_GET / ENTITY_LIST.
// ===========================================================================

/// Read-side view of an entity. Mirrors the server's `EntityView`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityView {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub entity_type_id: u32,
    pub canonical_name: String,
    pub normalized_name: String,
    pub aliases: Vec<String>,
    pub attributes_blob: Vec<u8>,
    pub mention_count: u32,
    pub created_at_unix_nanos: u64,
    pub updated_at_unix_nanos: u64,
    /// `[0; 16]` when not merged; consumers treat all-zero as None.
    #[serde(with = "serde_bytes")]
    pub merged_into: WireUuid,
    pub embedding_version: u32,
    pub flags: u32,
}

/// ENTITY_GET (`0x0131`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityGetRequest {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
}

/// ENTITY_GET_RESP (`0x01B1`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityGetResponse {
    pub entity: EntityView,
}

/// ENTITY_LIST (`0x0137`). Empty/zero fields mean "no filter".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityListRequest {
    /// `0` = no filter; otherwise an entity type id.
    pub entity_type_id: u32,
    /// Empty = no filter.
    pub name_prefix: String,
    pub mention_count_min: u32,
    pub include_tombstoned: bool,
    pub include_merged: bool,
    /// 1..=1000.
    pub limit: u32,
    /// Empty on first page; opaque continuation token otherwise.
    pub cursor: Vec<u8>,
}

/// One entity in an ENTITY_LIST response batch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityListItem {
    pub entity: EntityView,
}

/// One streaming ENTITY_LIST_RESP frame (`0x01B7`). The last frame carries
/// `is_final = true`. Mirrors `RecallResponseFrame`'s streaming shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityListResponseFrame {
    pub items: Vec<EntityListItem>,
    /// Empty `next_cursor` on the final frame means "exhausted"; non-empty
    /// means "more pages available, resume with this".
    pub next_cursor: Vec<u8>,
    pub cumulative_count: u32,
    pub is_final: bool,
}

// ===========================================================================
// STATEMENT_GET / STATEMENT_LIST.
// ===========================================================================

/// Read-side projection of a statement. Mirrors the server's
/// `StatementView`. Optional value-side fields collapse to sentinel zero
/// (`[0; 16]` for ids, `0` for nanos).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementView {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    pub kind: StatementKindWire,
    #[serde(with = "serde_bytes")]
    pub subject: WireUuid,
    #[serde(with = "serde_bytes")]
    pub subject_pending_audit_id: WireUuid,
    pub predicate: String,
    pub object: StatementObjectWire,
    pub confidence: f32,
    pub evidence: EvidenceRefWire,
    pub extractor_id: u32,
    pub extracted_at_unix_nanos: u64,
    pub schema_version: u32,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    pub event_at_unix_nanos: u64,
    pub version: u32,
    #[serde(with = "serde_bytes")]
    pub superseded_by: WireUuid,
    #[serde(with = "serde_bytes")]
    pub supersedes: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
    pub tombstoned: bool,
    pub tombstoned_at_unix_nanos: u64,
    pub tombstone_reason: u8,
    pub flags: u32,
    /// `true` iff this statement is stateful.
    pub is_stateful: bool,
}

/// STATEMENT_GET (`0x0141`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementGetRequest {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    /// If `true` and the row is superseded, the server returns the current
    /// statement in the chain (with `returned_via_supersession = true`).
    pub follow_supersession: bool,
}

/// STATEMENT_GET_RESP (`0x01C1`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementGetResponse {
    pub statement: StatementView,
    /// `true` iff `follow_supersession` redirected to a later chain entry.
    pub returned_via_supersession: bool,
}

/// STATEMENT_LIST (`0x0146`). Empty/zero fields mean "no filter".
/// `kind == 0` = no kind filter; otherwise `1 = Fact / 2 = Preference /
/// 3 = Event`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementListRequest {
    #[serde(with = "serde_bytes")]
    pub subject: WireUuid,
    pub predicate: String,
    pub kind: u8,
    pub min_confidence: f32,
    pub time_range_start_unix_nanos: u64,
    pub time_range_end_unix_nanos: u64,
    pub only_current: bool,
    pub include_tombstoned: bool,
    pub limit: u32,
    pub cursor: Vec<u8>,
}

/// One streaming STATEMENT_LIST_RESP frame (`0x01C6`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementListResponseFrame {
    pub items: Vec<StatementView>,
    pub next_cursor: Vec<u8>,
    pub cumulative_count: u32,
    pub is_final: bool,
}

// ===========================================================================
// RELATION_LIST_FROM / RELATION_LIST_TO.
// ===========================================================================

/// Read-side projection of a relation. Mirrors the server's
/// `RelationView`. `flags` bit 0 = `is_symmetric`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationView {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
    pub relation_type: String,
    #[serde(with = "serde_bytes")]
    pub from_entity: WireUuid,
    #[serde(with = "serde_bytes")]
    pub to_entity: WireUuid,
    pub properties_blob: Vec<u8>,
    pub evidence: EvidenceRefWire,
    pub extractor_id: u32,
    pub extracted_at_unix_nanos: u64,
    pub confidence: f32,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    pub version: u32,
    #[serde(with = "serde_bytes")]
    pub superseded_by: WireUuid,
    #[serde(with = "serde_bytes")]
    pub supersedes: WireUuid,
    pub tombstoned: bool,
    pub tombstoned_at_unix_nanos: u64,
    pub flags: u32,
}

/// RELATION_LIST_FROM (`0x0154`). `relation_type_filter == ""` → any type;
/// `time_range_*_unix_nanos == 0` → no time bound.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationListFromRequest {
    #[serde(with = "serde_bytes")]
    pub from_entity: WireUuid,
    pub relation_type_filter: String,
    pub time_range_start_unix_nanos: u64,
    pub time_range_end_unix_nanos: u64,
    pub include_superseded: bool,
    pub include_tombstoned: bool,
    pub limit: u32,
    pub cursor: Vec<u8>,
}

/// One streaming RELATION_LIST_FROM_RESP frame (`0x01D4`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationListFromResponseFrame {
    pub items: Vec<RelationView>,
    pub next_cursor: Vec<u8>,
    pub cumulative_count: u32,
    pub is_final: bool,
}

/// RELATION_LIST_TO (`0x0155`). Identical shape to LIST_FROM but filters on
/// `to_entity`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationListToRequest {
    #[serde(with = "serde_bytes")]
    pub to_entity: WireUuid,
    pub relation_type_filter: String,
    pub time_range_start_unix_nanos: u64,
    pub time_range_end_unix_nanos: u64,
    pub include_superseded: bool,
    pub include_tombstoned: bool,
    pub limit: u32,
    pub cursor: Vec<u8>,
}

/// One streaming RELATION_LIST_TO_RESP frame (`0x01D5`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationListToResponseFrame {
    pub items: Vec<RelationView>,
    pub next_cursor: Vec<u8>,
    pub cumulative_count: u32,
    pub is_final: bool,
}

// ===========================================================================
// SCHEMA_GET / SCHEMA_LIST / SCHEMA_VALIDATE.
// ===========================================================================

/// SCHEMA_GET (`0x0121`). `version == 0` → active version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaGetRequest {
    pub namespace: String,
    pub version: u32,
}

/// SCHEMA_GET_RESP (`0x01A1`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaGetResponse {
    pub namespace: String,
    pub schema_version: u32,
    /// Verbatim DSL text if uploaded as such; empty for programmatic uploads.
    pub schema_document: String,
    /// `serde_json::to_vec(&Schema)` of the parsed AST.
    pub source_blob: Vec<u8>,
    pub uploaded_at_unix_nanos: u64,
    pub validator_version: u32,
}

/// SCHEMA_LIST (`0x0122`). `limit == 0` → unlimited (server-capped).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaListRequest {
    pub namespace: String,
    pub limit: u32,
    pub cursor: Vec<u8>,
}

/// One entry in a SCHEMA_LIST response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaListItemWire {
    pub schema_version: u32,
    pub uploaded_at_unix_nanos: u64,
    pub validator_version: u32,
    pub has_source_text: bool,
}

/// One streaming SCHEMA_LIST_RESP frame (`0x01A2`). Items are newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaListResponseFrame {
    pub namespace: String,
    pub items: Vec<SchemaListItemWire>,
    pub total: u32,
    pub next_cursor: Vec<u8>,
    pub is_final: bool,
}

/// SCHEMA_VALIDATE (`0x0123`). Dry-run; never touches storage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaValidateRequest {
    pub schema_document: String,
}

/// SCHEMA_VALIDATE_RESP (`0x01A3`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaValidateResponse {
    /// Namespace parsed from the document; `""` if parse failed before
    /// reaching `namespace`.
    pub namespace: String,
    /// `current_active + 1` if validation passed; `0` otherwise.
    pub would_be_version: u32,
    pub validation_errors: Vec<SchemaValidationErrorWire>,
}
