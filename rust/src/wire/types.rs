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

/// 16-byte UUID-shaped identifier (space id, request id, txn id, …).
pub type WireUuid = [u8; 16];
/// `SessionId` on the wire — a `u64`.
pub type WireSessionId = u64;
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
    Hype = 3,
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
}

/// Credentials carried in an AUTH frame. Externally-tagged enum (CBOR
/// map keyed by the variant name), matching the server.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum AuthCredentials {
    Token(Vec<u8>),
    Mtls(MtlsClaim),
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
pub struct SpacePermissions {
    pub can_encode: bool,
    pub can_recall: bool,
    pub can_plan: bool,
    pub can_reason: bool,
    pub can_forget: bool,
    pub can_admin: bool,
    /// Authorizes the connection to run an op *on behalf of another identity*
    /// via the per-request `act_as` field. Held only by a trusted service
    /// principal (an edge / gateway); a normal agent's key never carries it,
    /// and it does not widen what the connection's own agent may do.
    pub can_act_as: bool,
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
    /// Reserved for connection resumption; `None` encodes as CBOR null.
    #[serde(with = "serde_bytes")]
    pub client_connection_token: Option<[u8; 32]>,
}

/// WELCOME (`0x0081`) — server reply to HELLO.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WelcomePayload {
    pub server_id: String,
    pub chosen_version: u8,
    /// 16 cryptographically-random bytes; per-connection identifier.
    #[serde(with = "serde_bytes")]
    pub connection_id: [u8; 16],
    pub capabilities: HelloCapabilities,
    pub server_features: ServerFeatures,
}

/// AUTH (`0x0002`) — client credentials. The client never claims an identity:
/// the server resolves `(namespace, space, permissions)` from the credential
/// alone and echoes the assignment in AUTH_OK.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthPayload {
    pub method: AuthMethod,
    pub credentials: AuthCredentials,
}

/// AUTH_OK (`0x0082`) — server acknowledgment.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthOkPayload {
    #[serde(with = "serde_bytes")]
    pub space_id: WireUuid,
    pub bound_shard_id: u16,
    pub permissions: SpacePermissions,
    /// Owning tenant the connection resolved to (server-derived from auth).
    /// Empty when the connection resolves to the reserved `brain` system
    /// namespace. The client only surfaces this — it never sends a namespace.
    pub namespace: String,
    pub server_time_unix_nanos: u64,
}

// ===========================================================================
// Per-request effective identity (`act_as`).
// ===========================================================================

/// Per-request effective-identity selector carried on data-plane op requests.
/// When present, the op runs as this `(namespace, space_id)` on behalf of the
/// authenticated connection principal; when the field is absent (the common
/// case, omitted on the wire) the op runs as the connection's own key-bound
/// identity.
///
/// Honored server-side only when the connection principal holds `can_act_as`
/// and `namespace` lies within its granted allowlist — otherwise the op is
/// rejected with [`ErrorCodeWire::ActAsDenied`]. This is the wire form only;
/// the trust model is enforced by the server, not this codec.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActAs {
    /// Effective namespace. Must be within the principal's allowlist.
    pub namespace: String,
    /// Structured, opaque effective-space selector (e.g.
    /// `"support-bot:user123"`) — a CBOR text string on the wire. The server
    /// derives the 16-byte storage space id from it at ingress. An empty
    /// string selects the connection's key-bound space.
    pub space_id: String,
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

/// Write-completion mode — how long a write op blocks before it returns.
///
/// API convention: writes take `wait` (this enum); reads take `trace: bool`.
/// They are never both on one op. On a write, waiting and the trace payload are
/// one decision — the only reason to wait for async derivation is to observe it —
/// so a single `wait` knob controls both. On a read there is no async to wait
/// for, so `trace` is a pure observability toggle with no timing effect.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
    serde_repr::Serialize_repr,
    serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum WaitMode {
    /// Return after the durable sync ack; async derivation runs in the
    /// background. The fast default (omitted from the wire map).
    #[default]
    Ack = 0,
    /// Block until async derivation completes, then return the full trace.
    Derived = 1,
}

impl WaitMode {
    /// `true` for the default [`WaitMode::Ack`] — used to omit the field from
    /// the wire map in the common case.
    #[must_use]
    pub fn is_ack(&self) -> bool {
        matches!(self, WaitMode::Ack)
    }
}

/// ENCODE (`0x0020`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeRequest {
    pub text: String,
    pub session_id: WireSessionId,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    pub occurred_at_unix_nanos: Option<u64>,
    /// Effective identity this encode runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
    /// How long the write blocks before replying. This is the single completion
    /// knob for writes (reads use `trace` instead — see [`WaitMode`]).
    ///
    /// - [`WaitMode::Ack`] (the default, omitted on the wire): return as soon as
    ///   the WAL record is durable; async derivation runs in the background and
    ///   the response's `trace` is `None`.
    /// - [`WaitMode::Derived`]: block until async derivation completes, then
    ///   return a populated `trace: EncodeTrace`.
    #[serde(default, skip_serializing_if = "WaitMode::is_ack")]
    pub wait: WaitMode,
    /// Opt out of content dedup and force a distinct memory. Default `false`:
    /// Brain dedupes text ENCODE on `(space_id, session_id, BLAKE3(text))` — a
    /// repeat of byte-identical text returns the existing MemoryId
    /// (`was_deduplicated = true`) and writes nothing new. Set `true` when the
    /// same text is a genuinely distinct observation that must coexist (e.g. the
    /// same fact re-stated at a different `occurred_at`). Omitted on the wire in
    /// the default (dedup-on) case.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_duplicates: bool,
}

/// `skip_serializing_if` predicate — omit `false` from the CBOR map so the
/// default (dedup-on) encode stays byte-minimal and wire-compatible.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
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
    pub session_id: WireSessionId,
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
    pub space_id: WireUuid,
    pub session_id: WireSessionId,
    pub kind: MemoryKindWire,
    pub created_at_unix_nanos: u64,
    pub edges_out_count: u32,
    #[serde(with = "serde_bytes")]
    pub embedding_model_fp: [u8; 16],
    pub pending_stages: Vec<StageKind>,
    pub has_active_schema: bool,
    /// Full synchronous write-analysis trace, present only when the request
    /// set `trace = true`; `None` otherwise (and absent from the wire map).
    /// The same async stages are also observable on SUBSCRIBE keyed by `lsn`
    /// + `pending_stages`; this field is the one-response alternative.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace: Option<EncodeTrace>,
}

/// Full synchronous write-analysis trace for one ENCODE, present when the
/// request opted in with `trace = true`. The ENCODE analog of `RecallTrace`:
/// `stages` is the per-phase timeline (synchronous phases plus async
/// derivation stages), and `artifacts` is what the write produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTrace {
    pub stages: Vec<EncodeTraceStage>,
    pub artifacts: EncodeTraceArtifacts,
    pub total_latency_us: u64,
}

/// One phase in an `EncodeTrace` timeline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceStage {
    pub name: String,
    pub status: EncodeTraceStageStatus,
    pub latency_us: u64,
    pub detail: String,
    /// The concrete data this stage produced (embed → vector, persist →
    /// record, extractor → graph, …). Present only when the caller set
    /// `trace = true` and the stage produced inspectable output; absent from
    /// the wire map otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<EncodeStageArtifact>,
}

/// Terminal status of an `EncodeTrace` phase.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum EncodeTraceStageStatus {
    Ok = 0,
    Skipped = 1,
    Failed = 2,
    Timeout = 3,
}

/// What an ENCODE produced, resolved after the async stages drained.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceArtifacts {
    pub entities: Vec<EncodeTraceEntity>,
    pub statements: Vec<EncodeTraceStatement>,
    pub relations: Vec<EncodeTraceRelation>,
    pub indexes: Vec<EncodeTraceIndex>,
    pub dedup: EncodeTraceDedup,
}

