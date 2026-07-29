//! The HTTP tier of the Brain SDK — [`BrainHttpClient`] + its contract types.
//!
//! Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
//! gateway). The native wire client is [`crate::BrainClient`]. The method names,
//! request fields, response fields, and error shape match the Python and
//! TypeScript SDKs exactly.

pub mod client;
pub mod error;
pub mod retry;
pub mod types;

pub use client::{BrainHttpClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT};
pub use error::BrainHttpError;
pub use retry::HttpRetryPolicy;
pub use types::{
    Capabilities, CreateEntityInput, CreateEntityResult, EncodeInput, EncodeResult, Endpoint,
    EntityDetail, ForgetInput, ForgetResult, GetRelationQuery, GetStatementQuery, GraphEdge,
    GraphFetchQuery, GraphNode, GraphPage, InferenceStep, LinkInput, LinkResult, ListEntitiesQuery,
    ListEntitiesResult, ListRelationsQuery, ListRelationsResult, ListStatementsQuery,
    ListStatementsResult, MemoryHit, MemoryInspect, MemoryListItem, MemoryListPage,
    MemoryListQuery, Permissions, PlanInput, PlanResult, PlanStep, ReasonInput, ReasonResult,
    RecallInput, RecallResult, RelationDetail, ResolveEntityInput, ResolveEntityResult, Schema,
    SchemaError, SchemaGetQuery, SchemaReplaceInput, SchemaReplaceResult, SchemaUploadInput,
    SchemaUploadResult, SchemaValidateInput, SchemaValidateResult, StageArtifact, StageGraph,
    StageGraphEdge, StageGraphNode, StageKeywordField, StageRecord, StatementDetail,
    StatementObject, StatementValue, TraversalPath, TraversalStep, TraverseInput, TraverseResult,
    UnlinkInput, UnlinkResult, Whoami,
};
