//! [`BrainHttpClient`] — the async HTTP tier of the Brain SDK.
//!
//! Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
//! gateway). Same verb surface and field names as the Python and TypeScript HTTP
//! clients. For the native wire protocol (streaming, transactions, typed-graph
//! management), use [`crate::BrainClient`] instead.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::error::BrainHttpError;
use super::retry::HttpRetryPolicy;
use super::sse::Subscription;
use super::types::{
    Capabilities, CreateEntityInput, CreateEntityResult, CreateRelationInput, CreateRelationResult,
    CreateSessionInput, CreateSpaceInput, CreateStatementInput, CreateStatementResult,
    DeleteSessionQuery, DropSchemaQuery, DropSchemaResult, EncodeInput, EncodeResult,
    EncodeVectorInput, EntityDetail, ForgetInput, ForgetResult, GetRelationQuery,
    GetStatementQuery, GraphFetchQuery, GraphPage, LinkInput, LinkResult, ListEntitiesQuery,
    ListEntitiesResult, ListExtractorsResult, ListRelationsQuery, ListRelationsResult,
    ListSchemasQuery, ListSchemasResult, ListSessionsQuery, ListSessionsResult, ListSpacesQuery,
    ListSpacesResult, ListStatementsQuery, ListStatementsResult, LlmCredential, LlmCredentialCheck,
    LlmCredentialDeleted, MaterializeProceduralInput, MaterializeProceduralResult, MemoryInspect,
    MemoryListPage, MemoryListQuery, MergeEntitiesInput, MergeEntitiesResult, PlanInput,
    PlanResult, PutLlmCredentialInput, QueryExplainResult, QueryInput, QueryTraceResult,
    ReasonInput, ReasonResult, RecallInput, RecallResult, RelationDetail, RenameEntityInput,
    ResolveEntityInput, ResolveEntityResult, RetireStatementQuery, RetractStatementResult, Schema,
    SchemaGetQuery, SchemaReplaceInput, SchemaReplaceResult, SchemaUploadInput, SchemaUploadResult,
    SchemaValidateInput, SchemaValidateResult, SessionErased, SessionProvision, SpaceErased,
    SpaceProvision, StatementDetail, StatementHistoryQuery, StatementHistoryResult, SubscribeQuery,
    SupersedeRelationResult, SupersedeStatementResult, TombstoneEntityQuery,
    TombstoneRelationQuery, TombstoneResult, TraverseInput, TraverseResult, UnlinkInput,
    UnlinkResult, UnmergeEntityResult, UpdateEntityInput, Whoami,
};

/// The default edge base URL (self-host).
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8080";

