//! The Brain HTTP contract — request/response types for [`super::BrainHttpClient`].
//!
//! Field names are the JSON wire names (snake_case, Rust's default), identical
//! across the Rust, Python, and TypeScript SDKs. Optional request fields skip
//! when `None`.

// The types below mirror the server's wire structs one-for-one: same names,
// same field names, same order. Their documentation is the protocol itself —
// `conformance/protocol.json` carries every field's type and serde attributes,
// and the corpus pins the bytes. A doc comment on each of ~2000 fields would
// restate the field name and nothing more, and the ones that DO carry meaning
// beyond their name (written below) would be lost in the noise.
#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

/// `skip_serializing_if` hands serde a reference whatever the field type, so
/// the `&bool` is required by the signature serde expects, not a choice.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(b: &bool) -> bool {
    !*b
}

/// `0` is the edge's "unset" for these, so an unset field is omitted rather
/// than sent as a zero the server then has to interpret.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u64(n: &u64) -> bool {
    *n == 0
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u32(n: &u32) -> bool {
    *n == 0
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u8(n: &u8) -> bool {
    *n == 0
}

// --- encode ----------------------------------------------------------------

/// `encode` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct EncodeInput {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<u64>,
}

/// `encode` result.
#[derive(Clone, Debug, Deserialize)]
pub struct EncodeResult {
    pub memory_id: String,
    pub was_deduplicated: bool,
    pub salience: f32,
    pub kind: u8,
    pub created_at_unix_nanos: u64,
    pub auto_edges_added: u32,
}

// --- recall ----------------------------------------------------------------

/// `recall` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct RecallInput {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// Return Brain's read-pipeline trace as [`RecallResult::trace`] — which
    /// retrievers ran, how they were fused, what the filter chain dropped,
    /// what the reranker moved. Several KB per call, so leave it off in hot
    /// paths and switch it on when chasing a bad answer. Served by the cloud
    /// gateway; a server without it ignores the field and returns no trace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_trace: Option<bool>,
}

/// One recalled memory.
#[derive(Clone, Debug, Deserialize)]
pub struct MemoryHit {
    pub memory_id: String,
    pub text: String,
    pub similarity_score: f32,
    pub confidence: f32,
    pub salience: f32,
    pub kind: u8,
    pub created_at_unix_nanos: u64,
}

/// `recall` result.
#[derive(Clone, Debug, Deserialize)]
pub struct RecallResult {
    pub answer_kind: String,
    pub memories: Vec<MemoryHit>,
    /// The read-pipeline trace as a JSON **string**, present only when
    /// `include_trace` was asked for and the server supports it. A string
    /// rather than a parsed value because its ids are 128-bit integers that a
    /// JSON number would round; parse it with a big-integer-safe reader.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
}

// --- forget ----------------------------------------------------------------

/// `forget` input.
#[derive(Clone, Debug, Serialize)]
pub struct ForgetInput {
    pub memory_id: String,
    #[serde(skip_serializing_if = "is_false")]
    pub hard: bool,
}

/// `forget` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ForgetResult {
    pub memory_id: String,
    pub was_already_forgotten: bool,
    pub edges_removed: u32,
}

// --- link / unlink ---------------------------------------------------------

/// `link` input.
#[derive(Clone, Debug, Serialize)]
pub struct LinkInput {
    pub source: String,
    pub target: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
}

/// `link` result.
#[derive(Clone, Debug, Deserialize)]
pub struct LinkResult {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub weight: f32,
    pub created_at_unix_nanos: u64,
    pub already_existed: bool,
}

/// `unlink` input.
#[derive(Clone, Debug, Serialize)]
pub struct UnlinkInput {
    pub source: String,
    pub target: String,
    pub kind: String,
}

/// `unlink` result.
#[derive(Clone, Debug, Deserialize)]
pub struct UnlinkResult {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub removed: bool,
}

// --- plan / reason ---------------------------------------------------------

/// A plan/reason endpoint: `text` or `memory_id`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Endpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
}

impl Endpoint {
    /// An endpoint from free text.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            memory_id: None,
        }
    }

    /// An endpoint from an existing memory id.
    #[must_use]
    pub fn memory(memory_id: impl Into<String>) -> Self {
        Self {
            text: None,
            memory_id: Some(memory_id.into()),
        }
    }
}

/// `plan` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PlanInput {
    pub start: Endpoint,
    pub goal: Endpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wall_time_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_branches: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
}

/// One planned step.
#[derive(Clone, Debug, Deserialize)]
pub struct PlanStep {
    pub step_index: u32,
    pub memory_id: String,
    pub text: String,
    pub transition_kind: String,
    pub confidence: f32,
    pub estimated_distance_to_goal: f32,
}

/// `plan` result.
#[derive(Clone, Debug, Deserialize)]
pub struct PlanResult {
    pub steps: Vec<PlanStep>,
}

/// `reason` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ReasonInput {
    pub observation: Endpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence_threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_inferences: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_wall_time_ms: Option<u32>,
}

