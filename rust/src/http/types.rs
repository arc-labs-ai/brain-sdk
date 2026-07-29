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
}

/// `list_relations` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListRelationsResult {
    pub relations: Vec<RelationDetail>,
    pub count: usize,
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
#[derive(Clone, Debug, Deserialize)]
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
#[derive(Clone, Debug, Deserialize)]
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
}

/// `list_statements` result.
#[derive(Clone, Debug, Deserialize)]
pub struct ListStatementsResult {
    pub statements: Vec<StatementDetail>,
    pub count: usize,
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