/// The default per-request timeout: a hung Brain must not hang the caller.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the underlying `reqwest` client with a request timeout. Falls back to
/// the default client if the builder rejects the config (never happens for a
/// plain timeout, but we avoid a panic either way).
fn build_http(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Percent-encode one path segment.
///
/// Ids are caller data. An id carrying `/`, `?`, `#` — or the two dots of a
/// parent reference — would otherwise rewrite the route instead of addressing a
/// row, so everything outside the unreserved set is escaped. `.` is escaped
/// too, which `..` needs and which no id is harmed by.
fn segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'~' => out.push(b as char),
            // `write!` into the buffer directly; `format!` would allocate a
            // String per escaped byte.
            _ => {
                use std::fmt::Write as _;
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

/// Parse a `Retry-After` header expressed as integer seconds. HTTP-date form is
/// ignored (returns `None`), leaving the computed backoff in force.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

/// An async HTTP client for the Brain edge.
#[derive(Clone, Debug)]
pub struct BrainHttpClient {
    base: String,
    api_key: String,
    http: reqwest::Client,
    retry: HttpRetryPolicy,
}

impl BrainHttpClient {
    /// Authenticate as `api_key` against `base_url`. Uses the
    /// [`DEFAULT_TIMEOUT`] request timeout and the default [`HttpRetryPolicy`].
    ///
    /// Key first, URL second — matching the Python and TypeScript clients,
    /// which both take the key as the required argument and the URL as the
    /// optional one. Both parameters are `impl Into<String>`, so a swapped call
    /// compiles cleanly and sends the base URL as the bearer token; keeping the
    /// three SDKs in one order is the only thing that makes that mistake hard.
    /// [`Self::localhost`] covers the common case in one argument.
    #[must_use]
    pub fn new(api_key: impl Into<String>, base_url: impl Into<String>) -> Self {
        let base = base_url.into().trim_end_matches('/').to_string();
        Self {
            base,
            api_key: api_key.into(),
            http: build_http(DEFAULT_TIMEOUT),
            retry: HttpRetryPolicy::default(),
        }
    }

    /// Build a client against [`DEFAULT_BASE_URL`].
    #[must_use]
    pub fn localhost(api_key: impl Into<String>) -> Self {
        Self::new(api_key, DEFAULT_BASE_URL)
    }

    /// Override the per-request timeout (default [`DEFAULT_TIMEOUT`]). A timeout
    /// surfaces as a transport [`BrainHttpError`], not a panic.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.http = build_http(timeout);
        self
    }

    /// Override the retry policy applied to idempotent verbs (`encode`,
    /// `whoami`, `capabilities`). Pass [`HttpRetryPolicy::none`] to disable.
    #[must_use]
    pub fn with_retry_policy(mut self, policy: HttpRetryPolicy) -> Self {
        self.retry = policy;
        self
    }

    /// Store a memory. Idempotent (stable server-side request id) — retried.
    pub async fn encode(&self, input: &EncodeInput) -> Result<EncodeResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/memories", Some(input), true)
            .await
    }

    /// Recall memories for a cue.
    // A PURE READ IS RETRYABLE, whatever its method.
    // `recall`, `plan`, `reason` and `traverse` are POSTs only because their filters need a body; none of them changes anything, so a transient 503/429 should be absorbed rather than raised at the caller.
    // `validate_schema` already worked this way — it is a dry run — and the other four were left behind.
    // What stays single-shot is what CREATES state: link, create_entity, resolve_entity (it can create), and the schema upload/replace.
    pub async fn recall(&self, input: &RecallInput) -> Result<RecallResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/recall", Some(input), true)
            .await
    }

    /// Forget a memory.
    pub async fn forget(&self, input: &ForgetInput) -> Result<ForgetResult, BrainHttpError> {
        // A DELETE whose result type MODELS the repeat is safe to retry: `forget` answers `was_already_forgotten` and `unlink` answers `removed: false` when there was nothing there.
        // Repeating one reaches the same end state, so a transient 503/429 on a cleanup path should be absorbed rather than raised at the caller.
        self.send(reqwest::Method::DELETE, "/v1/memories", Some(input), true)
            .await
    }

    /// Create/overwrite a directed edge between two memories.
    pub async fn link(&self, input: &LinkInput) -> Result<LinkResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/links", Some(input), false)
            .await
    }

    /// Remove a directed edge (idempotent).
    pub async fn unlink(&self, input: &UnlinkInput) -> Result<UnlinkResult, BrainHttpError> {
        // Idempotent for the same reason `forget` is: `removed: false` is the
        // documented answer when the edge was not there.
        self.send(reqwest::Method::DELETE, "/v1/links", Some(input), true)
            .await
    }

    /// Plan a path from a start state to a goal state.
    pub async fn plan(&self, input: &PlanInput) -> Result<PlanResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/plan", Some(input), true)
            .await
    }

    /// Infer over the graph from an observation.
    pub async fn reason(&self, input: &ReasonInput) -> Result<ReasonResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/reason", Some(input), true)
            .await
    }

    /// The identity Brain resolves from the credential. Idempotent GET — retried.
    pub async fn whoami(&self) -> Result<Whoami, BrainHttpError> {
        self.send::<(), _>(reqwest::Method::GET, "/v1/whoami", None, true)
            .await
    }

    /// What the connected shard supports. Idempotent GET — retried.
    pub async fn capabilities(&self) -> Result<Capabilities, BrainHttpError> {
        self.send::<(), _>(reqwest::Method::GET, "/v1/capabilities", None, true)
            .await
    }

    // --- reads ---------------------------------------------------------------
    //
    // Every read below is idempotent and therefore retried, and every one of
    // them takes its filters as a query struct whose unset fields are simply
    // not sent, so the edge's own defaults stay in force. Ids are interpolated
    // through `segment`, so an id carrying a slash or a query marker addresses
    // a row rather than reshaping the route.

    /// A page of the space's memories. This is not a recall: no cue, no
    /// ranking, just the timeline in a stable order plus a cursor.
    pub async fn memory_list(
        &self,
        query: &MemoryListQuery,
    ) -> Result<MemoryListPage, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/memories",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Everything the encode pipeline produced for one memory: the vector, the
    /// persisted row, the extracted graph.
    pub async fn memory_inspect(&self, memory_id: &str) -> Result<MemoryInspect, BrainHttpError> {
        let id = segment(memory_id);
        self.send::<(), _>(
            reqwest::Method::GET,
            &format!("/v1/memories/{id}/inspect"),
            None,
            true,
        )
        .await
    }

    /// Entities in the typed graph, filtered by the query.
    pub async fn list_entities(
        &self,
        query: &ListEntitiesQuery,
    ) -> Result<ListEntitiesResult, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/entities",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// One entity by id.
    pub async fn get_entity(&self, entity_id: &str) -> Result<EntityDetail, BrainHttpError> {
        let id = segment(entity_id);
        self.send::<(), _>(
            reqwest::Method::GET,
            &format!("/v1/entities/{id}"),
            None,
            true,
        )
        .await
    }

    /// The relations incident to one entity.
    pub async fn list_relations(
        &self,
        entity_id: &str,
        query: &ListRelationsQuery,
    ) -> Result<ListRelationsResult, BrainHttpError> {
        let id = segment(entity_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            &format!("/v1/entities/{id}/relations"),
            Some(query),
            None,
            true,
        )
        .await
    }

    /// One page of the space's typed graph, as a node/edge set.
    pub async fn graph_fetch(&self, query: &GraphFetchQuery) -> Result<GraphPage, BrainHttpError> {
        self.send_with_query::<(), _, _>(reqwest::Method::GET, "/v1/graph", Some(query), None, true)
            .await
    }

    /// One relation by id.
    pub async fn get_relation(
        &self,
        relation_id: &str,
        query: &GetRelationQuery,
    ) -> Result<RelationDetail, BrainHttpError> {
        let id = segment(relation_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            &format!("/v1/relations/{id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Statements in the typed graph, filtered by the query.
    pub async fn list_statements(
        &self,
        query: &ListStatementsQuery,
    ) -> Result<ListStatementsResult, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/statements",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// One statement by id.
    pub async fn get_statement(
        &self,
        statement_id: &str,
        query: &GetStatementQuery,
    ) -> Result<StatementDetail, BrainHttpError> {
        let id = segment(statement_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            &format!("/v1/statements/{id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    /// The active schema document for a namespace, or a specific version of it.
    pub async fn get_schema(&self, query: &SchemaGetQuery) -> Result<Schema, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/schema",
            Some(query),
            None,
            true,
        )
        .await
    }

    // --- writes --------------------------------------------------------------
    //
    // None of these is retried. A write that fails in flight may or may not
    // have landed, and a second attempt would either duplicate it or race the
    // first. `encode` above is the single exception, because the edge derives a
    // stable request id for it and dedupes server-side.
    //
    // `validate_schema` is the other kind of exception: a write-shaped route
    // that changes nothing — the edge parses the document and answers — so it
    // is safe to repeat and is retried like a read.
    //
    // `replace_schema` is the destructive one. It drops every declared row in
    // the namespace before the new document lands, so it is never retried under
    // any policy, and its confirmation flag has no default to fall back on.

    /// Check a schema document and report what an upload would do. A dry run
    /// that changes nothing, so it is idempotent and retried.
    pub async fn validate_schema(
        &self,
        input: &SchemaValidateInput,
    ) -> Result<SchemaValidateResult, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/schema/validate",
            Some(input),
            true,
        )
        .await
    }

    /// Upload a schema document as the namespace's next version.
    pub async fn upload_schema(
        &self,
        input: &SchemaUploadInput,
    ) -> Result<SchemaUploadResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/schema", Some(input), false)
            .await
    }

    /// Replace the namespace's schema, dropping every declared row first.
    /// Irreversible, and never retried: a second attempt would drop what the
    /// first one just wrote.
    pub async fn replace_schema(
        &self,
        input: &SchemaReplaceInput,
    ) -> Result<SchemaReplaceResult, BrainHttpError> {
        self.send(reqwest::Method::PUT, "/v1/schema", Some(input), false)
            .await
    }

    // Entity writes. `create_entity` and `resolve_entity` both mint entities;
    // the difference is that `resolve_entity` first tries to match the name
    // against what is already there, and creates only when `allow_create` says
    // it may. `traverse_relations` is a read in every sense except its verb —
    // the walk it describes does not fit in a query string, which is why the
    // edge takes a body for it — and it is left unretried all the same, so that
    // "reads are retried, writes are not" stays a statement about the verb
    // rather than one about intent.

    /// Create an entity in the typed graph.
    pub async fn create_entity(
        &self,
        input: &CreateEntityInput,
    ) -> Result<CreateEntityResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/entities", Some(input), false)
            .await
    }

    /// Resolve a candidate name against the typed graph, optionally creating
    /// the entity when nothing matches.
    pub async fn resolve_entity(
        &self,
        input: &ResolveEntityInput,
    ) -> Result<ResolveEntityResult, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/entities/resolve",
            Some(input),
            false,
        )
        .await
    }

    /// Walk the relation graph outward from one entity.
    pub async fn traverse_relations(
        &self,
        entity_id: &str,
        input: &TraverseInput,
    ) -> Result<TraverseResult, BrainHttpError> {
        let id = segment(entity_id);
        self.send(
            reqwest::Method::POST,
            &format!("/v1/entities/{id}/traverse"),
            Some(input),
            true,
        )
        .await
    }

    // --- space lifecycle -----------------------------------------------------
    //
    // All three act on the caller's effective space: Brain resolves it from
    // the credential and never takes it from the request, so none of them
    // names one.

    /// Provision the caller's space. Idempotent — read `created` to tell
    /// whether this call made it.
    pub async fn create_space(
        &self,
        input: &CreateSpaceInput,
    ) -> Result<SpaceProvision, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/spaces", Some(input), true)
            .await
    }

    /// The spaces in the caller's namespace.
    ///
    /// Check `cross_shard_complete`: `false` means the listing covered one
    /// shard, and treating a partial listing as complete is how a caller
    /// concludes a space is gone.
    pub async fn list_spaces(
        &self,
        query: &ListSpacesQuery,
    ) -> Result<ListSpacesResult, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/spaces",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Erase the caller's space and everything under it. Hard and immediate.
    pub async fn delete_space(&self) -> Result<SpaceErased, BrainHttpError> {
        // Retryable: a repeat reaches the same end state and answers
        // `existed: false`, which the result type models.
        self.send::<(), _>(reqwest::Method::DELETE, "/v1/spaces", None, true)
            .await
    }

    // --- session lifecycle ---------------------------------------------------

    /// Provision a session in the caller's space. Idempotent on the
    /// client-chosen id.
    pub async fn create_session(
        &self,
        input: &CreateSessionInput,
    ) -> Result<SessionProvision, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/sessions", Some(input), true)
            .await
    }

    /// The sessions in the caller's space.
    pub async fn list_sessions(
        &self,
        query: &ListSessionsQuery,
    ) -> Result<ListSessionsResult, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/sessions",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Erase a session. Soft unless `hard` is set.
    pub async fn delete_session(
        &self,
        session_id: u64,
        query: &DeleteSessionQuery,
    ) -> Result<SessionErased, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::DELETE,
            &format!("/v1/sessions/{session_id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    // --- entity authoring ----------------------------------------------------

    /// Replace an entity's name, aliases and attribute blob.
    ///
    /// A REPLACE, not a patch: an omitted `aliases` or `attributes` clears
    /// it. `get_entity` returns both so a read-modify-write round-trips.
    pub async fn update_entity(
        &self,
        entity_id: &str,
        input: &UpdateEntityInput,
    ) -> Result<EntityDetail, BrainHttpError> {
        let id = segment(entity_id);
        // Idempotent by nature: the same replace applied twice is the same
        // end state.
        self.send(
            reqwest::Method::PUT,
            &format!("/v1/entities/{id}"),
            Some(input),
            true,
        )
        .await
    }

    /// Change an entity's canonical name, keeping the old one as an alias
    /// unless told otherwise.
    pub async fn rename_entity(
        &self,
        entity_id: &str,
        input: &RenameEntityInput,
    ) -> Result<EntityDetail, BrainHttpError> {
        let id = segment(entity_id);
        self.send(
            reqwest::Method::POST,
            &format!("/v1/entities/{id}/rename"),
            Some(input),
            true,
        )
        .await
    }

    /// Fold another entity into this one. `entity_id` is the SURVIVOR.
    ///
    /// Reversible for `grace_period_seconds`, which the result carries so a
    /// caller need not know the deployment's configuration.
    pub async fn merge_entities(
        &self,
        survivor_id: &str,
        input: &MergeEntitiesInput,
    ) -> Result<MergeEntitiesResult, BrainHttpError> {
        let id = segment(survivor_id);
        // Single-shot: a merge creates an audit record, and a retried one
        // would create a second.
        self.send(
            reqwest::Method::POST,
            &format!("/v1/entities/{id}/merge"),
            Some(input),
            false,
        )
        .await
    }

    /// Undo a merge. `entity_id` is the entity that was merged away.
    pub async fn unmerge_entity(
        &self,
        merged_entity_id: &str,
    ) -> Result<UnmergeEntityResult, BrainHttpError> {
        let id = segment(merged_entity_id);
        self.send::<(), _>(
            reqwest::Method::POST,
            &format!("/v1/entities/{id}/unmerge"),
            None,
            false,
        )
        .await
    }

    /// Tombstone an entity. The row stays and reads stop resolving to it,
    /// which is what keeps statements that referenced it interpretable.
    pub async fn tombstone_entity(
        &self,
        entity_id: &str,
        query: &TombstoneEntityQuery,
    ) -> Result<TombstoneResult, BrainHttpError> {
        let id = segment(entity_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::DELETE,
            &format!("/v1/entities/{id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    // --- statement authoring -------------------------------------------------

    /// Assert a claim.
    ///
    /// Brain may recognise it as a revision of an existing claim and supersede
    /// that one; `auto_superseded` says when it did.
    pub async fn create_statement(
        &self,
        input: &CreateStatementInput,
    ) -> Result<CreateStatementResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/statements", Some(input), false)
            .await
    }

    /// Replace a claim with a revised one, keeping both and the link between
    /// them.
    pub async fn supersede_statement(
        &self,
        statement_id: &str,
        input: &CreateStatementInput,
    ) -> Result<SupersedeStatementResult, BrainHttpError> {
        let id = segment(statement_id);
        self.send(
            reqwest::Method::POST,
            &format!("/v1/statements/{id}/supersede"),
            Some(input),
            false,
        )
        .await
    }

    /// Retire a claim. The row stays; reads stop returning it.
    pub async fn tombstone_statement(
        &self,
        statement_id: &str,
        query: &RetireStatementQuery,
    ) -> Result<TombstoneResult, BrainHttpError> {
        let id = segment(statement_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::DELETE,
            &format!("/v1/statements/{id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Withdraw a claim: stronger than a tombstone, because the content
    /// itself is scheduled to be zeroed.
    pub async fn retract_statement(
        &self,
        statement_id: &str,
        query: &RetireStatementQuery,
    ) -> Result<RetractStatementResult, BrainHttpError> {
        let id = segment(statement_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::POST,
            &format!("/v1/statements/{id}/retract"),
            Some(query),
            None,
            true,
        )
        .await
    }

    /// Every version of one claim, oldest first.
    pub async fn statement_history(
        &self,
        statement_id: &str,
        query: &StatementHistoryQuery,
    ) -> Result<StatementHistoryResult, BrainHttpError> {
        let id = segment(statement_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            &format!("/v1/statements/{id}/history"),
            Some(query),
            None,
            true,
        )
        .await
    }

    // --- relation authoring --------------------------------------------------

    /// Assert a typed edge between two entities.
    pub async fn create_relation(
        &self,
        input: &CreateRelationInput,
    ) -> Result<CreateRelationResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/relations", Some(input), false)
            .await
    }

    /// Replace an edge with a revised one.
    ///
    /// The replacement is a whole edge and it REPLACES the property blob,
    /// which is why `get_relation` returns `properties` — a revision that
    /// only meant to change validity can carry the old ones back.
    pub async fn supersede_relation(
        &self,
        relation_id: &str,
        input: &CreateRelationInput,
    ) -> Result<SupersedeRelationResult, BrainHttpError> {
        let id = segment(relation_id);
        self.send(
            reqwest::Method::POST,
            &format!("/v1/relations/{id}/supersede"),
            Some(input),
            false,
        )
        .await
    }

    /// Retire an edge.
    pub async fn tombstone_relation(
        &self,
        relation_id: &str,
        query: &TombstoneRelationQuery,
    ) -> Result<TombstoneResult, BrainHttpError> {
        let id = segment(relation_id);
        self.send_with_query::<(), _, _>(
            reqwest::Method::DELETE,
            &format!("/v1/relations/{id}"),
            Some(query),
            None,
            true,
        )
        .await
    }

    // --- schema introspection + drop -----------------------------------------

    /// The namespace's schema version history.
    ///
    /// Distinct from [`Self::get_schema`], which returns one document: this is
    /// what a caller about to upload needs in order to see what it is adding
    /// to.
    pub async fn list_schemas(
        &self,
        query: &ListSchemasQuery,
    ) -> Result<ListSchemasResult, BrainHttpError> {
        self.send_with_query::<(), _, _>(
            reqwest::Method::GET,
            "/v1/schemas",
            Some(query),
            None,
            true,
        )
        .await
    }

    /// The extractors registered on the shard. Read-only: extraction is
    /// always-on and cannot be toggled. Here so a caller reading
    /// `extractor_id` on a statement can find out what produced it.
    pub async fn list_extractors(&self) -> Result<ListExtractorsResult, BrainHttpError> {
        self.send::<(), _>(reqwest::Method::GET, "/v1/extractors", None, true)
            .await
    }

    /// Drop one declared predicate or relation type.
    ///
    /// `kind` is `predicate` or `relation_type`. Entity types are not
    /// droppable: they are global in the v1 storage model, so dropping one
    /// would race rows in other namespaces.
    pub async fn drop_schema(
        &self,
        kind: &str,
        name: &str,
        query: &DropSchemaQuery,
    ) -> Result<DropSchemaResult, BrainHttpError> {
        let (k, n) = (segment(kind), segment(name));
        self.send_with_query::<(), _, _>(
            reqwest::Method::DELETE,
            &format!("/v1/schema/{k}/{n}"),
            Some(query),
            None,
            false,
        )
        .await
    }

    // --- memory extras -------------------------------------------------------

    /// Store a memory with a caller-supplied embedding.
    ///
    /// `model_fingerprint` is required: vectors from different models are not
    /// comparable, so a recall that mixed them would rank nonsense
    /// confidently.
    pub async fn encode_vector(
        &self,
        input: &EncodeVectorInput,
    ) -> Result<EncodeResult, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/memories/vector",
            Some(input),
            true,
        )
        .await
    }

    /// Render the caller's remembered directives into a system-prompt block.
    ///
    /// Check `trimmed_by_budget`: `true` means directives did not make it in,
    /// so the block is not the whole set.
    pub async fn materialize_procedural(
        &self,
        input: &MaterializeProceduralInput,
    ) -> Result<MaterializeProceduralResult, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/procedural/materialize",
            Some(input),
            true,
        )
        .await
    }

    // --- query introspection -------------------------------------------------

    /// The plan Brain would run, and its estimated cost. Does NOT run it.
    pub async fn query_explain(
        &self,
        input: &QueryInput,
    ) -> Result<QueryExplainResult, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/query/explain",
            Some(input),
            true,
        )
        .await
    }

    /// Run the query and report what happened, with the measured latency.
    /// Unlike [`Self::query_explain`], this costs what the query costs.
    pub async fn query_trace(
        &self,
        input: &QueryInput,
    ) -> Result<QueryTraceResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/query/trace", Some(input), true)
            .await
    }

    // --- BYOK provider credentials -------------------------------------------

    /// Register (or replace) this tenant's provider key.
    ///
    /// The edge verifies the key with the provider before storing it and
    /// seals it on arrival; it is never returned.
    pub async fn put_llm_credential(
        &self,
        input: &PutLlmCredentialInput,
    ) -> Result<LlmCredential, BrainHttpError> {
        self.send(
            reqwest::Method::PUT,
            "/v1/llm-credential",
            Some(input),
            false,
        )
        .await
    }

    /// What is installed for this tenant. Carries no key material.
    pub async fn get_llm_credential(&self) -> Result<LlmCredential, BrainHttpError> {
        self.send::<(), _>(reqwest::Method::GET, "/v1/llm-credential", None, true)
            .await
    }

    /// Remove this tenant's provider key. `deleted: false` means there was
    /// nothing there — which matters during an incident response.
    pub async fn delete_llm_credential(&self) -> Result<LlmCredentialDeleted, BrainHttpError> {
        self.send::<(), _>(reqwest::Method::DELETE, "/v1/llm-credential", None, true)
            .await
    }

    /// Check a key WITHOUT storing it. Nothing is written and nothing
    /// existing is touched, so this is safe against a namespace that already
    /// has a working credential.
    pub async fn test_llm_credential(
        &self,
        input: &PutLlmCredentialInput,
    ) -> Result<LlmCredentialCheck, BrainHttpError> {
        self.send(
            reqwest::Method::POST,
            "/v1/llm-credential/test",
            Some(input),
            true,
        )
        .await
    }

    /// Re-check the key already stored. A key that worked at registration can
    /// be revoked or run out of credit later, where the first sign is
    /// otherwise an opaque upstream 401 on a write.
    pub async fn verify_llm_credential(&self) -> Result<LlmCredentialCheck, BrainHttpError> {
        self.send::<(), _>(
            reqwest::Method::POST,
            "/v1/llm-credential/verify",
            None,
            true,
        )
        .await
    }

    // --- change feed ---------------------------------------------------------

    /// Open the caller's change feed.
    ///
    /// Returns a [`Subscription`] drained with `next().await` — the same
    /// shape the native wire client's subscription has, so moving between the
    /// two tiers rewrites the construction, not the loop.
    ///
    /// Unsubscribing is dropping the handle: the edge tears the Brain-side
    /// subscription down when the response closes. There is no teardown call
    /// to forget.
    ///
    /// Every event carries an `lsn`, and the handle remembers the last one
    /// ([`Subscription::last_event_id`]). Pass it back as
    /// [`SubscribeQuery::from_lsn`] on a reconnect to resume exactly rather
    /// than replay or skip.
    ///
    /// # Errors
    /// A transport failure, or a non-success status from the edge.
    ///
    /// Not retried, deliberately. A retry would silently reopen the feed from
    /// the query's original position, re-delivering everything the caller had
    /// already seen; resuming is the caller's decision because only it knows
    /// where it got to.
    pub async fn subscribe(&self, query: &SubscribeQuery) -> Result<Subscription, BrainHttpError> {
        self.open_stream(reqwest::Method::GET, "/v1/subscribe", query)
            .await
    }

    /// Open a streaming response rather than reading a body to completion.
    ///
    /// Split from [`Self::send_once`] because the two differ in every way
    /// that matters: no retry (reopening a feed re-delivers what the caller
    /// already saw), no body read, and no request timeout.
    async fn open_stream<Q>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &Q,
    ) -> Result<Subscription, BrainHttpError>
    where
        Q: Serialize + ?Sized,
    {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .request(method, &url)
            .bearer_auth(&self.api_key)
            .query(query)
            // The per-request timeout would otherwise cut a healthy feed off
            // after 30s. A subscription is long-lived by definition; its
            // liveness signal is the edge's keep-alive comment, not a
            // deadline.
            .timeout(Duration::from_secs(u64::MAX / 2))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|e| BrainHttpError::transport(format!("subscribe to {url} failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(BrainHttpError::from_body(status.as_u16(), &text));
        }
        Ok(Subscription::new(resp))
    }

    /// Send with the retry policy applied when `idempotent`. Non-idempotent
    /// verbs (`retry == false`) run exactly once.
    async fn send<B, R>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
        idempotent: bool,
    ) -> Result<R, BrainHttpError>
    where
        B: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        self.send_with_query::<B, (), R>(method, path, None, body, idempotent)
            .await
    }

    /// [`Self::send`] with a query struct appended to the path. Its `None`
    /// fields skip (see `types`), so a default-constructed query sends no query
    /// string at all rather than a row of empty parameters.
    async fn send_with_query<B, Q, R>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: Option<&Q>,
        body: Option<&B>,
        idempotent: bool,
    ) -> Result<R, BrainHttpError>
    where
        B: Serialize + ?Sized,
        Q: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let mut attempt = 1u32;
        loop {
            match self
                .send_once::<B, Q, R>(method.clone(), path, query, body)
                .await
            {
                Ok(value) => return Ok(value),
                Err((err, retry_after)) => {
                    if idempotent && self.retry.should_retry(attempt, &err) {
                        tokio::time::sleep(self.retry.backoff(attempt, retry_after)).await;
                        attempt += 1;
                    } else {
                        return Err(err);
                    }
                }
            }
        }
    }

    /// One request attempt. On failure returns the error plus an optional
    /// server `Retry-After` hint for the retry scheduler.
    async fn send_once<B, Q, R>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: Option<&Q>,
        body: Option<&B>,
    ) -> Result<R, (BrainHttpError, Option<Duration>)>
    where
        B: Serialize + ?Sized,
        Q: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let url = format!("{}{}", self.base, path);
        let mut rb = self.http.request(method, &url).bearer_auth(&self.api_key);
        if let Some(q) = query {
            rb = rb.query(q);
        }
        if let Some(b) = body {
            rb = rb.json(b);
        }
        let resp = rb.send().await.map_err(|e| {
            (
                BrainHttpError::transport(format!("request to {url} failed: {e}")),
                None,
            )
        })?;
        let status = resp.status();
        let retry_after = parse_retry_after(resp.headers());
        let text = resp.text().await.map_err(|e| {
            (
                BrainHttpError::transport(format!("read body from {url}: {e}")),
                None,
            )
        })?;
        if !status.is_success() {
            return Err((
                BrainHttpError::from_body(status.as_u16(), &text),
                retry_after,
            ));
        }
        serde_json::from_str(&text).map_err(|e| {
            (
                BrainHttpError::transport(format!("decode {url} response: {e}")),
                None,
            )
        })
    }
}