/// One entity artifact in an `EncodeTrace`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceEntity {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub name: String,
    pub type_qname: String,
}

/// One statement artifact in an `EncodeTrace`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceStatement {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub subject_name: String,
    pub predicate: String,
    pub object_name: String,
    pub confidence: f32,
    /// When the statement's EVENT happened, in unix nanos — the reified
    /// Time slot of an Event-kind statement. Absent from the wire map for
    /// a statement with no event time.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub event_at_unix_nanos: Option<u64>,
}

/// One relation artifact in an `EncodeTrace`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceRelation {
    pub source_name: String,
    pub predicate: String,
    pub target_name: String,
}

/// One index the write landed in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeTraceIndex {
    pub name: String,
    pub status: EncodeTraceStageStatus,
}

/// The dedup verdict carried on an `EncodeTrace`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncodeTraceDedup {
    pub was_deduplicated: bool,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub matched_memory_id: Option<[u8; 16]>,
}

// ===========================================================================
// Per-stage write artifacts — the concrete data each ENCODE stage produced.
// Shared shape for the live `trace = true` per-stage `artifact` AND the
// durable `MEMORY_INSPECT` bundle. Every field is optional and omitted from
// the wire map when empty/absent (matches the server's `skip_serializing_if`).
// ===========================================================================

/// The concrete output one ENCODE stage produced (embed → vector, persist →
/// record, HyPE → questions, text-index → keyword terms, extractor → graph).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EncodeStageArtifact {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vector: Vec<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<EncodeStageRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hype_questions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyword_fields: Vec<EncodeStageKeywordField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<EncodeStageGraph>,
}

/// The durable metadata row a `persist` stage wrote.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeStageRecord {
    #[serde(with = "serde_bytes")]
    pub memory_id: [u8; 16],
    pub kind: u8,
    pub salience: f32,
    pub created_at_unix_nanos: u64,
    pub occurred_at_unix_nanos: u64,
    pub vector_dim: u32,
    pub text_len: u32,
    pub lsn: u64,
}

/// One text-index field and the analyzed terms the write produced for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeStageKeywordField {
    pub field: String,
    pub terms: Vec<String>,
}

/// A node in the knowledge graph an ENCODE produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeGraphNode {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub name: String,
    pub kind: String,
    pub type_qname: String,
}

/// A directed edge in the knowledge graph an ENCODE produced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EncodeGraphEdge {
    #[serde(with = "serde_bytes")]
    pub source: [u8; 16],
    #[serde(with = "serde_bytes")]
    pub target: [u8; 16],
    pub predicate: String,
    pub kind: String,
    pub confidence: f32,
    /// When the EVENT this edge records happened, in unix nanos —
    /// denormalised from the backing statement. Absent from the wire map
    /// for an undated statement and for every non-statement edge kind.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub event_at_unix_nanos: Option<u64>,
}

/// The knowledge graph an ENCODE produced — nodes + directed edges.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EncodeStageGraph {
    pub nodes: Vec<EncodeGraphNode>,
    pub edges: Vec<EncodeGraphEdge>,
}

// ===========================================================================
// MEMORY_INSPECT — one memory's durable write-artifact bundle.
// ===========================================================================

/// `MEMORY_INSPECT_REQ` — fetch the durable write-artifact bundle for one
/// memory. Single-shot (not paginated).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryInspectRequest {
    #[serde(with = "serde_bytes")]
    pub memory_id: [u8; 16],
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// `MEMORY_INSPECT_RESP` — the durable per-memory artifact bundle plus text.
/// `found = false` (with an empty `artifact`) when no memory / no bundle
/// exists for the id under the caller's scope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryInspectResponse {
    pub found: bool,
    #[serde(with = "serde_bytes")]
    pub memory_id: [u8; 16],
    pub text: String,
    pub artifact: EncodeStageArtifact,
}

// ===========================================================================
// RECALL.
// ===========================================================================

/// What kind of answer a RECALL produced. Serializes as the variant name
/// string, matching the server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnswerKindWire {
    Single,
    Many,
    None,
}

/// RECALL (`0x0021`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallRequest {
    pub cue_text: String,
    pub subject_name: String,
    pub max_results: u32,
    pub confidence_threshold: f32,
    pub session_filter: Option<Vec<WireSessionId>>,
    pub age_bound_unix_nanos: Option<u64>,
    pub as_of_record_time_unix_nanos: Option<u64>,
    pub kind_filter: Option<Vec<MemoryKindWire>>,
    pub salience_floor: f32,
    pub include_edges: bool,
    pub include_graph: bool,
    pub include_text: bool,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    /// Opt-in per-stage observability. When `true`, the final response frame
    /// carries a populated `trace: RecallTrace`; when `false` (the default)
    /// the field is absent and the read pays nothing.
    #[serde(default)]
    pub trace: bool,
    /// Effective identity this recall runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// One streaming RECALL_RESP frame (`0x00A1`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallResponseFrame {
    pub answer_kind: AnswerKindWire,
    pub memories: Vec<MemoryResult>,
    pub is_final: bool,
    pub cumulative_count: u32,
    pub estimated_remaining: Option<u32>,
    /// Per-stage read-pipeline trace, present only on the final frame and only
    /// when the request set `trace = true`; `None` otherwise.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace: Option<RecallTrace>,
}

/// Per-stage observability for one RECALL, surfaced on the final frame when
/// the request opted in with `trace = true`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTrace {
    pub retrievers: Vec<RecallTraceRetriever>,
    pub filter_chain: RecallTraceFilterChain,
    pub rerank: Option<RecallTraceRerank>,
    pub total_latency_ms: f64,
    /// Full-detail mode only: per-fused-item score breakdown by
    /// contributing lane. `None` when trace detail wasn't requested or
    /// fusion produced nothing.
    pub fusion: Option<RecallTraceFusion>,
}

/// What one retriever lane did during a traced RECALL.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceRetriever {
    pub name: RetrieverNameWire,
    pub status: RecallTraceRetrieverStatus,
    /// Skip reason for `Skipped`, error message for `Failure`; empty otherwise.
    pub status_detail: String,
    pub latency_ms: f64,
    pub candidate_count: u32,
    /// Only populated in full-detail mode: the raw candidates this lane
    /// contributed before fusion, in the lane's own rank order.
    pub candidates: Vec<RecallTraceCandidate>,
}

/// One retriever-lane candidate surfaced in full-detail trace mode.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceCandidate {
    /// Raw id of the surfaced item — a memory, statement, entity, or relation
    /// id depending on `kind`. All are `u128` on the wire.
    pub item_id: WireMemoryId,
    /// How to interpret `item_id`.
    pub kind: RecallCandidateKind,
    /// A human-readable label — memory text, entity name, or a rendered
    /// statement/relation. Full-detail mode only; truncated server-side.
    pub text: String,
    /// This lane's raw score for this item.
    pub score: f32,
}

/// The kind of typed-graph item a retriever lane surfaced. The graph lane emits
/// entities and relations (not memories), so a candidate is not always a memory
/// — `kind` tells the client how to interpret `RecallTraceCandidate::item_id`.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum RecallCandidateKind {
    Memory = 0,
    Statement = 1,
    Entity = 2,
    Relation = 3,
}

/// Terminal status of a retriever lane in a RECALL trace.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum RecallTraceRetrieverStatus {
    Success = 0,
    Skipped = 1,
    Timeout = 2,
    Failure = 3,
}

