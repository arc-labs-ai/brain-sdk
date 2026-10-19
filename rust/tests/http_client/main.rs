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

use brain_db_sdk::http::{
    BrainHttpClient, CreateEntityInput, GetRelationQuery, GetStatementQuery, GraphFetchQuery,
    HttpRetryPolicy, ListEntitiesQuery, ListRelationsQuery, ListStatementsQuery, MemoryListQuery,
    ResolveEntityInput, SchemaGetQuery, SchemaReplaceInput, SchemaUploadInput, SchemaValidateInput,
    StatementObject, StatementValue, TraverseInput,
};
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
    BrainHttpClient::new(API_KEY, &edge.base_url).with_retry_policy(HttpRetryPolicy::new(
        3,
        Duration::ZERO,
        Duration::ZERO,
    ))
}

const WHOAMI: &str = r#"{"namespace":"ns","space_id":"00000000-0000-0000-0000-000000000000",
  "permissions":{"can_encode":true,"can_recall":true,"can_plan":true,
  "can_reason":true,"can_forget":true,"can_admin":false}}"#;

/// A `MemoryInspectDto` shaped as the manifest declares it, including a
/// `StageGraphEdgeDto` with its optional `event_at_unix_nanos` absent.
const INSPECT: &str = r#"{"found":true,"memory_id":"m1","text":"the kettle whistled",
  "artifact":{"vector":[0.25,0.5],
    "record":{"memory_id":"m1","kind":0,"salience":0.5,"created_at_unix_nanos":1,
      "occurred_at_unix_nanos":2,"vector_dim":768,"text_len":19,"lsn":9},
    "hype_questions":["what whistled?"],
    "keyword_fields":[{"field":"text","terms":["kettle"]}],
    "graph":{"nodes":[{"id":"n1","name":"kettle","kind":"entity","type_qname":"brain:Thing"}],
      "edges":[{"source":"n1","target":"n2","predicate":"whistled",
        "kind":"relation","confidence":0.9}]}}}"#;

const ENTITY: &str = r#"{"entity_id":"e1","entity_type_id":7,
  "canonical_name":"Ada Lovelace","aliases":["Ada"],"mention_count":3,
  "created_at_unix_nanos":1,"updated_at_unix_nanos":2,"merged_into":null}"#;

const ENTITIES: &str = r#"{"entities":[{"entity_id":"e1","entity_type_id":7,
  "canonical_name":"Ada Lovelace","aliases":["Ada"],"mention_count":3,
  "created_at_unix_nanos":1,"updated_at_unix_nanos":2,"merged_into":null}],"count":1}"#;

const RELATION: &str = r#"{"relation_id":"r1","relation_type":"works_at",
  "from_entity":"e1","to_entity":"e2","confidence":0.9,"valid_from_unix_nanos":1,
  "valid_to_unix_nanos":0,"is_symmetric":false,"tombstoned":false}"#;

const STATEMENT: &str = r#"{"statement_id":"s1","kind":"Fact","subject":"e1",
  "predicate":"knows","object":{"kind":"entity","id":"e2"},"confidence":0.9,
  "event_at_unix_nanos":1,"valid_from_unix_nanos":2,"valid_to_unix_nanos":0,
  "tombstoned":false}"#;

const STATEMENTS: &str = r#"{"statements":[
  {"statement_id":"s1","kind":"Fact","subject":"e1","predicate":"knows",
   "object":{"kind":"entity","id":"e2"},"confidence":0.9,"event_at_unix_nanos":1,
   "valid_from_unix_nanos":2,"valid_to_unix_nanos":0,"tombstoned":false},
  {"statement_id":"s2","kind":"Preference","subject":"e1","predicate":"drinks",
   "object":{"kind":"value","value":{"type":"text","value":"tea"}},"confidence":0.8,
   "event_at_unix_nanos":1,"valid_from_unix_nanos":2,"valid_to_unix_nanos":0,
   "tombstoned":false}],"count":2}"#;

/// Assert the edge saw exactly one request, and that it was `method path`.
/// `path` includes the query string, which is the point for the read routes:
/// a filter that never reaches the wire is a filter that silently does nothing.
#[track_caller]
fn assert_route(edge: &MockEdge, method: &str, path: &str) {
    let seen = edge.seen();
    assert_eq!(seen.len(), 1, "expected exactly one request");
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        (method, path)
    );
}

