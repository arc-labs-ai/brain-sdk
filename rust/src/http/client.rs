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
    Capabilities, EncodeInput, EncodeResult, ForgetInput, ForgetResult, LinkInput, LinkResult,
    PlanInput, PlanResult, ReasonInput, ReasonResult, RecallInput, RecallResult, UnlinkInput,
    UnlinkResult, Whoami,
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
    /// Build a client for `base_url`, authenticating as `api_key`. Uses the
    /// [`DEFAULT_TIMEOUT`] request timeout and the default [`HttpRetryPolicy`].
    #[must_use]
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
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
        Self::new(DEFAULT_BASE_URL, api_key)
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
        let mut attempt = 1u32;
        loop {
            match self.send_once::<B, R>(method.clone(), path, body).await {
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
    async fn send_once<B, R>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<R, (BrainHttpError, Option<Duration>)>
    where
        B: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let url = format!("{}{}", self.base, path);
        let mut rb = self.http.request(method, &url).bearer_auth(&self.api_key);
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