/// Kind of a [`RecallTraceDroppedId`], disambiguating which id-space the
/// paired `id` belongs to. Mirrors the pipeline-internal `RankedItemId`,
/// which the supersession/as-of filter steps and the final limit truncation
/// can drop items from — unlike the type/temporal/confidence/tombstone
/// steps, supersession, as-of, and limit can drop `Statement` and
/// `Relation` items, not just `Memory` ones, so a plain (untagged)
/// `WireMemoryId` can't represent what those three steps removed.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum RankedItemKindWire {
    Memory = 0,
    Statement = 1,
    Entity = 2,
    Relation = 3,
}

/// One id a filter-chain step dropped, tagged with which id-space it came
/// from. Used where a step can drop non-`Memory` items (supersession,
/// as-of, and the final limit truncation all operate on the fused
/// `RankedItemId` set, which includes `Statement`/`Relation`/`Entity`
/// alongside `Memory`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceDroppedId {
    pub kind: RankedItemKindWire,
    pub id: u128,
}

/// Filter-chain survivor counts after each step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceFilterChain {
    pub before: u32,
    pub after_type: u32,
    pub after_temporal: u32,
    pub after_confidence: u32,
    pub after_tombstone: u32,
    pub after_supersession: u32,
    pub after_as_of: u32,
    pub after_limit: u32,
    /// Only populated in full-detail mode: which memory ids were removed
    /// by this specific filter step (empty = nothing dropped here).
    pub dropped_by_type: Vec<WireMemoryId>,
    /// Only populated in full-detail mode: which memory ids were removed
    /// by this specific filter step (empty = nothing dropped here).
    pub dropped_by_temporal: Vec<WireMemoryId>,
    /// Only populated in full-detail mode: which memory ids were removed
    /// by this specific filter step (empty = nothing dropped here).
    pub dropped_by_confidence: Vec<WireMemoryId>,
    /// Only populated in full-detail mode: which memory ids were removed
    /// by this specific filter step (empty = nothing dropped here).
    pub dropped_by_tombstone: Vec<WireMemoryId>,
    /// Only populated in full-detail mode: which ids were removed by
    /// supersession, kind-tagged since this step drops `Statement` and
    /// `Relation` items, not just `Memory` ones (empty = nothing dropped
    /// here).
    pub dropped_by_supersession: Vec<RecallTraceDroppedId>,
    /// Only populated in full-detail mode: which ids the bi-temporal
    /// as-of filter removed, kind-tagged since this step drops `Statement`
    /// items (empty = nothing dropped here).
    pub dropped_by_as_of: Vec<RecallTraceDroppedId>,
    /// Only populated in full-detail mode: which ids the final `limit`
    /// truncation removed, kind-tagged since the truncated tail can
    /// contain any item kind (empty = nothing dropped here).
    pub dropped_by_limit: Vec<RecallTraceDroppedId>,
}

/// Outcome of the cross-encoder rerank stage in a RECALL trace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceRerank {
    pub applied: bool,
    pub candidates: u32,
    pub latency_ms: f64,
    /// Full-detail mode only: the fused (pre-rerank) order, so the client
    /// can show exactly what the cross-encoder moved.
    pub before_order: Vec<WireMemoryId>,
    /// Full-detail mode only: the post-rerank order, so the client can show
    /// exactly what the cross-encoder moved.
    pub after_order: Vec<WireMemoryId>,
}

/// Per-fused-item RRF score plus the per-lane component scores that
/// contributed to it, surfaced on a `RecallTrace` when the request opted
/// into tracing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceFusion {
    pub items: Vec<RecallTraceFusionItem>,
}

/// One fused item's RRF score plus the per-lane component scores that
/// contributed to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecallTraceFusionItem {
    pub memory_id: WireMemoryId,
    pub rrf_score: f32,
    pub lane_scores: Vec<(RetrieverNameWire, f32)>,
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
    pub space_id: WireUuid,
    pub session_id: WireSessionId,
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
    pub occurred_at_unix_nanos: Option<u64>,
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

/// A typed entity attached to a recall hit by [`GraphEnrichment`]: the resolved
/// entity id, its display name, and its schema type qname.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrichedEntity {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub name: String,
    pub type_qname: String,
}

/// A typed statement attached to a recall hit by [`GraphEnrichment`], flattened
/// to display strings (subject name, predicate, object label) plus its
/// confidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnrichedStatement {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub subject_name: String,
    pub predicate: String,
    pub object_label: String,
    pub confidence: f32,
    /// When the statement's EVENT happened, in unix nanos — the reified
    /// Time slot of an Event-kind statement. Absent from the wire map for
    /// a statement with no event time.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub event_at_unix_nanos: Option<u64>,
}

/// A typed relation attached to a recall hit by [`GraphEnrichment`], flattened
/// to the two endpoint names and the connecting predicate.
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgetRequest {
    pub memory_id: WireMemoryId,
    pub mode: ForgetMode,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    /// Effective identity this forget runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// Effective identity this link runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UnlinkRequest {
    pub source: WireMemoryId,
    pub target: WireMemoryId,
    pub kind: EdgeKindWire,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    /// Effective identity this unlink runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
// MEMORY_LIST.
// ===========================================================================

/// Sort axis for MEMORY_LIST. Integer discriminant on the wire. v1 supports
/// only `Created` end-to-end; the others are reserved wire values.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum MemoryListSortWire {
    Created = 0,
    Salience = 1,
    Occurred = 2,
    LastAccessed = 3,
}

/// Sort direction for MEMORY_LIST. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum MemoryListDirWire {
    Asc = 0,
    Desc = 1,
}

/// Which time field a MEMORY_LIST `from`/`to` range filters on. Integer
/// discriminant on the wire. v1 supports only `Created`.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum MemoryListTimeAxisWire {
    Created = 0,
    Occurred = 1,
}

/// MEMORY_LIST (`0x0027`) — a paginated enumeration of the caller's
/// `(namespace, space)` memories. This is not RECALL: no query, no ranking.
/// It walks the tenant timeline in a stable order and returns a page plus an
/// opaque keyset cursor. Empty/zero fields mean "no filter". v1 supports
/// `sort = Created` (Asc/Desc); other sorts, the text filter, and the
/// occurred axis are rejected with InvalidRequest.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryListRequest {
    pub sort: MemoryListSortWire,
    pub dir: MemoryListDirWire,
    /// Page size, validated server-side to `1..=100`.
    pub limit: u32,
    /// Empty on first page; opaque continuation token otherwise.
    pub cursor: Vec<u8>,
    /// Empty = all kinds; otherwise only these memory kinds are returned.
    pub kinds: Vec<MemoryKindWire>,
    /// When false, tombstoned memories are excluded; when true, both active
    /// and tombstoned rows are enumerated.
    pub include_tombstoned: bool,
    /// Which time field the `from`/`to` bounds apply to.
    pub time_axis: MemoryListTimeAxisWire,
    /// Inclusive lower time bound in unix-nanos; `0` = no lower bound.
    pub from_unix_nanos: u64,
    /// Inclusive upper time bound in unix-nanos; `0` = no upper bound.
    pub to_unix_nanos: u64,
    /// Inclusive salience floor in `[0, 1]`.
    pub salience_min: f32,
    /// Inclusive salience ceiling in `[0, 1]`.
    pub salience_max: f32,
    /// Substring/token filter over memory text; empty = no filter.
    pub text_contains: String,
    /// Effective identity this list runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity. Honored only when
    /// the connection principal holds the `ACT_AS` grant and the target
    /// namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// One memory in a MEMORY_LIST response batch. Carries the
