//! Shared integration-test harness: attach to a real `brain-server` and mint
//! per-test data-plane keys.
//!
//! These helpers back the `it_*` integration suites. They are **gated on the
//! environment** so the default `cargo test` (which has no server) stays green:
//! when `BRAIN_SDK_IT_DATA` is unset, [`It::from_env`] returns `None` and each
//! suite early-returns. Boot a server and export the vars with
//! `scripts/it-server.sh up` (see that script's header), then re-run.
//!
//! Auth is mandatory and the credential is the whole identity: every test
//! mints a fresh `brain_` token bound to `(namespace, space_id)` via the admin
//! plane (`POST /v1/api-keys`) and connects with it, so isolation is real —
//! two tests never share an agent unless they mint the same id on purpose.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::time::Duration;

use brain_db_sdk::wire::types::RecallRequest;
use brain_db_sdk::{new_id, Auth, BrainClient, RecallAnswer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long [`recall_until`] polls before giving up.
pub const VISIBILITY_TIMEOUT: Duration = Duration::from_secs(5);

/// A configured integration target: the data plane to speak the wire to, plus
/// the admin plane used to mint keys.
pub struct It {
    /// Data-plane address the SDK connects to.
    pub data: SocketAddr,
    /// Admin-plane address (`POST /v1/api-keys`) used to mint keys.
    admin: SocketAddr,
    /// Bearer secret gating the admin plane.
    admin_secret: String,
    /// Tenant namespace every minted key binds to.
    pub namespace: String,
}

impl It {
    /// Read the integration target from the environment, or `None` when it is
    /// not configured (so the suite skips cleanly offline).
    ///
    /// - `BRAIN_SDK_IT_DATA` (required) — data-plane `host:port`.
    /// - `BRAIN_SDK_IT_ADMIN` — admin `host:port` (default `127.0.0.1:19092`).
    /// - `BRAIN_SDK_IT_ADMIN_SECRET` — admin bearer (default `sdk-it-admin-secret`).
    /// - `BRAIN_SDK_IT_NAMESPACE` — tenant namespace (default `sdk-it`).
    pub fn from_env() -> Option<It> {
        let data: SocketAddr = std::env::var("BRAIN_SDK_IT_DATA").ok()?.parse().ok()?;
        let admin: SocketAddr = std::env::var("BRAIN_SDK_IT_ADMIN")
            .unwrap_or_else(|_| "127.0.0.1:19092".to_string())
            .parse()
            .ok()?;
        let admin_secret = std::env::var("BRAIN_SDK_IT_ADMIN_SECRET")
            .unwrap_or_else(|_| "sdk-it-admin-secret".to_string());
        let namespace =
            std::env::var("BRAIN_SDK_IT_NAMESPACE").unwrap_or_else(|_| "sdk-it".to_string());
        Some(It {
            data,
            admin,
            admin_secret,
            namespace,
        })
    }

    /// Mint a `FULL` data-plane token bound to `(namespace, space_id)` and
    /// return its secret string. Panics on any admin-plane failure — an
    /// integration test that cannot mint has nothing to assert.
    pub async fn mint(&self, space_id: [u8; 16]) -> String {
        let body = format!(
            r#"{{"space_id_hex":"{}","namespace":"{}","permissions":["FULL"]}}"#,
            hex16(&space_id),
            self.namespace,
        );
        let req = format!(
            "POST /v1/api-keys HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {secret}\r\n\
             Content-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            host = self.admin,
            secret = self.admin_secret,
            len = body.len(),
            body = body,
        );

        let mut sock = TcpStream::connect(self.admin)
            .await
            .expect("connect admin plane");
        sock.write_all(req.as_bytes()).await.expect("write mint request");
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.expect("read mint response");
        let text = String::from_utf8_lossy(&raw);

        let status = text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("?");
        assert_eq!(status, "201", "admin mint failed: {text}");

        let payload = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b)
            .unwrap_or_default();
        let json: serde_json::Value =
            serde_json::from_str(payload.trim()).expect("mint response is JSON");
        json.get("secret")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .expect("mint response carries a non-empty secret")
            .to_string()
    }

    /// Mint a token for `space_id` and connect a client as that space.
    pub async fn connect_as(&self, space_id: [u8; 16]) -> BrainClient {
        let token = self.mint(space_id).await;
        BrainClient::connect(self.data, Auth::Token(token.into_bytes()))
            .await
            .expect("connect + handshake")
    }

    /// Mint + connect as a brand-new random space; returns `(client, space_id)`.
    pub async fn connect_fresh(&self) -> (BrainClient, [u8; 16]) {
        let space = new_id();
        (self.connect_as(space).await, space)
    }
}

/// Poll RECALL until `pred` holds on the answer or [`VISIBILITY_TIMEOUT`]
/// elapses, returning the final answer.
///
/// ENCODE is durable the instant it acks (WAL-before-ack), but the semantic
/// index becomes *searchable* a beat later — so a recall fired immediately
/// after an encode can miss it. Real read-your-writes against the retrieval
/// path therefore needs a short poll; this helper centralizes that so a
/// visibility lag never shows up as a flaky assertion.
pub async fn recall_until<F>(client: &BrainClient, req: &RecallRequest, pred: F) -> RecallAnswer
where
    F: Fn(&RecallAnswer) -> bool,
{
    let deadline = tokio::time::Instant::now() + VISIBILITY_TIMEOUT;
    loop {
        let answer = client.recall(req).await.expect("recall");
        if pred(&answer) || tokio::time::Instant::now() >= deadline {
            return answer;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Lowercase hex of a 16-byte id (32 chars) — the form the admin API expects.
pub fn hex16(id: &[u8; 16]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(32);
    for b in id {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Bind an [`It`] from the environment, or print a skip note and `return` from
/// the calling test. Used as `let it = skip_or!(...)`-free `let-else`:
///
/// ```ignore
/// let Some(it) = common::It::from_env() else { return common::skip("name"); };
/// ```
pub fn skip(what: &str) {
    eprintln!(
        "SKIP {what}: integration server not configured \
         (set BRAIN_SDK_IT_DATA; see scripts/it-server.sh)"
    );
}