/// One inference step.
#[derive(Clone, Debug, Deserialize)]
pub struct InferenceStep {
    pub step_index: u32,
    pub claim: String,
    pub supporting_memories: Vec<String>,
    pub contradicting_memories: Vec<String>,
    pub confidence: f32,
    pub inference_kind: String,
}

/// `reason` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ReasonResult {
    pub inferences: Vec<InferenceStep>,
}

// --- identity --------------------------------------------------------------

/// Resolved permission flags.
#[derive(Clone, Debug, Deserialize)]
pub struct Permissions {
    pub can_encode: bool,
    pub can_recall: bool,
    pub can_plan: bool,
    pub can_reason: bool,
    pub can_forget: bool,
    pub can_admin: bool,
}

/// `whoami` result.
#[derive(Clone, Debug, Deserialize)]
pub struct Whoami {
    pub namespace: String,
    pub space_id: String,
    pub permissions: Permissions,
}

/// `capabilities` result.
#[derive(Clone, Debug, Deserialize)]
pub struct Capabilities {
    pub rerank: bool,
    pub llm_extractor: bool,
    pub classifier_extractor: bool,
    pub pattern_extractor: bool,
    pub schema_namespaces: Vec<String>,
    pub vector_dim: u16,
}

// --- memories: list / inspect ----------------------------------------------
//
// Every query field below is an `Option` that skips when `None`, including the
// ones the edge declares as plain `bool`/`String` with a `#[serde(default)]`.
// An omitted query param is what asks for the edge's default; sending
// `include_tombstoned=false` and omitting it are the same thing today, but a
// field whose default is a *named function* (`only_current`,
// `follow_supersession` — both default to `true`) is not, and a client that
// cannot send `false` cannot ask those questions at all. One rule for all
// query fields is cheaper to hold than a per-field one.

/// `memory_list` query — a page of the space's memories.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MemoryListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_tombstoned: Option<bool>,
}

/// One memory in a `memory_list` page.
#[derive(Clone, Debug, Deserialize)]
pub struct MemoryListItem {
    pub memory_id: String,
    pub text: String,
    pub kind: u8,
    pub state: u8,
    pub created_at_unix_nanos: u64,
    pub occurred_at_unix_nanos: u64,
    pub last_accessed_at_unix_nanos: u64,
    pub salience: f32,
    pub access_count: u32,
    pub statement_count: u32,
    pub entity_count: u32,
    pub relation_count: u32,
}

/// `memory_list` result. `next_cursor` is absent on the last page.
#[derive(Clone, Debug, Deserialize)]
pub struct MemoryListPage {
    pub items: Vec<MemoryListItem>,
    pub next_cursor: Option<String>,
}

/// The durable metadata row an encode wrote.
#[derive(Clone, Debug, Deserialize)]
pub struct StageRecord {
    pub memory_id: String,
    pub kind: u8,
    pub salience: f32,
    pub created_at_unix_nanos: u64,
    pub occurred_at_unix_nanos: u64,
    pub vector_dim: u32,
    pub text_len: u32,
    pub lsn: u64,
}

/// One text-index field and the analyzed terms the write produced for it.
#[derive(Clone, Debug, Deserialize)]
pub struct StageKeywordField {
    pub field: String,
    pub terms: Vec<String>,
}

/// A node in the knowledge graph an encode produced.
#[derive(Clone, Debug, Deserialize)]
pub struct StageGraphNode {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub type_qname: String,
}

/// An edge in the knowledge graph an encode produced.
#[derive(Clone, Debug, Deserialize)]
pub struct StageGraphEdge {
    pub source: String,
    pub target: String,
    pub predicate: String,
    pub kind: String,
    pub confidence: f32,
    pub event_at_unix_nanos: Option<u64>,
}

/// The knowledge graph an encode produced.
#[derive(Clone, Debug, Deserialize)]
pub struct StageGraph {
    pub nodes: Vec<StageGraphNode>,
    pub edges: Vec<StageGraphEdge>,
}

/// Everything the encode pipeline produced for one memory.
#[derive(Clone, Debug, Deserialize)]
pub struct StageArtifact {
    pub vector: Vec<f32>,
    pub record: Option<StageRecord>,
    pub hype_questions: Vec<String>,
    pub keyword_fields: Vec<StageKeywordField>,
    pub graph: Option<StageGraph>,
}

/// `memory_inspect` result. `found == false` leaves the rest empty.
#[derive(Clone, Debug, Deserialize)]
pub struct MemoryInspect {
    pub found: bool,
    pub memory_id: String,
    pub text: String,
    pub artifact: StageArtifact,
}

// --- entities ---------------------------------------------------------------

/// `list_entities` query. Each field is a filter; omitting it applies none.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListEntitiesQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_count_min: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_tombstoned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_merged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Resume after the previous page (its `next_cursor`). Keep the other
    /// filters identical across pages — the cursor is bound to them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One entity, as the edge projects it.
#[derive(Clone, Debug, Deserialize)]
pub struct EntityDetail {
    pub entity_id: String,
    pub entity_type_id: u32,
    pub canonical_name: String,
    pub aliases: Vec<String>,
    pub mention_count: u32,
    pub created_at_unix_nanos: u64,
    pub updated_at_unix_nanos: u64,
    /// The surviving entity when this one was merged away; `None` otherwise.
    pub merged_into: Option<String>,
}