/// enumeration-relevant fields plus relationship-handle counts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryListItem {
    #[serde(with = "serde_bytes")]
    pub memory_id: [u8; 16],
    /// Owner space (16-byte storage key) the row belongs to.
    #[serde(with = "serde_bytes")]
    pub space_id: [u8; 16],
    /// Session (conversation) the memory was encoded under; `0` = default.
    pub session_id: WireSessionId,
    pub text: String,
    /// Raw memory-kind byte (0 = Episodic, 1 = Semantic, 2 = Consolidated).
    pub kind: u8,
    /// Lifecycle state byte (0 = active, 1 = tombstoned).
    pub state: u8,
    pub created_at_unix_nanos: u64,
    /// Client-supplied event time; `0` when the memory has none.
    pub occurred_at_unix_nanos: u64,
    pub last_accessed_at_unix_nanos: u64,
    /// Point-in-time salience snapshot (it decays).
    pub salience: f32,
    pub access_count: u32,
    #[serde(with = "serde_bytes")]
    pub source_request_id: [u8; 16],
    pub statement_count: u32,
    pub entity_count: u32,
    pub relation_count: u32,
}

/// One streaming MEMORY_LIST_RESP frame (`0x00A7`). The last frame carries
/// `is_final = true`. Empty `next_cursor` on the final frame means "exhausted";
/// non-empty means "more pages available, resume with this".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryListResponseFrame {
    pub items: Vec<MemoryListItem>,
    pub next_cursor: Vec<u8>,
    pub cumulative_count: u32,
    pub is_final: bool,
}

// ===========================================================================
// GRAPH_FETCH — full-space typed-graph export.
// ===========================================================================

/// One graph node. `id` is the 16-byte entity / statement / memory id; `kind`
/// says which id-space it is (0 = Entity, 1 = Statement, 2 = Memory).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    #[serde(with = "serde_bytes")]
    pub id: [u8; 16],
    pub kind: u8,
    pub label: String,
    /// Entity type qname (e.g. `brain:Person`); empty for non-entity nodes.
    pub type_qname: String,
}

/// One graph edge. `kind`: 0 = Relation, 1 = Fact, 2 = HasStatement,
/// 3 = Mentions, 4..=11 = the memory↔memory builtin kinds in `EdgeKind` order
/// (`4 + EdgeKind as u8`), i.e. 4 = Caused, 5 = FollowedBy, 6 = DerivedFrom,
/// 7 = SimilarTo, 8 = Contradicts, 9 = Supports, 10 = References, 11 = PartOf.
/// The kind byte alone identifies the link — there is no companion field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphEdge {
    #[serde(with = "serde_bytes")]
    pub from_id: [u8; 16],
    #[serde(with = "serde_bytes")]
    pub to_id: [u8; 16],
    pub kind: u8,
    /// Predicate / relation-type label; empty for `Mentions`.
    pub label: String,
}

/// GRAPH_FETCH (`0x0163`) — a paginated export of the caller's whole
/// `(namespace, space)` typed graph as a node/edge set. Default layer is the
/// concept map (entity nodes + Relation/Fact edges); `include_statements` adds
/// value-object statement nodes, `include_memories` adds source-memory nodes,
/// `include_memory_edges` adds the stored memory↔memory links between them.
/// The cursor is opaque, signed over the layer toggles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphFetchRequest {
    /// Page size, validated server-side to `1..=500`.
    pub limit: u32,
    /// Empty on first page; opaque continuation token otherwise.
    pub cursor: Vec<u8>,
    /// Emit value-object statement nodes + their `HasStatement` edges.
    pub include_statements: bool,
    /// Emit source memory nodes + their `Mentions` edges.
    pub include_memories: bool,
    /// Emit the stored memory↔memory edges (`SimilarTo`, `FollowedBy`, …)
    /// incident to the page's memory nodes. Requires `include_memories` —
    /// setting it alone is rejected, because the edges would have no rendered
    /// endpoints. A far endpoint outside the page is emitted as a memory node
    /// so no edge dangles.
    pub include_memory_edges: bool,
    /// Include tombstoned statements/relations. Default false.
    pub include_tombstoned: bool,
    /// Effective identity this export runs as. `None` (omitted on the wire)
    /// runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// One streaming GRAPH_FETCH_RESP frame (`0x01E3`). Nodes/edges may repeat
/// across pages (completeness, not disjointness) — dedup by id. Empty
/// `next_cursor` means exhausted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphFetchResponseFrame {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub next_cursor: Vec<u8>,
    pub is_final: bool,
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
    pub session_filter: Option<Vec<WireSessionId>>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    /// Opt-in per-stage observability. When `true`, the final response frame
    /// carries a populated `trace: PlanTrace` describing every node the
    /// bidirectional BFS visited (in both directions) and every meeting
    /// point found, including the ones dropped by the `max_paths` cap. When
    /// `false` (the default) the field is absent and the plan pays nothing.
    /// Mirrors `RecallRequest.trace`.
    #[serde(default)]
    pub trace: bool,
    /// Effective identity this plan runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Per-stage bidirectional-search trace. Populated only on the final
    /// frame and only when the request set `trace = true`; `None` otherwise
    /// (and omitted from the wire map so `trace = false` plans pay
    /// nothing). Mirrors `RecallResponseFrame.trace`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace: Option<PlanTrace>,
}

/// Per-stage observability for one PLAN, surfaced on the final frame when
/// the request opted in with `trace = true`. `trace = true` means full
/// detail — there is no separate knob — so every field below is populated
/// whenever this struct is present at all. Surfaces the full bidirectional
/// BFS visited-map contents from both directions (not just a scalar
/// explored-node count) and every meeting point found, flagging which
/// survived the `max_paths` cap.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTrace {
    /// Every node the bidirectional BFS visited, in both directions.
    pub explored: Vec<PlanTraceNode>,
    /// Every meeting point the BFS found, flagging which ones survived the
    /// `max_paths` cap and made it into the returned path(s).
    pub meeting_points: Vec<PlanTraceMeetingPoint>,
}

/// Which direction of the bidirectional BFS a `PlanTraceNode` was visited
/// from. Integer discriminant on the wire.
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum PlanTraceDirection {
    /// Visited by the forward search, rooted at `start`.
    Forward = 0,
    /// Visited by the backward search, rooted at `goal`.
    Backward = 1,
}

/// One node the bidirectional BFS visited, from either direction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTraceNode {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub direction: PlanTraceDirection,
    pub depth: u32,
    /// The edge this node was reached through. `None` for the root
    /// (`start` in the forward direction, `goal` in the backward
    /// direction).
    pub parent_edge: Option<WireMemoryId>,
    /// The goal-proximity alignment score computed for this node, when one
    /// was computed.
    pub alignment_score: Option<f32>,
}

/// One meeting point the bidirectional BFS found where the forward and
/// backward frontiers connected.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTraceMeetingPoint {
    pub memory_id: WireMemoryId,
    pub text: String,
    /// `true` when this meeting point survived the `max_paths` cap and
    /// contributed a path to the response; `false` when it was found but
    /// dropped by the cap.
    pub included_in_result: bool,
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
    pub session_filter: Option<Vec<WireSessionId>>,
    pub max_inferences: u32,
    pub budget_wall_time_ms: u32,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub request_id: Option<WireUuid>,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub txn_id: Option<WireUuid>,
    /// Opt-in per-stage observability. When `true`, the final response frame
    /// carries a populated `trace: ReasonTrace` describing the full
    /// base-candidate set, every edge the outward walk considered (and why
    /// each was pruned), the un-collapsed per-item score components, and
    /// whether topic-alignment centroid computation ran. When `false` (the
    /// default) the field is absent and the reason pays nothing. Mirrors
    /// `RecallRequest.trace`.
    #[serde(default)]
    pub trace: bool,
    /// Effective identity this reason runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Per-stage read-pipeline trace. Populated only on the final frame and
    /// only when the request set `trace = true`; `None` otherwise (and
    /// omitted from the wire map so `trace = false` reasons pay nothing).
    /// Mirrors `RecallResponseFrame.trace`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trace: Option<ReasonTrace>,
}

