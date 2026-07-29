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
use super::types::{
    Capabilities, CreateEntityInput, CreateEntityResult, EncodeInput, EncodeResult, EntityDetail,
    ForgetInput, ForgetResult, GetRelationQuery, GetStatementQuery, GraphFetchQuery, GraphPage,
    LinkInput, LinkResult, ListEntitiesQuery, ListEntitiesResult, ListRelationsQuery,
    ListRelationsResult, ListStatementsQuery, ListStatementsResult, MemoryInspect, MemoryListPage,
    MemoryListQuery, PlanInput, PlanResult, ReasonInput, ReasonResult, RecallInput, RecallResult,
    RelationDetail, ResolveEntityInput, ResolveEntityResult, Schema, SchemaGetQuery,
    SchemaReplaceInput, SchemaReplaceResult, SchemaUploadInput, SchemaUploadResult,
    SchemaValidateInput, SchemaValidateResult, StatementDetail, TraverseInput, TraverseResult,
    UnlinkInput, UnlinkResult, Whoami,
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
            _ => out.push_str(&format!("%{b:02X}")),
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
    pub async fn recall(&self, input: &RecallInput) -> Result<RecallResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/recall", Some(input), false)
            .await
    }

    /// Forget a memory.
    pub async fn forget(&self, input: &ForgetInput) -> Result<ForgetResult, BrainHttpError> {
        self.send(reqwest::Method::DELETE, "/v1/memories", Some(input), false)
            .await
    }

    /// Create/overwrite a directed edge between two memories.
    pub async fn link(&self, input: &LinkInput) -> Result<LinkResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/links", Some(input), false)
            .await
    }

    /// Remove a directed edge (idempotent).
    pub async fn unlink(&self, input: &UnlinkInput) -> Result<UnlinkResult, BrainHttpError> {
        self.send(reqwest::Method::DELETE, "/v1/links", Some(input), false)
            .await
    }

    /// Plan a path from a start state to a goal state.
    pub async fn plan(&self, input: &PlanInput) -> Result<PlanResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/plan", Some(input), false)
            .await
    }

    /// Infer over the graph from an observation.
    pub async fn reason(&self, input: &ReasonInput) -> Result<ReasonResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/reason", Some(input), false)
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
            false,
        )
        .await
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