/// `list_entities` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListEntitiesResult {
    pub entities: Vec<EntityDetail>,
    pub count: usize,
    /// Present when more rows follow; pass it back as `cursor`. Served by the
    /// cloud gateway's keyset pagination; a server without it omits the field
    /// and the page is the whole result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `create_entity` input. `aliases` is omitted when empty.
#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateEntityInput {
    pub entity_type_id: u32,
    pub canonical_name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

/// `create_entity` result.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateEntityResult {
    pub entity_id: String,
}

/// `resolve_entity` input: a name to match against the typed graph.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ResolveEntityInput {
    pub candidate_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub resolution_context: String,
    /// Entity type id to prefer. The edge treats an absent hint as no hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_hint: Option<u32>,
    #[serde(skip_serializing_if = "is_false")]
    pub allow_create: bool,
}

/// `resolve_entity` result. `entity_id` is set when `outcome` resolved to one
/// entity; `candidate_ids` is the ranked list when it was ambiguous.
#[derive(Clone, Debug, Deserialize)]
pub struct ResolveEntityResult {
    pub outcome: String,
    pub tier: u8,
    pub confidence: f32,
    pub entity_id: Option<String>,
    pub candidate_ids: Vec<String>,
}

/// `traverse_relations` input: a multi-hop walk from one entity.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TraverseInput {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub direction: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub relation_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u32>,
    #[serde(skip_serializing_if = "is_false")]
    pub include_superseded: bool,
}

/// One hop of a traversal.
#[derive(Clone, Debug, Deserialize)]
pub struct TraversalStep {
    pub relation_id: String,
    pub from: String,
    pub to: String,
    pub relation_type: String,
    pub depth: u32,
    /// Display name of `from` (absent when it could not be resolved).
    ///
    /// The server resolves these so a caller does not have to.
    /// Without them every consumer re-queries each id just to print a name — which is the second call the field exists to remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// Display name of `to` (absent when it could not be resolved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_name: Option<String>,
}

/// One path the traversal found, as an ordered list of steps.
#[derive(Clone, Debug, Deserialize)]
pub struct TraversalPath {
    pub steps: Vec<TraversalStep>,
}

/// `traverse_relations` result. `truncated` means a bound cut the walk short.
#[derive(Clone, Debug, Deserialize)]
pub struct TraverseResult {
    pub paths: Vec<TraversalPath>,
    pub total_paths: u32,
    pub truncated: bool,
}

// --- relations --------------------------------------------------------------

/// `list_relations` query — the relations incident to one entity.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListRelationsQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// The relation type to filter on. Sent as `type`, which is the query
    /// parameter the edge reads (`relation_type` would be silently ignored).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub relation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_superseded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_tombstoned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Resume after the previous page (its `next_cursor`). Keep the other
    /// filters identical across pages — the cursor is bound to them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One relation, as the edge projects it.
#[derive(Clone, Debug, Deserialize)]
pub struct RelationDetail {
    pub relation_id: String,
    pub relation_type: String,
    pub from_entity: String,
    pub to_entity: String,
    pub confidence: f32,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    pub is_symmetric: bool,
    pub tombstoned: bool,
    /// Display name of `from_entity` (absent when it could not be resolved).
    ///
    /// The server resolves these so a caller does not have to.
    /// Without them every consumer re-queries each id just to print a name — which is the second call the field exists to remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    /// Display name of `to_entity` (absent when it could not be resolved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_name: Option<String>,
}

/// `list_relations` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListRelationsResult {
    pub relations: Vec<RelationDetail>,
    pub count: usize,
    /// Present when more rows follow; pass it back as `cursor`. Served by the
    /// cloud gateway's keyset pagination; a server without it omits the field
    /// and the page is the whole result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `get_relation` query. `follow_supersession` defaults to `true` on the edge:
/// leave it `None` to follow the chain, or send `Some(false)` for this exact
/// row.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GetRelationQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_supersession: Option<bool>,
}

// --- statements -------------------------------------------------------------

/// `list_statements` query. `only_current` defaults to `true` on the edge —
/// send `Some(false)` to see superseded rows.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListStatementsQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub only_current: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_tombstoned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Resume after the previous page (its `next_cursor`). Keep the other
    /// filters identical across pages — the cursor is bound to them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Deserialize an `f64` by way of `serde_json::Number`.
///
/// A number inside an internally tagged enum is buffered by serde before the
/// variant is known, and `serde_json`'s `arbitrary_precision` feature renders a
/// buffered float as a map — at which point a plain `f64` field fails with
/// "invalid type: map, expected f64". Whether that feature is on is decided by
/// whoever else is in the dependency graph (this crate's own test profile turns
/// it on), so the SDK does not get to assume it is off. `Number` accepts both
/// renderings, and the float is the only number this enum buffers.
fn de_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let number = serde_json::Number::deserialize(deserializer)?;
    number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom(format!("{number} is not an f64")))
}