/// Per-stage observability for one REASON, surfaced on the final frame when
/// the request opted in with `trace = true`. `trace = true` means full
/// detail — there is no separate knob — so every field below is populated
/// whenever this struct is present at all. Mirrors `RecallTrace`'s
/// per-stage-detail precedent, applied to the outward evidence walk instead
/// of the retriever fan-out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTrace {
    /// The full HNSW hit set the base observation resolved to, not just the
    /// subset that seeded the walk.
    pub base: ReasonTraceBase,
    /// Everything the outward evidence walk touched: considered edges and
    /// every prune reason, one bucket per prune point.
    pub walk: ReasonTraceWalk,
    /// Un-collapsed score components for every surviving evidence item.
    pub scoring: Vec<ReasonTraceScoreBreakdown>,
    /// Whether topic-alignment centroid computation ran, and why not when
    /// it didn't.
    pub centroid: ReasonTraceCentroid,
}

/// The base observation's resolved candidate set, before any evidence walk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceBase {
    pub candidates: Vec<ReasonTraceCandidate>,
}

/// One base-candidate hit surfaced in a REASON trace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceCandidate {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub score: f32,
}

/// Everything the outward evidence walk considered and every reason an edge
/// or item was pruned before becoming a surviving `InferenceStep`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceWalk {
    /// Every edge the walk visited at each node, before any pruning — the
    /// direct analogue of `RecallTraceRetriever.candidates`.
    pub considered: Vec<ReasonTraceEdgeCandidate>,
    /// Edges pruned by the edge-kind filter.
    pub dropped_by_edge_kind: Vec<ReasonTraceEdgeCandidate>,
    /// Edges pruned because the target memory was tombstoned.
    pub dropped_by_tombstone: Vec<ReasonTraceIdWithText>,
    /// Edges pruned because the target memory was already visited.
    pub dropped_by_visited: Vec<ReasonTraceIdWithText>,
    /// Evidence items pruned by `confidence_threshold`.
    pub dropped_by_confidence: Vec<ReasonTraceScoredId>,
    /// Supporting-evidence items dropped by the per-inference trim cap.
    pub dropped_by_max_supporting: Vec<ReasonTraceIdWithText>,
    /// Contradicting-evidence items dropped by the per-inference trim cap.
    pub dropped_by_max_contradicting: Vec<ReasonTraceIdWithText>,
}

/// One edge the outward walk visited, considered or dropped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceEdgeCandidate {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub edge_kind: EdgeKindWire,
    pub depth: u32,
    pub from_memory_id: WireMemoryId,
    pub raw_score: f32,
}

/// A memory id plus its stored text, with no other payload — the shared
/// shape for the walk's plain id-dropped buckets (tombstone / visited /
/// trim-cap) so an opaque id is never surfaced without the content that
/// explains the drop.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceIdWithText {
    pub memory_id: WireMemoryId,
    pub text: String,
}

/// A memory id paired with the score it was dropped at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceScoredId {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub score: f32,
}

/// The un-collapsed multiplicative score components combined into one
/// `InferenceStep.confidence` value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceScoreBreakdown {
    pub memory_id: WireMemoryId,
    pub text: String,
    pub base_similarity: f32,
    pub decay: f32,
    pub weight_product: f32,
    pub alignment: f32,
    /// Structural-fit nudge from VSA analogical inference (bind/bundle/
    /// `analogy_query` over the item's statement-graph triple against the
    /// observation's own triple). Neutral `1.0` when no triple is
    /// resolvable for the item — a re-rank nudge only, never a gate.
    pub analogical_fit: f32,
    pub final_score: f32,
}

/// Whether topic-alignment centroid computation ran for this REASON. The
/// server's centroid step silently skips several paths (singleton base,
/// text-only observation, missing text, embed error); this makes that
/// outcome visible on the wire instead of a debug-log-only signal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReasonTraceCentroid {
    pub computed: bool,
    /// Populated when `computed = false`; empty otherwise.
    pub skipped_reason: Option<String>,
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
    ActAsDenied = 0x0033,
    // Validation.
    InvalidArgument = 0x0040,
    MissingRequiredField = 0x0041,
    TextTooLarge = 0x0042,
    TextEmpty = 0x0043,
    BadSessionId = 0x0044,
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

/// Statement kind. The fieldless variants encode as a CBOR **string** unit
/// variant (plain serde, not an integer discriminant); `Custom(u8)` encodes
/// as a single-entry CBOR map `{"Custom": <byte>}` — the server does the
/// same. The storage-byte mapping is `0 = Fact`, `1 = Preference`,
/// `2 = Event`, `3 = Attribute`, `4 = Relation`, `5 = Directive`, and any
/// byte `>= 6` is a `Custom(byte)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatementKindWire {
    Fact,
    Preference,
    Event,
    Attribute,
    Relation,
    Directive,
    Custom(u8),
}

impl StatementKindWire {
    /// The storage discriminant byte for this kind.
    #[must_use]
    pub fn to_storage_byte(self) -> u8 {
        match self {
            StatementKindWire::Fact => 0,
            StatementKindWire::Preference => 1,
            StatementKindWire::Event => 2,
            StatementKindWire::Attribute => 3,
            StatementKindWire::Relation => 4,
            StatementKindWire::Directive => 5,
            StatementKindWire::Custom(b) => b,
        }
    }

    /// The kind for a storage discriminant byte. Bytes `>= 6` map to
    /// `Custom(byte)`.
    #[must_use]
    pub fn from_storage_byte(byte: u8) -> Self {
        match byte {
            0 => StatementKindWire::Fact,
            1 => StatementKindWire::Preference,
            2 => StatementKindWire::Event,
            3 => StatementKindWire::Attribute,
            4 => StatementKindWire::Relation,
            5 => StatementKindWire::Directive,
            b => StatementKindWire::Custom(b),
        }
    }
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
    /// Session that first mentions this entity; `0` = default session.
    /// First-mention provenance only — entity identity is session-agnostic.
    #[serde(default)]
    pub session_id: WireSessionId,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    /// Effective identity this entity-create runs as. `None` (omitted on the
    /// wire) means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// ENTITY_UPDATE (`0x0132`). Replace an entity's name, aliases, and
/// attribute blob wholesale — the way an agent revises what it knows about a
/// thing as new detail arrives.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityUpdateRequest {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub canonical_name: String,
    pub aliases: Vec<String>,
    pub attributes_blob: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_UPDATE_RESP (`0x01B2`). The post-update view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityUpdateResponse {
    pub entity: EntityView,
}

/// ENTITY_RENAME (`0x0133`). Change only the canonical name. `move_to_alias`
/// keeps the old name reachable as an alias instead of dropping it, so a
/// rename never silently loses a name the graph already links by.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityRenameRequest {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub new_canonical_name: String,
    pub move_to_alias: bool,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_RENAME_RESP (`0x01B3`). The post-rename view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityRenameResponse {
    pub entity: EntityView,
}

/// ENTITY_MERGE (`0x0134`). Fold `merged` into `survivor` when they turn out
/// to be the same real-world entity. The merge is reversible within a grace
/// window (see the response), so a wrong merge is recoverable rather than
/// destructive.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityMergeRequest {
    #[serde(with = "serde_bytes")]
    pub survivor: WireUuid,
    #[serde(with = "serde_bytes")]
    pub merged: WireUuid,
    pub confidence: f32,
    pub reason: String,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_MERGE_RESP (`0x01B4`). `audit_id` is the merge record (not an
/// entity id); `grace_period_seconds` is how long an unmerge can still undo it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityMergeResponse {
    #[serde(with = "serde_bytes")]
    pub audit_id: WireUuid,
    pub grace_period_seconds: u64,
}

/// ENTITY_UNMERGE (`0x0135`). Undo a merge, restoring the folded-away entity
/// as its own row again. Only valid inside the merge's grace window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityUnmergeRequest {
    #[serde(with = "serde_bytes")]
    pub merged_entity: WireUuid,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_UNMERGE_RESP (`0x01B5`). The id the restored entity now lives under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityUnmergeResponse {
    #[serde(with = "serde_bytes")]
    pub restored_entity_id: WireUuid,
}

/// ENTITY_TOMBSTONE (`0x0138`). Retire an entity with a reason for the audit
/// trail. Tombstoning is soft — the row survives (recoverable) but drops out
/// of resolution and traversal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityTombstoneRequest {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub reason: String,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// ENTITY_TOMBSTONE_RESP (`0x01B8`). When the retirement took effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityTombstoneResponse {
    pub tombstoned_at_unix_nanos: u64,
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
    /// Conversation/run this statement belongs to; `0` = default session.
    /// A grouping key, not an isolation boundary.
    #[serde(default)]
    pub session_id: WireSessionId,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    /// Effective identity this statement-create runs as. `None` (omitted on
    /// the wire) means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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

/// STATEMENT_SUPERSEDE (`0x0142`). Replace an existing claim with a revised
/// one, keeping both linked on the same supersession chain so history stays
/// intact — the way an agent updates a belief without erasing what it used to
/// hold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementSupersedeRequest {
    #[serde(with = "serde_bytes")]
    pub old_statement_id: WireUuid,
    pub new_statement: StatementCreateRequest,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// STATEMENT_SUPERSEDE_RESP (`0x01C2`). The new statement plus its chain root
/// and monotonically-increasing version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementSupersedeResponse {
    #[serde(with = "serde_bytes")]
    pub new_statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
    pub version: u32,
}

