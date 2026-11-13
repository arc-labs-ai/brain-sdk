//! The HTTP tier of the Brain SDK — [`BrainHttpClient`] + its contract types.
//!
//! Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
//! gateway). The native wire client is [`crate::BrainClient`]. The method names,
//! request fields, response fields, and error shape match the Python and
//! TypeScript SDKs exactly.

pub mod client;
pub mod error;
pub mod retry;
pub mod sse;
pub mod types;

pub use client::{BrainHttpClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT};
pub use error::{BrainHttpError, FieldError};
pub use retry::HttpRetryPolicy;
pub use types::{
    Capabilities, CreateEntityInput, CreateEntityResult, CreateRelationInput, CreateRelationResult,
    CreateSessionInput, CreateSpaceInput, CreateStatementInput, CreateStatementResult,
    DeleteSessionQuery, DropSchemaQuery, DropSchemaResult, EdgeEvent, EncodeInput, EncodeResult,
    EncodeVectorInput, Endpoint, EntityDetail, EntityType, Extractor, ForgetInput, ForgetResult,
    FusionConfig, GetRelationQuery, GetStatementQuery, GraphEdge, GraphEvent, GraphFetchQuery,
    GraphNode, GraphPage, InferenceStep, LinkInput, LinkResult, ListEntitiesQuery,
    ListEntitiesResult, ListEntityTypesResult, ListExtractorsResult, ListRelationsQuery,
    ListRelationsResult, ListSchemasQuery, ListSchemasResult, ListSessionsQuery,
    ListSessionsResult, ListSpacesQuery, ListSpacesResult, ListStatementsQuery,
    ListStatementsResult, LlmCredential, LlmCredentialCheck, LlmCredentialDeleted,
    MaterializeProceduralInput, MaterializeProceduralResult, MemoryEdge, MemoryHit, MemoryInspect,
    MemoryListItem, MemoryListPage, MemoryListQuery, MergeEntitiesInput, MergeEntitiesResult,
    Permissions, PlanInput, PlanResult, PlanStep, PutLlmCredentialInput, QueryExplainResult,
    QueryInput, QueryTraceResult, ReasonInput, ReasonResult, RecallGraph, RecallInput,
    RecallResult, RelationDetail, RenameEntityInput, ResolveEntityInput, ResolveEntityResult,
    RetireStatementQuery, RetractStatementResult, Schema, SchemaError, SchemaGetQuery,
    SchemaReplaceInput, SchemaReplaceResult, SchemaUploadInput, SchemaUploadResult,
    SchemaValidateInput, SchemaValidateResult, SchemaVersion, SessionErased, SessionProvision,
    SessionSummary, SpaceErased, SpaceProvision, SpaceSummary, StageArtifact, StageEvent,
    StageGraph, StageGraphEdge, StageGraphNode, StageKeywordField, StageRecord, StatementDetail,
    StatementHistoryQuery, StatementHistoryResult, StatementObject, StatementValue, SubscribeQuery,
    SubscriptionClosed, SubscriptionEvent, SupersedeRelationResult, SupersedeStatementResult,
    TimeRange, TombstoneEntityQuery, TombstoneRelationQuery, TombstoneResult, TraversalPath,
    TraversalStep, TraverseInput, TraverseResult, UnlinkInput, UnlinkResult, UnmergeEntityResult,
    UpdateEntityInput, Whoami,
};

pub use sse::{FeedItem, Subscription};