/// A literal on the object side of a statement. Internally tagged by `type`,
/// with snake_case tag values: `{"type": "text", "value": "…"}`.
///
/// `Serialize` too, since `create_statement` takes the same shape a read
/// returns — one representation, not two that can drift apart.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StatementValue {
    Text {
        value: String,
    },
    Integer {
        value: i64,
    },
    Float {
        #[serde(deserialize_with = "de_f64")]
        value: f64,
    },
    Bool {
        value: bool,
    },
    UnixNanos {
        value: u64,
    },
    Blob {
        value: Vec<u8>,
    },
}

/// What a statement points at. Internally tagged by `kind`, with snake_case tag
/// values: `{"kind": "entity", "id": "…"}`, `{"kind": "value", "value": {…}}`.
///
/// A MEMORY id is a 128-bit decimal string, the form every memory id in this
/// contract takes — not a UUID. `Serialize` too; see [`StatementValue`].
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatementObject {
    Entity { id: String },
    Value { value: StatementValue },
    Memory { id: String },
    Statement { id: String },
}

/// One statement, as the edge projects it.
#[derive(Clone, Debug, Deserialize)]
pub struct StatementDetail {
    pub statement_id: String,
    /// The statement's own kind (`Fact`, `Preference`, `Event`) — not the
    /// `kind` tag inside [`StatementObject`], which discriminates the object.
    pub kind: String,
    pub subject: String,
    pub predicate: String,
    pub object: StatementObject,
    pub confidence: f32,
    pub event_at_unix_nanos: u64,
    pub valid_from_unix_nanos: u64,
    pub valid_to_unix_nanos: u64,
    pub tombstoned: bool,
    /// Display name of `subject` (absent when it could not be resolved).
    ///
    /// The server resolves these so a caller does not have to.
    /// Without them every consumer re-queries each id just to print a name — which is the second call the field exists to remove.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_name: Option<String>,
    /// Display name of an entity object (absent for values / unresolved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_name: Option<String>,
}

/// `list_statements` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListStatementsResult {
    pub statements: Vec<StatementDetail>,
    pub count: usize,
    /// Present when more rows follow; pass it back as `cursor`. Served by the
    /// cloud gateway's keyset pagination; a server without it omits the field
    /// and the page is the whole result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// `get_statement` query. Same defaulting as [`GetRelationQuery`]: absent means
/// the edge's `true`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GetStatementQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_supersession: Option<bool>,
}

// --- graph ------------------------------------------------------------------

/// `graph_fetch` query — one page of the space's typed graph.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GraphFetchQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_statements: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_memories: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_memory_edges: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_tombstoned: Option<bool>,
}

/// One node of the typed graph.
#[derive(Clone, Debug, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub type_qname: String,
}

/// One edge of the typed graph.
#[derive(Clone, Debug, Deserialize)]
pub struct GraphEdge {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub label: String,
}

/// `graph_fetch` result. `next_cursor` is absent on the last page.
#[derive(Clone, Debug, Deserialize)]
pub struct GraphPage {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub next_cursor: Option<String>,
}

// --- schema -----------------------------------------------------------------

/// `get_schema` query. Absent `namespace` means the caller's own; absent
/// `version` means the active one.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SchemaGetQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
}

/// `get_schema` result.
#[derive(Clone, Debug, Deserialize)]
pub struct Schema {
    pub namespace: String,
    pub schema_version: u32,
    pub schema_document: String,
    pub uploaded_at_unix_nanos: u64,
    pub validator_version: u32,
}

/// One schema validation diagnostic, positioned in the document.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemaError {
    pub code: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub severity: u8,
}

/// `upload_schema` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SchemaUploadInput {
    pub schema_document: String,
    #[serde(skip_serializing_if = "is_false")]
    pub dry_run: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub allow_breaking: bool,
}

/// `upload_schema` result. A non-empty `validation_errors` means nothing landed.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemaUploadResult {
    pub namespace: String,
    pub schema_version: u32,
    pub backward_compatible: bool,
    pub validation_errors: Vec<SchemaError>,
}

/// `validate_schema` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SchemaValidateInput {
    pub schema_document: String,
}

/// `validate_schema` result. `would_be_version` is what an upload would produce.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemaValidateResult {
    pub namespace: String,
    pub would_be_version: u32,
    pub validation_errors: Vec<SchemaError>,
}

/// `replace_schema` input.
///
/// Deliberately not `Default`: `force_drop_existing` is a confirmation for an
/// irreversible operation, not a mode switch, and the manifest gives it no
/// serde default — the edge always reads it off the wire. Deriving `Default`
/// would let `..Default::default()` fill in the confirmation silently.
#[derive(Clone, Debug, Serialize)]
pub struct SchemaReplaceInput {
    pub schema_document: String,
    /// Must be `true`; the edge rejects the request otherwise.
    pub force_drop_existing: bool,
}

/// `replace_schema` result. `dropped_count` is how many declared rows the swap
/// removed.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemaReplaceResult {
    pub namespace: String,
    pub schema_version: u32,
    pub dropped_count: u32,
    pub validation_errors: Vec<SchemaError>,
}

#[cfg(test)]
mod recall_trace_tests {
    use super::{RecallInput, RecallResult};