/// STATEMENT_TOMBSTONE (`0x0143`). Retire a statement with a coded reason for
/// the audit trail. Soft: the row survives (recoverable) but stops answering.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementTombstoneRequest {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    pub reason: u8,
    pub reason_message: String,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// STATEMENT_TOMBSTONE_RESP (`0x01C3`). When the retirement took effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementTombstoneResponse {
    pub tombstoned_at_unix_nanos: u64,
}

/// STATEMENT_RETRACT (`0x0144`). Assert a claim was wrong (not merely
/// superseded). Retraction schedules a hard-zero after a window, so a genuine
/// mistake can be scrubbed rather than left tombstoned forever.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementRetractRequest {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    pub reason: u8,
    pub reason_message: String,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// STATEMENT_RETRACT_RESP (`0x01C4`). When it was retracted, and when the
/// scheduled hard-zero will scrub it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementRetractResponse {
    pub retracted_at_unix_nanos: u64,
    pub will_zero_at_unix_nanos: u64,
}

/// STATEMENT_HISTORY (`0x0145`). Walk every version on a claim's supersession
/// chain. A read, so it carries no `request_id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementHistoryRequest {
    #[serde(with = "serde_bytes")]
    pub anchor_id: WireUuid,
    pub include_tombstoned: bool,
}

/// STATEMENT_HISTORY_RESP (`0x01C5`), one streamed frame. `is_final` marks the
/// last frame; `total_versions` is the chain length.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementHistoryResponseFrame {
    pub items: Vec<StatementView>,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
    pub total_versions: u32,
    pub is_final: bool,
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
    /// Conversation/run this relation belongs to; `0` = default session.
    /// A grouping key, not an isolation boundary.
    #[serde(default)]
    pub session_id: WireSessionId,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    /// Effective identity this relation-create runs as. `None` (omitted on the
    /// wire) means the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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

/// The retriever/fusion selection carried by a query. Embedded by the
/// `QUERY_EXPLAIN` / `QUERY_TRACE` debug ops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryRequest {
    pub text: String,
    #[serde(with = "crate::wire::cbor::opt_byte_array16")]
    pub entity_anchor: Option<WireUuid>,
    pub kind_filter: Vec<u8>,
    pub predicate_filter: Vec<String>,
    pub time_filter: Option<TimeRangeWire>,
    pub as_of_record_time_unix_nanos: Option<u64>,
    pub confidence_min: Option<f32>,
    pub include_tombstoned: bool,
    pub include_superseded: bool,
    pub limit: u32,
    pub retrievers: RetrieverSelectionWire,
    pub fusion_config: Option<FusionConfigWire>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// MATERIALIZE_PROCEDURAL (`0x0164`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterializeProceduralRequest {
    #[serde(with = "serde_bytes")]
    pub space_id: WireUuid,
    pub session_filter: Option<Vec<WireSessionId>>,
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
// SPACE registry — SPACE_CREATE / SPACE_LIST / SPACE_DELETE.
// ===========================================================================

/// One space row in a [`SpaceListResponse`]. `space_id` is the
/// human-readable structured space string from the registry (a CBOR text
/// string), not the derived 16-byte storage id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceView {
    pub space_id: String,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u64,
    pub session_count: u32,
}

/// SPACE_CREATE (`0x0070`). Provisions the caller's effective space
/// explicitly; idempotent (a create for an existing space returns the
/// existing row with `created = false`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceCreateRequest {
    /// Opaque caller metadata blob (quota hints, labels). `None` for a bare
    /// provision (omitted on the wire).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub metadata: Option<Vec<u8>>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SPACE_CREATE_RESP (`0x00F0`). `space_id` is the human-readable structured
/// space string this create resolved to (a CBOR text string).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceCreateResponse {
    pub space_id: String,
    /// `false` on an idempotent replay of an existing space.
    pub created: bool,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u64,
    pub session_count: u32,
}

/// SPACE_LIST (`0x0071`). Lists the caller's namespace's spaces. `limit == 0`
/// means "no cap".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceListRequest {
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SPACE_LIST_RESP (`0x00F1`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceListResponse {
    pub spaces: Vec<SpaceView>,
    /// `true` when the listing covers every shard. v1 lists only the
    /// caller-shard's spaces, so this is `false` until cross-shard
    /// scatter-gather lands — treat `false` as "partial".
    pub cross_shard_complete: bool,
}

/// SPACE_DELETE (`0x0072`). GDPR erasure of the caller's effective space:
/// removes every row under `(namespace, space)`. Hard/immediate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceDeleteRequest {
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SPACE_DELETE_RESP (`0x00F2`). `space_id` is the human-readable structured
/// space string this delete targeted (a CBOR text string).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceDeleteResponse {
    pub space_id: String,
    /// `false` when the space had no registry row.
    pub existed: bool,
    /// Number of memories tombstoned by the cascade.
    pub memories_forgotten: u64,
}

// ===========================================================================
// SESSION registry — SESSION_CREATE / SESSION_LIST / SESSION_DELETE.
// ===========================================================================

/// One session row in a [`SessionListResponse`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionView {
    pub session_id: WireSessionId,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    pub memory_count: u32,
}

/// SESSION_CREATE (`0x0073`). Provisions a session under the caller's
/// effective space explicitly; idempotent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreateRequest {
    pub session_id: WireSessionId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SESSION_CREATE_RESP (`0x00F3`). `space_id` is the derived 16-byte storage
/// id (a CBOR byte string).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreateResponse {
    #[serde(with = "serde_bytes")]
    pub space_id: WireUuid,
    pub session_id: WireSessionId,
    /// `false` on an idempotent replay of an existing session.
    pub created: bool,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u32,
}