/// The single request's path, for the cases that assert on parts of a query
/// string rather than the whole of it.
#[track_caller]
fn path_of(edge: &MockEdge) -> String {
    let seen = edge.seen();
    assert_eq!(seen.len(), 1, "expected exactly one request");
    seen[0].path.clone()
}

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

// --- the routes added from contract/http-routes.json -----------------------
//
// One assertion per route: the method and the path the edge actually serves.
// These are transcriptions of a manifest, and a transcription error (a route
// off by a path segment, a filter that never makes it into the query string)
// is invisible without them — the mock answers everything, and a real edge
// answers a wrong path with a 404 that reads like an empty result.

#[tokio::test]
async fn memory_reads_hit_their_routes() {
    let edge = mock_edge(vec![(200, r#"{"items":[],"next_cursor":null}"#)]).await;
    client(&edge)
        .memory_list(&MemoryListQuery {
            limit: Some(2),
            dir: Some("desc".to_string()),
            ..Default::default()
        })
        .await
        .expect("memory_list");
    assert_route(&edge, "GET", "/v1/memories?limit=2&dir=desc");

    let edge = mock_edge(vec![(200, INSPECT)]).await;
    let out = client(&edge)
        .memory_inspect("m1")
        .await
        .expect("memory_inspect");
    assert_route(&edge, "GET", "/v1/memories/m1/inspect");
    assert!(out.found);
    let record = out.artifact.record.expect("record");
    assert_eq!(record.vector_dim, 768);
    assert_eq!(record.lsn, 9);
    let graph = out.artifact.graph.expect("graph");
    // `event_at_unix_nanos` skips when absent on the edge; it must decode as
    // None rather than fail the whole inspect.
    assert_eq!(graph.edges[0].event_at_unix_nanos, None);
    assert_eq!(out.artifact.keyword_fields[0].terms, ["kettle"]);
}

#[tokio::test]
async fn entity_reads_hit_their_routes() {
    let edge = mock_edge(vec![(200, ENTITIES)]).await;
    let out = client(&edge)
        .list_entities(&ListEntitiesQuery {
            prefix: Some("Ada L".to_string()),
            include_merged: Some(false),
            limit: Some(5),
            ..Default::default()
        })
        .await
        .expect("list_entities");
    assert_route(
        &edge,
        "GET",
        "/v1/entities?prefix=Ada+L&include_merged=false&limit=5",
    );
    assert_eq!(out.count, 1);
    assert_eq!(out.entities[0].canonical_name, "Ada Lovelace");
    assert_eq!(out.entities[0].aliases, ["Ada"]);
    assert_eq!(out.entities[0].merged_into, None);

    let edge = mock_edge(vec![(200, ENTITY)]).await;
    let out = client(&edge).get_entity("e1").await.expect("get_entity");
    assert_route(&edge, "GET", "/v1/entities/e1");
    assert_eq!(out.entity_type_id, 7);
    assert_eq!(out.mention_count, 3);

    let edge = mock_edge(vec![(200, r#"{"relations":[],"count":0}"#)]).await;
    client(&edge)
        .list_relations(
            "e1",
            &ListRelationsQuery {
                direction: Some("outgoing".to_string()),
                relation_type: Some("works_at".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("list_relations");
    let path = path_of(&edge);
    assert!(path.starts_with("/v1/entities/e1/relations?"), "{path}");
    // The edge reads this filter as `type`; `relation_type` is the Rust field
    // name and would be ignored on the wire.
    assert!(path.contains("type=works_at"), "{path}");
    assert!(!path.contains("relation_type="), "{path}");
}

#[tokio::test]
async fn a_default_query_sends_no_query_string() {
    // Every filter is optional, and an unset one must not be sent: the edge's
    // own default is the answer, not the zero value of the Rust type.
    let edge = mock_edge(vec![(200, ENTITIES)]).await;
    let _ = client(&edge)
        .list_entities(&ListEntitiesQuery::default())
        .await;
    assert_route(&edge, "GET", "/v1/entities");
}

#[tokio::test]
async fn a_false_flag_is_sent_rather_than_skipped() {
    // `follow_supersession` defaults to true on the edge, so a client that
    // could not send `false` could not ask for the exact row it named.
    let edge = mock_edge(vec![(200, STATEMENT)]).await;
    client(&edge)
        .get_statement(
            "s1",
            &GetStatementQuery {
                follow_supersession: Some(false),
            },
        )
        .await
        .expect("get_statement");
    assert_route(&edge, "GET", "/v1/statements/s1?follow_supersession=false");
}

#[tokio::test]
async fn an_id_cannot_reshape_the_route() {
    // Ids are caller data. Unescaped, `../` or a `?` would address a different
    // route entirely.
    let edge = mock_edge(vec![(200, ENTITY)]).await;
    client(&edge)
        .get_entity("../schema?x=1")
        .await
        .expect("get_entity");
    assert_route(&edge, "GET", "/v1/entities/%2E%2E%2Fschema%3Fx%3D1");
}

#[tokio::test]
async fn statement_and_relation_reads_hit_their_routes() {
    let edge = mock_edge(vec![(200, STATEMENTS)]).await;
    let out = client(&edge)
        .list_statements(&ListStatementsQuery {
            predicate: Some("knows".to_string()),
            only_current: Some(false),
            min_confidence: Some(0.5),
            ..Default::default()
        })
        .await
        .expect("list_statements");
    let path = path_of(&edge);
    assert!(path.starts_with("/v1/statements?"), "{path}");
    assert!(path.contains("predicate=knows"), "{path}");
    assert!(path.contains("only_current=false"), "{path}");
    assert!(path.contains("min_confidence=0.5"), "{path}");
    assert_eq!(out.count, 2);
    // The object side is a tagged union, not a string: `kind` selects the arm.
    match &out.statements[0].object {
        StatementObject::Entity { id } => assert_eq!(id, "e2"),
        other => panic!("expected an entity object, got {other:?}"),
    }
    match &out.statements[1].object {
        StatementObject::Value {
            value: StatementValue::Text { value },
        } => assert_eq!(value, "tea"),
        other => panic!("expected a text value object, got {other:?}"),
    }

    let edge = mock_edge(vec![(200, RELATION)]).await;
    let out = client(&edge)
        .get_relation("r1", &GetRelationQuery::default())
        .await
        .expect("get_relation");
    assert_route(&edge, "GET", "/v1/relations/r1");
    assert_eq!(out.relation_type, "works_at");
    assert!(!out.is_symmetric);
}

#[tokio::test]
async fn a_statement_object_is_internally_tagged() {
    // The tag sits alongside the variant's own fields rather than wrapping
    // them (`{"kind":"entity","id":"…"}`, not `{"kind":"entity","content":…}`),
    // and the tag values are snake_case — `unix_nanos`, not `unixNanos`. Every
    // arm is exercised because a mistagged one decode-fails only on the
    // statements that happen to use it.
    for (object, expect) in [
        (r#"{"kind":"entity","id":"e2"}"#, "entity e2"),
        (r#"{"kind":"memory","id":"m1"}"#, "memory m1"),
        (r#"{"kind":"statement","id":"s2"}"#, "statement s2"),
        (
            r#"{"kind":"value","value":{"type":"text","value":"tea"}}"#,
            "text tea",
        ),
        (
            r#"{"kind":"value","value":{"type":"integer","value":-7}}"#,
            "integer -7",
        ),
        (
            r#"{"kind":"value","value":{"type":"float","value":0.5}}"#,
            "float 0.5",
        ),
        (
            r#"{"kind":"value","value":{"type":"bool","value":true}}"#,
            "bool true",
        ),
        (
            r#"{"kind":"value","value":{"type":"unix_nanos","value":42}}"#,
            "unix_nanos 42",
        ),
        (
            r#"{"kind":"value","value":{"type":"blob","value":[1,2,3]}}"#,
            "blob 3",
        ),
    ] {
        let body = STATEMENT.replace(r#"{"kind":"entity","id":"e2"}"#, object);
        let edge = mock_edge(vec![(200, &body)]).await;
        let out = client(&edge)
            .get_statement("s1", &GetStatementQuery::default())
            .await
            .unwrap_or_else(|e| panic!("decode {object}: {e}"));
        let got = match &out.object {
            StatementObject::Entity { id } => format!("entity {id}"),
            StatementObject::Memory { id } => format!("memory {id}"),
            StatementObject::Statement { id } => format!("statement {id}"),
            StatementObject::Value { value } => match value {
                StatementValue::Text { value } => format!("text {value}"),
                StatementValue::Integer { value } => format!("integer {value}"),
                StatementValue::Float { value } => format!("float {value}"),
                StatementValue::Bool { value } => format!("bool {value}"),
                StatementValue::UnixNanos { value } => format!("unix_nanos {value}"),
                StatementValue::Blob { value } => format!("blob {}", value.len()),
            },
        };
        assert_eq!(got, expect);
    }
}

#[tokio::test]
async fn graph_fetch_hits_its_route() {
    let edge = mock_edge(vec![(
        200,
        r#"{"nodes":[{"id":"n1","kind":"entity","label":"Ada","type_qname":"brain:Person"}],
            "edges":[{"from_id":"n1","to_id":"n2","kind":"relation","label":"knows"}]}"#,
    )])
    .await;
    let out = client(&edge)
        .graph_fetch(&GraphFetchQuery {
            limit: Some(10),
            include_statements: Some(true),
            ..Default::default()
        })
        .await
        .expect("graph_fetch");
    assert_route(&edge, "GET", "/v1/graph?limit=10&include_statements=true");
    assert_eq!(out.nodes[0].type_qname, "brain:Person");
    assert_eq!(out.edges[0].label, "knows");
    // Absent on the last page, and absent is not an error.
    assert_eq!(out.next_cursor, None);
}

#[tokio::test]
async fn entity_writes_hit_their_routes() {
    let edge = mock_edge(vec![(200, r#"{"entity_id":"e9"}"#)]).await;
    let out = client(&edge)
        .create_entity(&CreateEntityInput {
            entity_type_id: 7,
            canonical_name: "Ada Lovelace".to_string(),
            aliases: vec!["Ada".to_string()],
        })
        .await
        .expect("create_entity");
    assert_route(&edge, "POST", "/v1/entities");
    assert!(edge.seen()[0].body.contains("Ada Lovelace"));
    assert_eq!(out.entity_id, "e9");

    let edge = mock_edge(vec![(
        200,
        r#"{"outcome":"created","tier":1,"confidence":1.0,"entity_id":"e9","candidate_ids":[]}"#,
    )])
    .await;
    let out = client(&edge)
        .resolve_entity(&ResolveEntityInput {
            candidate_name: "Ada".to_string(),
            allow_create: true,
            ..Default::default()
        })
        .await
        .expect("resolve_entity");
    assert_route(&edge, "POST", "/v1/entities/resolve");
    // Unset optional inputs stay off the wire, as everywhere else in this tier.
    let body = &edge.seen()[0].body;
    assert!(body.contains(r#""allow_create":true"#), "{body}");
    assert!(!body.contains("type_hint"), "{body}");
    assert!(!body.contains("resolution_context"), "{body}");
    assert_eq!(out.entity_id.as_deref(), Some("e9"));

    let edge = mock_edge(vec![(
        200,
        r#"{"paths":[{"steps":[{"relation_id":"r1","from":"e1","to":"e2",
            "relation_type":"knows","depth":1}]}],"total_paths":1,"truncated":false}"#,
    )])
    .await;
    let out = client(&edge)
        .traverse_relations(
            "e1",
            &TraverseInput {
                direction: "outgoing".to_string(),
                max_depth: Some(3),
                ..Default::default()
            },
        )
        .await
        .expect("traverse_relations");
    assert_route(&edge, "POST", "/v1/entities/e1/traverse");
    assert_eq!(out.total_paths, 1);
    assert_eq!(out.paths[0].steps[0].to, "e2");
}

#[tokio::test]
async fn schema_routes_are_three_verbs_on_one_path() {
    let edge = mock_edge(vec![(
        200,
        r#"{"namespace":"ns","schema_version":3,"schema_document":"entity Person",
            "uploaded_at_unix_nanos":7,"validator_version":1}"#,
    )])
    .await;
    let out = client(&edge)
        .get_schema(&SchemaGetQuery {
            namespace: Some("ns".to_string()),
            version: Some(3),
        })
        .await
        .expect("get_schema");
    assert_route(&edge, "GET", "/v1/schema?namespace=ns&version=3");
    assert_eq!(out.schema_document, "entity Person");

    let edge = mock_edge(vec![(
        200,
        r#"{"namespace":"ns","schema_version":4,"backward_compatible":true,
            "validation_errors":[]}"#,
    )])
    .await;
    client(&edge)
        .upload_schema(&SchemaUploadInput {
            schema_document: "entity Person".to_string(),
            dry_run: true,
            allow_breaking: false,
        })
        .await
        .expect("upload_schema");
    assert_route(&edge, "POST", "/v1/schema");
    let body = &edge.seen()[0].body;
    assert!(body.contains(r#""dry_run":true"#), "{body}");
    assert!(!body.contains("allow_breaking"), "{body}");

    let edge = mock_edge(vec![(
        200,
        r#"{"namespace":"ns","would_be_version":4,"validation_errors":[
            {"code":"E1","message":"bad","line":2,"column":3,"length":4,"severity":1}]}"#,
    )])
    .await;
    let out = client(&edge)
        .validate_schema(&SchemaValidateInput {
            schema_document: "entity ?".to_string(),
        })
        .await
        .expect("validate_schema");
    assert_route(&edge, "POST", "/v1/schema/validate");
    assert_eq!(out.validation_errors[0].line, 2);
    assert_eq!(out.validation_errors[0].severity, 1);

    let edge = mock_edge(vec![(
        200,
        r#"{"namespace":"ns","schema_version":5,"dropped_count":12,"validation_errors":[]}"#,
    )])
    .await;
    let out = client(&edge)
        .replace_schema(&SchemaReplaceInput {
            schema_document: "entity Person".to_string(),
            force_drop_existing: true,
        })
        .await
        .expect("replace_schema");
    assert_route(&edge, "PUT", "/v1/schema");
    assert!(edge.seen()[0]
        .body
        .contains(r#""force_drop_existing":true"#));
    assert_eq!(out.dropped_count, 12);
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
    let err = BrainHttpClient::new(API_KEY, "http://127.0.0.1:1")
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
async fn the_new_routes_retry_by_idempotence_not_by_verb() {
    let unavailable = r#"{"error":{"code":"unavailable","message":"shard restarting"}}"#;

    // A read: retried like the other GETs.
    let edge = mock_edge(vec![(503, unavailable), (200, ENTITIES)]).await;
    client(&edge)
        .list_entities(&ListEntitiesQuery::default())
        .await
        .expect("retry then succeed");
    assert_eq!(edge.seen().len(), 2, "a read must be retried");

    // A dry run: a POST that changes nothing, so repeating it is free.
    let edge = mock_edge(vec![
        (503, unavailable),
        (
            200,
            r#"{"namespace":"ns","would_be_version":4,"validation_errors":[]}"#,
        ),
    ])
    .await;
    client(&edge)
        .validate_schema(&SchemaValidateInput {
            schema_document: "entity Person".to_string(),
        })
        .await
        .expect("retry then succeed");
    assert_eq!(
        edge.seen().len(),
        2,
        "validate is a dry run and must be retried"
    );

    // A write: one attempt, whatever the status.
    let edge = mock_edge(vec![(503, unavailable); 3]).await;
    let err = client(&edge)
        .create_entity(&CreateEntityInput::default())
        .await
        .expect_err("must fail");
    assert_eq!(err.status, 503);
    assert_eq!(edge.seen().len(), 1, "a write must not be retried");

    // The destructive one, most of all: a retried replace would drop the rows
    // the first attempt just wrote.
    let edge = mock_edge(vec![(503, unavailable); 3]).await;
    let err = client(&edge)
        .replace_schema(&SchemaReplaceInput {
            schema_document: "entity Person".to_string(),
            force_drop_existing: true,
        })
        .await
        .expect_err("must fail");
    assert_eq!(err.status, 503);
    assert_eq!(edge.seen().len(), 1, "replace_schema must never be retried");
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