    /// The trace is several KB per call, so the field is opt-in AND absent
    /// from the body when it is not asked for — a hot path's request is
    /// byte-identical to what it was before the field existed.
    #[test]
    fn include_trace_is_omitted_unless_set() {
        let body = serde_json::to_string(&RecallInput {
            query: "x".into(),
            max_results: Some(5),
            ..Default::default()
        })
        .expect("serialize");
        assert!(!body.contains("include_trace"), "{body}");
    }

    #[test]
    fn include_trace_is_sent_when_set() {
        let body = serde_json::to_string(&RecallInput {
            query: "x".into(),
            include_trace: Some(true),
            ..Default::default()
        })
        .expect("serialize");
        assert!(body.contains(r#""include_trace":true"#), "{body}");
    }

    /// Parity with the TypeScript client, which carried `includeTrace` while
    /// this one did not. The trace arrives as a JSON STRING — its ids are
    /// 128-bit and a JSON number would round them — so it is handed over
    /// unparsed.
    #[test]
    fn trace_round_trips_as_an_opaque_string() {
        let r: RecallResult = serde_json::from_str(
            r#"{"answer_kind":"single","memories":[],"trace":"{\"stages\":[]}"}"#,
        )
        .expect("deserialize");
        assert_eq!(r.trace.as_deref(), Some(r#"{"stages":[]}"#));
    }

    /// A server without the flag returns no trace at all. That is not an
    /// error, and it must not fail deserialization.
    #[test]
    fn a_missing_trace_is_none_not_an_error() {
        let r: RecallResult =
            serde_json::from_str(r#"{"answer_kind":"none","memories":[]}"#).expect("deserialize");
        assert!(r.trace.is_none());
    }
}

// --- space lifecycle -------------------------------------------------------
//
// All three act on the CALLER's effective space: Brain resolves it from the
// credential and never takes it from the request, so none of these name one.

/// `create_space` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateSpaceInput {
    /// Opaque caller metadata. Write-only: no op returns it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// `create_space` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SpaceProvision {
    pub space_id: String,
    /// Whether THIS call created it. The op is idempotent, so the rest of the
    /// body is identical either way and this is the only thing that tells
    /// "made it" from "it was already there".
    pub created: bool,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u64,
    pub session_count: u32,
}

/// `list_spaces` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListSpacesQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One row of a space listing.
#[derive(Clone, Debug, Deserialize)]
pub struct SpaceSummary {
    pub space_id: String,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u64,
    pub session_count: u32,
}

/// `list_spaces` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListSpacesResult {
    pub spaces: Vec<SpaceSummary>,
    /// `false` when the listing covered only the caller's shard. Treat a
    /// `false` as partial: concluding a space is gone from an incomplete
    /// listing is the failure this field exists to prevent.
    pub cross_shard_complete: bool,
}

/// `delete_space` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SpaceErased {
    pub space_id: String,
    /// `false` when there was no registry row — already erased, or never
    /// written to.
    pub existed: bool,
    pub memories_forgotten: u64,
}

// --- session lifecycle -----------------------------------------------------

/// `create_session` input. The id is client-chosen so a caller's own
/// conversation id can BE the session id rather than needing a mapping.
#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateSessionInput {
    pub session_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// `create_session` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SessionProvision {
    pub space_id: String,
    pub session_id: u64,
    /// Whether THIS call created it; the op is idempotent.
    pub created: bool,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub memory_count: u32,
}

/// `list_sessions` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListSessionsQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One row of a session listing.
#[derive(Clone, Debug, Deserialize)]
pub struct SessionSummary {
    pub session_id: u64,
    pub created_at_unix_nanos: u64,
    pub last_active_unix_nanos: u64,
    pub title: Option<String>,
    pub memory_count: u32,
}

/// `list_sessions` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListSessionsResult {
    pub space_id: String,
    pub sessions: Vec<SessionSummary>,
}

/// `delete_session` query. Soft unless `hard` is asked for by name.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DeleteSessionQuery {
    #[serde(skip_serializing_if = "is_false")]
    pub hard: bool,
}

/// `delete_session` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SessionErased {
    pub space_id: String,
    pub session_id: u64,
    pub existed: bool,
    pub memories_forgotten: u64,
}

// --- entity authoring ------------------------------------------------------

/// `update_entity` input — a WHOLESALE replace, matching the edge's `PUT`.
///
/// An omitted `aliases` or `attributes` CLEARS it. `get_entity` returns both,
/// so a read-modify-write round-trips.
#[derive(Clone, Debug, Default, Serialize)]
pub struct UpdateEntityInput {
    pub canonical_name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// The complete attribute blob, lowercase hex.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<String>,
}

/// `rename_entity` input.
#[derive(Clone, Debug, Serialize)]
pub struct RenameEntityInput {
    pub new_canonical_name: String,
    /// Keep the old canonical name as an alias. Defaults to `true`: a name an
    /// entity was known by is how a later mention still resolves to it.
    pub move_to_alias: bool,
}

impl Default for RenameEntityInput {
    fn default() -> Self {
        Self {
            new_canonical_name: String::new(),
            move_to_alias: true,
        }
    }
}