/// SESSION_LIST (`0x0074`). Lists one `(namespace, space)`'s sessions
/// newest-first. `limit == 0` means "no cap".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListRequest {
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SESSION_LIST_RESP (`0x00F4`). `space_id` is the derived 16-byte storage id
/// (a CBOR byte string).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListResponse {
    #[serde(with = "serde_bytes")]
    pub space_id: WireUuid,
    pub sessions: Vec<SessionView>,
}

/// SESSION_DELETE (`0x0075`). Removes a session's memories + graph rows.
/// Defaults to soft (7-day grace); `hard = true` zeroes immediately. The
/// default session (`session_id = 0`) is non-deletable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDeleteRequest {
    pub session_id: WireSessionId,
    /// `true` ⇒ hard tombstone (immediate); `false` (default) ⇒ soft.
    #[serde(default)]
    pub hard: bool,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// SESSION_DELETE_RESP (`0x00F5`). `space_id` is the derived 16-byte storage
/// id (a CBOR byte string).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDeleteResponse {
    #[serde(with = "serde_bytes")]
    pub space_id: WireUuid,
    pub session_id: WireSessionId,
    /// `false` when the session had no registry row.
    pub existed: bool,
    /// Number of memories tombstoned by the cascade.
    pub memories_forgotten: u64,
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

/// [`StagePayload::AutoEdge`] body: how many similarity edges the auto-edge
/// stage wrote for the source memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageAutoEdgePayload {
    pub edges_written: u32,
}

/// [`StagePayload::TemporalEdge`] body: how many temporal (followed-by) edges
/// the temporal-edge stage wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageTemporalEdgePayload {
    pub edges_written: u32,
}

/// [`StagePayload::Extractor`] body: the typed-graph rows the extractor stage
/// produced (entity / statement / relation counts) plus its audit verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageExtractorPayload {
    pub entity_count: u32,
    pub statement_count: u32,
    pub relation_count: u32,
    pub audit_status: StageAuditStatus,
    /// Populated only when `audit_status == Failed`; empty otherwise.
    pub error_message: String,
}

/// [`StagePayload::Hype`] body: hypothetical questions generated for the new
/// memory (write-time HyPE), embedded and inserted into the memory HNSW
/// index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageHypePayload {
    /// How many hypothetical questions were embedded, persisted, and
    /// inserted into the memory HNSW index.
    pub questions_written: u32,
    /// LLM micro-USD spent generating the questions (`0` on a cache hit).
    pub cost_micro_usd: u64,
}

/// Per-stage detail sidecar on `StageCompleted` events. Externally-tagged
/// enum (CBOR map keyed by the variant name), matching the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StagePayload {
    AutoEdge(StageAutoEdgePayload),
    TemporalEdge(StageTemporalEdgePayload),
    Extractor(StageExtractorPayload),
    Hype(StageHypePayload),
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
    pub session_filter: Option<Vec<WireSessionId>>,
    pub kinds: Option<Vec<MemoryKindWire>>,
    pub similar_to: Option<SimilarityFilter>,
    /// Subset of space ids whose events the subscriber wants. `None` or
    /// empty = all spaces on the shard.
    #[serde(with = "crate::wire::cbor::opt_vec_byte_array16")]
    pub spaces: Option<Vec<WireUuid>>,
    /// Subset of memory ids whose events the subscriber wants. `None` or
    /// empty = all memories. Lets a client scope a subscription to a single
    /// in-flight write (e.g. to watch that write's async derivation stages
    /// complete) without seeing unrelated traffic on a busy shard.
    pub memory_ids: Option<Vec<WireMemoryId>>,
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
    /// Effective identity this subscription runs as, on behalf of the
    /// authenticated connection principal. `None` (the common case, and
    /// omitted on the wire) means the op runs as the connection's own
    /// key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    pub session_id: WireSessionId,
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

/// [`GraphEventPayload::EntityCreated`] body: a new typed entity was created.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityCreatedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub entity_type_id: u32,
    pub canonical_name: String,
}

/// [`GraphEventPayload::EntityUpdated`] body: an entity's attributes changed;
/// `embedding_version_changed` flags whether its vector was re-embedded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityUpdatedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub entity_type_id: u32,
    pub canonical_name: String,
    pub embedding_version_changed: bool,
}

/// [`GraphEventPayload::EntityRenamed`] body: an entity's canonical name
/// changed; `old_moved_to_alias` says whether the old name was kept as an alias.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityRenamedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub old_canonical_name: String,
    pub new_canonical_name: String,
    pub old_moved_to_alias: bool,
}

/// [`GraphEventPayload::EntityMerged`] body: two entities were unified into
/// `survivor`; reports how many statements and relations were rerouted.
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

/// [`GraphEventPayload::EntityUnmerged`] body: a prior merge was reversed,
/// splitting `restored_entity_id` back out of `from_survivor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityUnmergedEvent {
    #[serde(with = "serde_bytes")]
    pub restored_entity_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub from_survivor: WireUuid,
    #[serde(with = "serde_bytes")]
    pub audit_id: WireUuid,
}

/// [`GraphEventPayload::EntityTombstoned`] body: an entity was soft-deleted, with
/// the operator-supplied reason.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    pub reason: String,
}

/// [`GraphEventPayload::StatementCreated`] body: a new typed statement was
/// asserted about `subject`.
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

/// [`GraphEventPayload::StatementSuperseded`] body: `new_statement_id` replaced
/// `old_statement_id`; `chain_root` identifies the supersession chain's origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementSupersededEvent {
    #[serde(with = "serde_bytes")]
    pub old_statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub new_statement_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub chain_root: WireUuid,
}

/// [`GraphEventPayload::StatementTombstoned`] body: a statement was soft-deleted,
/// with the operator-supplied reason.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatementTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    pub reason: String,
}

/// [`GraphEventPayload::RelationCreated`] body: a new typed relation was created
/// from `from` to `to`.
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

/// [`GraphEventPayload::RelationSuperseded`] body: `new_relation_id` replaced
/// `old_relation_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationSupersededEvent {
    #[serde(with = "serde_bytes")]
    pub old_relation_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub new_relation_id: WireUuid,
}

/// [`GraphEventPayload::RelationTombstoned`] body: a relation was soft-deleted,
/// with the operator-supplied reason.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTombstonedEvent {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    pub reason: String,
}

/// [`GraphEventPayload::SchemaUpdated`] body: a namespace's schema advanced from
/// `from_version` to `to_version` (via SCHEMA_UPLOAD or SCHEMA_REPLACE).
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
// EXTRACTOR_LIST.
// ===========================================================================

/// EXTRACTOR_LIST (`0x0124`). Empty request — extraction is always-on and
/// takes no arguments, so every registered extractor is returned. Kept as a
/// struct (not a unit type) so the encoding matches every other request body
/// (a CBOR map, here empty).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractorListRequest {}

/// One registered extractor row in [`ExtractorListResponseFrame`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractorListItem {
    pub extractor_id: u32,
    pub namespace: String,
    pub name: String,
    /// `0`=pattern, `1`=classifier, `2`=llm.
    pub kind: u8,
    pub schema_version: u32,
    pub created_at_unix_nanos: u64,
}

