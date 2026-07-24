//! The Brain HTTP contract — request/response types for [`super::BrainHttpClient`].
//!
//! Field names are the JSON wire names (snake_case, Rust's default), identical
//! across the Rust, Python, and TypeScript SDKs. Optional request fields skip
//! when `None`.

use serde::{Deserialize, Serialize};

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