/// `merge_entities` input. The entity named in the call is the SURVIVOR.
#[derive(Clone, Debug, Serialize)]
pub struct MergeEntitiesInput {
    /// The entity to fold into the survivor.
    pub merged: String,
    pub confidence: f32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

impl Default for MergeEntitiesInput {
    fn default() -> Self {
        Self {
            merged: String::new(),
            confidence: 1.0,
            reason: String::new(),
        }
    }
}

/// `merge_entities` result.
#[derive(Clone, Debug, Deserialize)]
pub struct MergeEntitiesResult {
    pub audit_id: String,
    /// How long the merge stays reversible.
    pub grace_period_seconds: u64,
}

/// `unmerge_entity` result.
#[derive(Clone, Debug, Deserialize)]
pub struct UnmergeEntityResult {
    pub restored_entity_id: String,
}

/// `tombstone_entity` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TombstoneEntityQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `tombstone_entity` result.
#[derive(Clone, Debug, Deserialize)]
pub struct TombstoneResult {
    pub tombstoned_at_unix_nanos: u64,
}

// --- statement authoring ---------------------------------------------------

/// `create_statement` input.
///
/// `event_at` is when the thing HAPPENED; `valid_from`/`valid_to` are when the
/// claim is held to be true. A meeting that happened Monday and is believed
/// from Tuesday has different values for the two.
#[derive(Clone, Debug, Serialize)]
pub struct CreateStatementInput {
    /// `fact` | `preference` | `event` | `attribute` | `relation` | `directive`.
    pub kind: String,
    pub subject: String,
    pub predicate: String,
    pub object: StatementObject,
    pub confidence: f32,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub event_at_unix_nanos: u64,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub valid_from_unix_nanos: u64,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub valid_to_unix_nanos: u64,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub extractor_id: u32,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub schema_version: u32,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub session_id: u64,
    /// Memory ids this claim rests on (128-bit decimal strings).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
}

impl Default for CreateStatementInput {
    fn default() -> Self {
        Self {
            kind: "fact".to_string(),
            subject: String::new(),
            predicate: String::new(),
            object: StatementObject::Value {
                value: StatementValue::Bool { value: true },
            },
            confidence: 1.0,
            event_at_unix_nanos: 0,
            valid_from_unix_nanos: 0,
            valid_to_unix_nanos: 0,
            extractor_id: 0,
            schema_version: 0,
            session_id: 0,
            evidence: Vec::new(),
        }
    }
}

/// `create_statement` result.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateStatementResult {
    pub statement_id: String,
    /// A statement this one automatically superseded, when Brain recognised it
    /// as a revision of an existing claim.
    pub auto_superseded: Option<String>,
    /// The chain this claim belongs to — its stable identity across revisions.
    pub chain_root: String,
}

/// `supersede_statement` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SupersedeStatementResult {
    pub new_statement_id: String,
    pub chain_root: String,
    pub version: u32,
}

/// `tombstone_statement` / `retract_statement` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct RetireStatementQuery {
    #[serde(skip_serializing_if = "is_zero_u8")]
    pub reason: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `retract_statement` result.
///
/// A retraction is stronger than a tombstone: the content itself is scheduled
/// to be zeroed, and `will_zero_at_unix_nanos` says when.
#[derive(Clone, Debug, Deserialize)]
pub struct RetractStatementResult {
    pub retracted_at_unix_nanos: u64,
    pub will_zero_at_unix_nanos: u64,
}

/// `statement_history` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct StatementHistoryQuery {
    #[serde(skip_serializing_if = "is_false")]
    pub include_tombstoned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// `statement_history` result — every version of one claim, oldest first.
#[derive(Clone, Debug, Deserialize)]
pub struct StatementHistoryResult {
    pub items: Vec<StatementDetail>,
    pub chain_root: String,
    pub total_versions: u32,
    pub next_cursor: Option<String>,
}

// --- relation authoring ----------------------------------------------------

/// `create_relation` input.
#[derive(Clone, Debug, Serialize)]
pub struct CreateRelationInput {
    pub relation_type: String,
    pub from_entity: String,
    pub to_entity: String,
    pub confidence: f32,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub valid_from_unix_nanos: u64,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub valid_to_unix_nanos: u64,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub extractor_id: u32,
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub session_id: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    /// An opaque property blob, lowercase hex. A supersede REPLACES it, which
    /// is why `get_relation` returns it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<String>,
}

impl Default for CreateRelationInput {
    fn default() -> Self {
        Self {
            relation_type: String::new(),
            from_entity: String::new(),
            to_entity: String::new(),
            confidence: 1.0,
            valid_from_unix_nanos: 0,
            valid_to_unix_nanos: 0,
            extractor_id: 0,
            session_id: 0,
            evidence: Vec::new(),
            properties: None,
        }
    }
}

/// `create_relation` result.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateRelationResult {
    pub relation_id: String,
}

/// `supersede_relation` result.
#[derive(Clone, Debug, Deserialize)]
pub struct SupersedeRelationResult {
    pub new_relation_id: String,
    pub version: u32,
}

