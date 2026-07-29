//! The HTTP tier: routing, auth, error mapping, and retry.
//!
//! `BrainHttpClient` is what talks to `brain-edge`, and it had no tests in any
//! of the three SDKs. The wire client's mock-server suites do not cover it — it
//! is a separate transport with its own error taxonomy and its own retry policy.
//!
//! Driven against a real in-process HTTP/1.1 server rather than a live edge:
//! the interesting behaviour here is what happens when things go *wrong* — a
//! 503 mid retry, a body that is not JSON, a socket that dies — none of which is
//! reachable on demand from a healthy edge.
//!
//! The server is ~60 lines rather than a `wiremock` dev-dependency. This crate
//! is about to be published, and a mock HTTP framework is a large dependency to
//! carry for a handful of canned replies. It speaks exactly enough HTTP/1.1 for
//! reqwest: request line, headers, `Content-Length` body, `Connection: close`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use brain_db_sdk::http::{BrainHttpClient, HttpRetryPolicy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One request as the server saw it.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    body: String,
}

#[derive(Default)]
struct State {
    seen: Vec<Seen>,
    /// Queued replies, consumed in order: `(status, body)`.
    replies: Vec<(u16, String)>,
}

struct MockEdge {
    base_url: String,
    state: Arc<Mutex<State>>,
}

impl MockEdge {
    fn seen(&self) -> Vec<Seen> {
        self.state.lock().expect("state lock").seen.clone()
    }
}

/// Boot the mock edge with a queue of canned replies. Requests past the end of
/// the queue get `200 {}`.
async fn mock_edge(replies: Vec<(u16, &str)>) -> MockEdge {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let state = Arc::new(Mutex::new(State {
        seen: Vec::new(),
        replies: replies
            .into_iter()
            .map(|(s, b)| (s, b.to_string()))
            .collect(),
    }));

    let served = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let state = Arc::clone(&served);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read until the header block ends, then until Content-Length
                // bytes of body have arrived.
                let head_end = loop {
                    let n = match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = find(&buf, b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let want: usize = header(&head, "content-length")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                while buf.len() < head_end + want {
                    let n = match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&chunk[..n]);
                }

                let mut lines = head.lines();
                let request_line = lines.next().unwrap_or_default();
                let mut parts = request_line.split_whitespace();
                let seen = Seen {
                    method: parts.next().unwrap_or_default().to_string(),
                    path: parts.next().unwrap_or_default().to_string(),
                    auth: header(&head, "authorization"),
                    body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                };

                let (status, body) = {
                    let mut st = state.lock().expect("state lock");
                    st.seen.push(seen);
                    if st.replies.is_empty() {
                        (200, "{}".to_string())
                    } else {
                        st.replies.remove(0)
                    }
                };

                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });

    MockEdge {
        base_url: format!("http://{addr}"),
        state,
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines()
        .skip(1)
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        })
        .map(|(_, v)| v.trim().to_string())
}

const API_KEY: &str = "brain_test-key";

fn client(edge: &MockEdge) -> BrainHttpClient {
    // No sleeping in tests: the schedule is asserted separately from the
    // decision to retry.
    BrainHttpClient::new(&edge.base_url, API_KEY).with_retry_policy(HttpRetryPolicy::new(
        3,
        Duration::ZERO,
        Duration::ZERO,
    ))
}

const WHOAMI: &str = r#"{"namespace":"ns","space_id":"00000000-0000-0000-0000-000000000000",
  "permissions":{"can_encode":true,"can_recall":true,"can_plan":true,
  "can_reason":true,"can_forget":true,"can_admin":false}}"#;

// --- routing and auth ------------------------------------------------------