/// EXTRACTOR_LIST_RESP (`0x01A4`). Single-frame snapshot of the always-on
/// extractor registry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractorListResponseFrame {
    pub items: Vec<ExtractorListItem>,
    pub total: u32,
    pub is_final: bool,
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityGetRequest {
    #[serde(with = "serde_bytes")]
    pub entity_id: WireUuid,
    /// Effective identity this get runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity. Honored only when
    /// the connection principal holds the `ACT_AS` grant and the target
    /// namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Effective identity this list runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity. Honored only when
    /// the connection principal holds the `ACT_AS` grant and the target
    /// namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
// ENTITY_RESOLVE.
// ===========================================================================

/// ENTITY_RESOLVE (`0x0136`). Resolves a candidate name to an existing entity
/// (and optionally creates one). The server currently requires
/// `entity_type_hint != 0` and resolves by exact canonical name (tier 1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityResolveRequest {
    pub candidate_name: String,
    pub resolution_context: String,
    /// `0` = no hint; otherwise an entity type id.
    pub entity_type_hint: u32,
    pub allow_create: bool,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    /// Effective identity this resolve runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity. Honored
    /// only when the connection principal holds the `ACT_AS` grant and the
    /// target namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// Resolution outcome. Integer discriminant on the wire (`1`-based, mirroring
/// the server's `ResolutionOutcomeWire`).
#[derive(
    Clone, Copy, Debug, Eq, PartialEq, serde_repr::Serialize_repr, serde_repr::Deserialize_repr,
)]
#[repr(u8)]
pub enum ResolutionOutcomeWire {
    Resolved = 1,
    Created = 2,
    Ambiguous = 3,
    NotFound = 4,
}

/// ENTITY_RESOLVE_RESP (`0x01B6`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntityResolveResponse {
    pub outcome: ResolutionOutcomeWire,
    /// Which tier resolved (1..=5; 0 if unresolved).
    pub tier: u8,
    pub confidence: f32,
    /// Populated when `outcome == Resolved | Created` (single id);
    /// `[0; 16]` for `Ambiguous | NotFound`.
    #[serde(with = "serde_bytes")]
    pub resolved_entity: WireUuid,
    /// Populated when `outcome == Ambiguous`; ranked by score.
    #[serde(with = "crate::wire::cbor::vec_byte_array16")]
    pub candidate_ids: Vec<WireUuid>,
    /// `[0; 16]` unless an ambiguity audit was written.
    #[serde(with = "serde_bytes")]
    pub audit_id: WireUuid,
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementGetRequest {
    #[serde(with = "serde_bytes")]
    pub statement_id: WireUuid,
    /// If `true` and the row is superseded, the server returns the current
    /// statement in the chain (with `returned_via_supersession = true`).
    pub follow_supersession: bool,
    /// Effective identity this get runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity. Honored only when
    /// the connection principal holds the `ACT_AS` grant and the target
    /// namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Effective identity this list runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity. Honored only when
    /// the connection principal holds the `ACT_AS` grant and the target
    /// namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Effective identity this list runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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
    /// Effective identity this list runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
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

// ---------------------------------------------------------------------------
// Keepalive (PING / PONG / SERVER_PING / CLIENT_PONG).
//
// Field names are the CBOR map keys on the wire, so they must match the
// server's `brain-protocol` definitions byte-for-byte.
// ---------------------------------------------------------------------------

/// PING (`0x0010`, client→server) — RTT probe.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PingRequest {
    pub client_timestamp_unix_nanos: u64,
}

/// PONG (`0x0090`, server→client) — reply to PING, echoes the client's
/// timestamp and adds the server's so the client can measure RTT.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PongResponse {
    pub client_timestamp_unix_nanos: u64,
    pub server_timestamp_unix_nanos: u64,
}

/// SERVER_PING (`0x0091`, server→client) — the server's idle-timer
/// heartbeat. The client MUST answer with `CLIENT_PONG` or the server
/// closes the connection after its ping timeout.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServerPingResponse {
    pub server_timestamp_unix_nanos: u64,
}

/// CLIENT_PONG (`0x0011`, client→server) — reply to `SERVER_PING`,
/// echoing the server's timestamp plus the client's own.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClientPongRequest {
    pub server_timestamp_unix_nanos: u64,
    pub client_timestamp_unix_nanos: u64,
}

// ---------------------------------------------------------------------------
// Relation lifecycle + traversal — fetch one (get), revise (supersede), retire
// (tombstone), or walk the graph from an entity (traverse).
// ---------------------------------------------------------------------------

/// RELATION_GET (`0x0151`). `follow_supersession` returns the current head of a
/// superseded relation's chain rather than the (retired) id asked for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationGetRequest {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    pub follow_supersession: bool,
    /// Effective identity this get runs as. `None` (omitted on the wire) means
    /// the op runs as the connection's own key-bound identity.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// RELATION_GET_RESP (`0x01D1`). `returned_via_supersession` flags that the
/// view is the chain head, not the exact id requested.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationGetResponse {
    pub relation: RelationView,
    pub returned_via_supersession: bool,
}

/// RELATION_SUPERSEDE (`0x0152`). Revise a relation, keeping both on one chain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationSupersedeRequest {
    #[serde(with = "serde_bytes")]
    pub old_relation_id: WireUuid,
    pub new_relation: RelationCreateRequest,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// RELATION_SUPERSEDE_RESP (`0x01D2`). New id + monotonic version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationSupersedeResponse {
    #[serde(with = "serde_bytes")]
    pub new_relation_id: WireUuid,
    pub version: u32,
}

/// RELATION_TOMBSTONE (`0x0153`). Soft-retire a relation with a reason.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTombstoneRequest {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    pub reason: String,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
}

/// RELATION_TOMBSTONE_RESP (`0x01D3`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationTombstoneResponse {
    pub tombstoned_at_unix_nanos: u64,
}

/// One hop in a traversal path: the relation edge crossed and its endpoints.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraversalStepWire {
    #[serde(with = "serde_bytes")]
    pub relation_id: WireUuid,
    #[serde(with = "serde_bytes")]
    pub from: WireUuid,
    #[serde(with = "serde_bytes")]
    pub to: WireUuid,
    pub relation_type: String,
    pub depth: u32,
}

/// One path the traversal found, as an ordered list of steps.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraversalPathWire {
    pub steps: Vec<TraversalStepWire>,
}

/// RELATION_TRAVERSE (`0x0156`). Multi-hop walk of the relation graph from
/// `start_entity`. `direction` is outgoing/incoming/both; the bounds cap the
/// search; `time_at_unix_nanos` walks the graph as it stood at a record time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTraverseRequest {
    #[serde(with = "serde_bytes")]
    pub start_entity: WireUuid,
    pub relation_types: Vec<String>,
    pub direction: u8,
    pub max_depth: u32,
    pub max_nodes: u32,
    pub time_at_unix_nanos: u64,
    pub include_superseded: bool,
    #[serde(with = "serde_bytes")]
    pub request_id: WireUuid,
    /// Effective identity this traversal runs as. `None` (omitted on the wire)
    /// means the op runs as the connection's own key-bound identity. Honored
    /// only when the connection principal holds the `ACT_AS` grant and the
    /// target namespace is in its `may_act` allowlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub act_as: Option<ActAs>,
}

/// RELATION_TRAVERSE_RESP (`0x01D6`), one streamed frame. `is_final` marks the
/// last; `truncated` flags a bound was hit before the graph was exhausted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RelationTraverseResponseFrame {
    pub paths: Vec<TraversalPathWire>,
    pub total_paths: u32,
    pub truncated: bool,
    pub is_final: bool,
}

// ---------------------------------------------------------------------------
// Query introspection debug surface — the plan (explain) and execution trace.
// ---------------------------------------------------------------------------

/// QUERY_EXPLAIN (`0x0161`). Ask for the plan of a query without running it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryExplainRequest {
    pub query: QueryRequest,
}

/// QUERY_EXPLAIN_RESP (`0x01E1`). The plan plus an estimated cost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryExplainResponse {
    pub plan_text: String,
    pub estimated_cost_ms: f32,
}

/// QUERY_TRACE (`0x0162`). Run a query and return its per-stage execution trace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryTraceRequest {
    pub query: QueryRequest,
}

/// QUERY_TRACE_RESP (`0x01E2`). The trace plus total latency.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueryTraceResponse {
    pub trace_text: String,
    pub total_latency_ms: f64,
}