/// `tombstone_relation` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TombstoneRelationQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// --- schema introspection + drop -------------------------------------------

/// `list_schemas` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ListSchemasQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One schema version.
#[derive(Clone, Debug, Deserialize)]
pub struct SchemaVersion {
    pub schema_version: u32,
    pub uploaded_at_unix_nanos: u64,
    /// Which validator accepted it — a document an older validator passed is
    /// not necessarily one the current validator would.
    pub validator_version: u32,
    pub has_source_text: bool,
}

/// `list_schemas` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListSchemasResult {
    pub namespace: String,
    pub items: Vec<SchemaVersion>,
    pub total: u32,
    pub next_cursor: Option<String>,
}

/// One registered extractor.
#[derive(Clone, Debug, Deserialize)]
pub struct Extractor {
    /// The id statements carry as `extractor_id`.
    pub extractor_id: u32,
    pub namespace: String,
    pub name: String,
    /// `0` = pattern, `1` = classifier, `2` = llm.
    pub kind: u8,
    pub schema_version: u32,
    pub created_at_unix_nanos: u64,
}

/// `list_extractors` result. Read-only: extraction is always-on.
#[derive(Clone, Debug, Deserialize)]
pub struct ListExtractorsResult {
    pub items: Vec<Extractor>,
    pub total: u32,
}

/// `drop_schema` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct DropSchemaQuery {
    /// Consent to orphan live rows — they survive as plain memories no longer
    /// enriched from the typed-graph tables. A type nothing uses drops
    /// without it, so this is not a generic "yes I'm sure".
    #[serde(skip_serializing_if = "is_false")]
    pub force: bool,
}

/// `drop_schema` result.
#[derive(Clone, Debug, Deserialize)]
pub struct DropSchemaResult {
    pub namespace: String,
    /// The new active version, or `0` when nothing was dropped.
    pub schema_version: u32,
    pub target_kind: u8,
    pub target_name: String,
    /// `false` with `live_rows > 0` means the type is still in use and
    /// `force` was not set — nothing changed.
    pub dropped: bool,
    pub live_rows: u32,
    pub validation_errors: Vec<SchemaError>,
}

// --- memory extras ---------------------------------------------------------

/// `encode_vector` input — a memory whose embedding the caller computed.
///
/// `model_fingerprint` is required because vectors from different models are
/// not comparable: a recall that mixed them would rank nonsense confidently.
#[derive(Clone, Debug, Default, Serialize)]
pub struct EncodeVectorInput {
    pub text: String,
    pub vector: Vec<f32>,
    /// 16 bytes as lowercase hex (32 characters).
    pub model_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salience_hint: Option<f32>,
    #[serde(skip_serializing_if = "is_false")]
    pub deduplicate: bool,
}

/// `materialize_procedural` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MaterializeProceduralInput {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<u64>,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub top_k: u32,
    pub min_confidence: f32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
}

/// `materialize_procedural` result — directives rendered for a system prompt.
#[derive(Clone, Debug, Deserialize)]
pub struct MaterializeProceduralResult {
    pub system_block: String,
    /// The statements it was rendered from, so a caller can show its work.
    pub statement_ids: Vec<String>,
    pub total_candidates: u32,
    /// Whether the block was cut short by the token budget. `true` means some
    /// directives did not make it in — do not read the block as complete.
    pub trimmed_by_budget: bool,
}

// --- query introspection ---------------------------------------------------

/// Per-query fusion weights.
#[derive(Clone, Debug, Default, Serialize)]
pub struct FusionConfig {
    pub k: u32,
    pub semantic_weight: f32,
    pub lexical_weight: f32,
    pub graph_weight: f32,
}

/// A bi-temporal window. Milliseconds, matching the edge.
#[derive(Clone, Debug, Default, Serialize)]
pub struct TimeRange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_unix_ms: Option<u64>,
}

/// `query_explain` / `query_trace` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct QueryInput {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_anchor: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub predicates: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_range: Option<TimeRange>,
    /// Read the graph as it was BELIEVED at this record time — a different
    /// axis from `time_range`, which is when the content was true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_of_record_time_unix_nanos: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence_min: Option<f32>,
    #[serde(skip_serializing_if = "is_false")]
    pub include_tombstoned: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub include_superseded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// `auto`, or a pinned list of `semantic` / `lexical` / `graph`. Pinning
    /// is what makes an explain answer "what would THIS plan cost" rather than
    /// "what would the router pick today".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub retrievers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fusion: Option<FusionConfig>,
}

/// `query_explain` result. An estimate — nothing ran.
#[derive(Clone, Debug, Deserialize)]
pub struct QueryExplainResult {
    pub plan_text: String,
    pub estimated_cost_ms: f32,
}

/// `query_trace` result. A measurement — the query RAN.
#[derive(Clone, Debug, Deserialize)]
pub struct QueryTraceResult {
    pub trace_text: String,
    pub total_latency_ms: f64,
}

// --- BYOK provider credentials ---------------------------------------------