#[tokio::test]
async fn encode_posts_to_the_right_route_carrying_the_key() {
    let edge = mock_edge(vec![(
        200,
        r#"{"memory_id":"42","was_deduplicated":false,"salience":0.5,"kind":0,
            "created_at_unix_nanos":7,"auto_edges_added":1}"#,
    )])
    .await;

    let out = client(&edge)
        .encode(&brain_db_sdk::http::EncodeInput {
            text: "the sky is teal".to_string(),
            session: None,
            occurred_at: None,
        })
        .await
        .expect("encode");

    let seen = edge.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/v1/memories")
    );
    assert_eq!(
        seen[0].auth.as_deref(),
        Some(format!("Bearer {API_KEY}").as_str()),
        "the API key must ride every request"
    );
    assert!(seen[0].body.contains("the sky is teal"));
    assert_eq!(out.memory_id, "42");
    assert_eq!(out.auto_edges_added, 1);
}

#[tokio::test]
async fn whoami_and_capabilities_are_gets() {
    // A wrong path is a 404 against a real edge and silence against a mock, so
    // the route each verb uses is asserted directly.
    let edge = mock_edge(vec![(200, WHOAMI)]).await;
    client(&edge).whoami().await.expect("whoami");
    let seen = edge.seen();
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("GET", "/v1/whoami")
    );

    let edge = mock_edge(vec![(200, "{}")]).await;
    let _ = client(&edge).capabilities().await;
    let seen = edge.seen();
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("GET", "/v1/capabilities")
    );
}

// --- error mapping ---------------------------------------------------------

#[tokio::test]
async fn an_error_body_becomes_a_structured_error() {
    let edge = mock_edge(vec![(
        404,
        r#"{"error":{"code":"not_found","message":"no such memory"}}"#,
    )])
    .await;

    let err = client(&edge).whoami().await.expect_err("must fail");
    assert_eq!(err.status, 404);
    assert_eq!(err.code, "not_found");
    assert_eq!(err.message, "no such memory");
}

#[tokio::test]
async fn a_non_json_error_body_still_yields_an_error() {
    // An edge behind a proxy can return HTML; the client must not die parsing it.
    let edge = mock_edge(vec![(502, "<html>Bad Gateway</html>")]).await;
    let err = client(&edge).whoami().await.expect_err("must fail");
    assert_eq!(err.status, 502);
}

#[tokio::test]
async fn a_transport_failure_is_a_brain_error() {
    // A caller matching on BrainHttpError must not also have to handle a raw
    // reqwest error. Port 1 is reserved and refuses connections.
    let err = BrainHttpClient::new("http://127.0.0.1:1", API_KEY)
        .with_retry_policy(HttpRetryPolicy::none())
        .whoami()
        .await
        .expect_err("must fail");
    assert_eq!(err.status, 0);
    assert_eq!(err.code, "transport");
}

// --- retry -----------------------------------------------------------------

#[tokio::test]
async fn an_idempotent_verb_retries_a_503_and_succeeds() {
    let edge = mock_edge(vec![
        (
            503,
            r#"{"error":{"code":"unavailable","message":"shard restarting"}}"#,
        ),
        (200, WHOAMI),
    ])
    .await;

    client(&edge).whoami().await.expect("retry then succeed");
    assert_eq!(
        edge.seen().len(),
        2,
        "a 503 on an idempotent GET must be retried"
    );
}

#[tokio::test]
async fn retry_gives_up_after_max_attempts() {
    let body = r#"{"error":{"code":"unavailable","message":"no"}}"#;
    let edge = mock_edge(vec![(503, body); 5]).await;

    let err = client(&edge).whoami().await.expect_err("must fail");
    assert_eq!(err.status, 503);
    assert_eq!(
        edge.seen().len(),
        3,
        "max_attempts=3 means three requests, not three retries"
    );
}

#[tokio::test]
async fn a_4xx_is_not_retried() {
    // Retrying a client error just multiplies it — the request will not become
    // valid on a second attempt.
    let body = r#"{"error":{"code":"unauthorized","message":"bad key"}}"#;
    let edge = mock_edge(vec![(401, body); 3]).await;

    let err = client(&edge).whoami().await.expect_err("must fail");
    assert_eq!(err.status, 401);
    assert_eq!(edge.seen().len(), 1);
}