/// `put_llm_credential` input.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PutLlmCredentialInput {
    /// `openai` | `anthropic`.
    pub provider: String,
    pub model: String,
    /// The provider key. Sealed by the edge on arrival; never returned.
    pub api_key: String,
}

/// An installed provider credential. Carries no key material.
#[derive(Clone, Debug, Deserialize)]
pub struct LlmCredential {
    pub provider: String,
    pub model: String,
    /// Display-safe tail so an operator can tell which key is installed. Not
    /// reversible into the key.
    pub fingerprint: String,
    pub created_at_unix_secs: u64,
}

/// `delete_llm_credential` result.
#[derive(Clone, Debug, Deserialize)]
pub struct LlmCredentialDeleted {
    /// `false` when there was nothing to remove — which matters when the call
    /// is part of an incident response.
    pub deleted: bool,
}

/// What a provider said about a key.
///
/// Three outcomes, not a boolean: "the provider rejected this key" and "I
/// could not reach the provider" demand opposite responses. On `unreachable`,
/// `valid` is `None` — the probe learned nothing about the key.
#[derive(Clone, Debug, Deserialize)]
pub struct LlmCredentialCheck {
    /// `valid` | `rejected` | `unreachable`.
    pub status: String,
    pub valid: Option<bool>,
    pub reason: Option<String>,
    pub provider: String,
}

// --- change feed (SSE) -----------------------------------------------------

/// The typed-graph detail on a change event, tagged by `type`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphEvent {
    EntityCreated {
        entity_id: String,
        entity_type_id: u32,
        canonical_name: String,
    },
    EntityUpdated {
        entity_id: String,
        entity_type_id: u32,
        canonical_name: String,
        embedding_version_changed: bool,
    },
    EntityRenamed {
        entity_id: String,
        old_canonical_name: String,
        new_canonical_name: String,
        old_moved_to_alias: bool,
    },
    EntityMerged {
        survivor: String,
        merged: String,
        audit_id: String,
        confidence: f32,
        statements_rerouted: u32,
        relations_rerouted: u32,
    },
    EntityUnmerged {
        restored_entity_id: String,
        from_survivor: String,
        audit_id: String,
    },
    EntityTombstoned {
        entity_id: String,
        reason: String,
    },
    StatementCreated {
        statement_id: String,
        kind: u8,
        subject: String,
        predicate: String,
        confidence: f32,
    },
    StatementSuperseded {
        old_statement_id: String,
        new_statement_id: String,
        chain_root: String,
    },
    StatementTombstoned {
        statement_id: String,
        reason: String,
    },
    RelationCreated {
        relation_id: String,
        relation_type: String,
        from: String,
        to: String,
    },
    RelationSuperseded {
        old_relation_id: String,
        new_relation_id: String,
    },
    RelationTombstoned {
        relation_id: String,
        reason: String,
    },
    SchemaUpdated {
        namespace: String,
        from_version: u32,
        to_version: u32,
        backward_compatible: bool,
    },
}

/// A memory-graph edge event.
#[derive(Clone, Debug, Deserialize)]
pub struct EdgeEvent {
    pub from_kind: u8,
    pub from_id: String,
    pub to_kind: u8,
    pub to_id: String,
    pub edge_kind_tag: u8,
    pub edge_kind_byte: u8,
    pub relation_type_id: Option<u32>,
    pub weight: f32,
    pub relation_id: Option<String>,
    pub superseded_relation_id: Option<String>,
    pub origin: u8,
}

/// What a write-pipeline stage produced, tagged by `type`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StageEvent {
    AutoEdge {
        edges_written: u32,
    },
    TemporalEdge {
        edges_written: u32,
    },
    Extractor {
        entity_count: u32,
        statement_count: u32,
        relation_count: u32,
        error_message: String,
    },
    Hype {
        questions_written: u32,
        cost_micro_usd: u64,
    },
}

/// One change-feed event.
#[derive(Clone, Debug, Deserialize)]
pub struct SubscriptionEvent {
    pub event_type: String,
    /// A 128-bit decimal string.
    pub memory_id: String,
    pub session_id: u64,
    pub text: String,
    pub kind: u8,
    pub salience: f32,
    pub timestamp_unix_nanos: u64,
    /// The feed position. Pass the last one back as
    /// [`SubscribeQuery::from_lsn`] to resume exactly.
    pub lsn: u64,
    pub graph: Option<GraphEvent>,
    pub edge: Option<EdgeEvent>,
    pub stage_kind: Option<String>,
    pub stage_outcome: Option<String>,
    pub stage: Option<StageEvent>,
}

/// The terminal event, sent once when the feed closes.
#[derive(Clone, Debug, Deserialize)]
pub struct SubscriptionClosed {
    /// Where the feed got to. Hand it back as `from_lsn` to resume.
    pub final_lsn: u64,
    /// `unsubscribed` | `ended` | `error`.
    pub reason: String,
}

/// `subscribe` query.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SubscribeQuery {
    /// Comma-separated session ids.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<String>,
    /// Comma-separated kinds, by name or byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<String>,
    /// Comma-separated memory ids (decimal).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memories: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub include_history: bool,
    /// Resume after this feed position.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_lsn: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_inflight: Option<u32>,
}
