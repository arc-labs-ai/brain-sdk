//! Every HTTP verb, against a running edge, success paths and failure paths.
//!
//! Set `BRAIN_SDK_IT_HTTP` and `BRAIN_SDK_IT_HTTP_KEY` (or
//! `BRAIN_SDK_IT_API_KEY`) to run these. `BRAIN_SDK_IT_REQUIRED=1` turns a
//! missing configuration into a failure, which is what CI wants — a silent
//! skip is how a live suite rots without anyone noticing.
//!
//! # Why this exists alongside `http_edge.rs`
//!
//! That file covers six verbs: whoami, capabilities, encode, recall,
//! memory_list, forget. The client exposes **25**, and the nineteen with no
//! live coverage are exactly where the drift has been found — `include_trace`
//! and the list cursors shipped in one SDK only, and nothing exercising them
//! end to end would have said so.
//!
//! # Failures are asserted, not avoided
//!
//! Half of what an SDK owes its caller is a legible error: the right status, a
//! code to branch on, and no retry of a request that cannot succeed. Each
//! failure below pins a status observed against a real server.

use std::env;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::{Mutex, MutexGuard};

use brain_db_sdk::http::{
    BrainHttpClient, CreateEntityInput, EncodeInput, Endpoint, ForgetInput, GetRelationQuery,
    GetStatementQuery, GraphFetchQuery, HttpRetryPolicy, LinkInput, ListEntitiesQuery,
    ListRelationsQuery, ListStatementsQuery, MemoryListQuery, PlanInput, ReasonInput, RecallInput,
    ResolveEntityInput, SchemaGetQuery, SchemaValidateInput, TraverseInput, UnlinkInput,
};

/// `1` is Person in the stock schema. `list_entities` REQUIRES a type filter
/// — the edge answers 400 without one — so this is not cosmetic.
const PERSON_TYPE_ID: u32 = 1;

/// Syntactically valid and certainly absent.
const ABSENT_UUID: &str = "00000000-0000-0000-0000-000000000000";

/// A client tuned for a LIVE suite, not for a hot path.
///
/// The plan's ceiling is 60 requests/minute on Free (`arc_entitlements`), and
/// an all-operations pass makes more than that — so being throttled part-way
/// through is the normal case, not an error. The server answers 429 with
/// `Retry-After`; the default policy clamps that hint to `max_delay` (2s),
/// far short of a 60s fixed window, so the retries burn out and the suite
/// fails on a condition that would have cleared by itself. Raising the cap
/// past the window lets the hint through, which turns throttling into a pause
/// — and exercises the 429 retry path against a real server while it is at it.
fn client() -> Option<BrainHttpClient> {
    let base_url = env::var("BRAIN_SDK_IT_HTTP").ok();
    let api_key = env::var("BRAIN_SDK_IT_HTTP_KEY")
        .or_else(|_| env::var("BRAIN_SDK_IT_API_KEY"))
        .ok();
    match (base_url, api_key) {
        (Some(base_url), Some(api_key)) => Some(
            BrainHttpClient::new(api_key, base_url).with_retry_policy(HttpRetryPolicy::new(
                4,
                Duration::from_millis(500),
                Duration::from_secs(70),
            )),
        ),
        _ if env::var("BRAIN_SDK_IT_REQUIRED").as_deref() == Ok("1") => {
            panic!("live edge tests require BRAIN_SDK_IT_HTTP and BRAIN_SDK_IT_HTTP_KEY");
        }
        _ => None,
    }
}

/// Serialises the tests in this file.
///
/// `cargo test` runs test functions on a thread pool, and a dozen of them at
/// once against ONE Brain is not a shape any caller produces: it saturates
/// the engine (`plan` came back 503) and burns the plan's 60 requests/minute
/// in a few seconds, so the suite failed on contention it created itself.
/// Requiring `--test-threads=1` on the command line fixes that only for the
/// person who remembers to type it, so the file holds the line itself.
///
/// The lock is recovered on poisoning: a panic in one test is that test's
/// failure to report, not a reason for every later one to fail differently.
/// An ASYNC mutex, because the guard is held across the test's awaits — a
/// `std::sync` guard there is exactly the hazard clippy names, and it cannot
/// be poisoned by a panicking test either.
async fn serial() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn unique(prefix: &str) -> String {
    format!("{prefix} {}", uuid::Uuid::now_v7())
}

/// Store one memory, run `body`, then forget it — so the suite is re-runnable
/// and leaves the namespace as it found it.
async fn with_memory<F, Fut>(client: &BrainHttpClient, body: F)
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let text = unique("all-ops probe: Dana prefers dark mode in the editor.");
    let created = client
        .encode(&EncodeInput {
            text: text.clone(),
            ..Default::default()
        })
        .await
        .expect("encode");
    let id = created.memory_id.clone();
    body(id.clone(), text).await;
    client
        .forget(&ForgetInput {
            memory_id: id,
            hard: false,
        })
        .await
        .expect("forget");
}

// ── identity ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn whoami_reports_named_permission_flags() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let me = client.whoami().await.expect("whoami");
    assert_ne!(me.namespace, "");
    assert_ne!(me.space_id, "");
    // Named flags, not a bitset. The gateway served the latter for a while and
    // this client could not deserialize it at all.
    let _: bool = me.permissions.can_encode;
    let _: bool = me.permissions.can_recall;
}

#[tokio::test]
async fn capabilities_describes_the_shard() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let caps = client.capabilities().await.expect("capabilities");
    assert!(caps.vector_dim > 0);
}

// ── memory lifecycle ────────────────────────────────────────────────────────

#[tokio::test]
async fn encode_recall_inspect_and_list() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let c = &client;
    with_memory(c, |id, text| async move {
        let answer = c
            .recall(&RecallInput {
                query: text,
                max_results: Some(5),
                ..Default::default()
            })
            .await
            .expect("recall");
        assert!(["single", "many", "none"].contains(&answer.answer_kind.as_str()));
        assert!(answer.memories.iter().any(|m| m.memory_id == id));

        let inspected = c.memory_inspect(&id).await.expect("inspect");
        assert!(inspected.found);

        let page = c
            .memory_list(&MemoryListQuery {
                limit: Some(100),
                ..Default::default()
            })
            .await
            .expect("list");
        assert!(page.items.iter().any(|m| m.memory_id == id));
    })
    .await;
}

#[tokio::test]
async fn recall_returns_the_pipeline_trace_when_asked() {
    // `include_trace` was TypeScript-only until recently; this is the live
    // proof that the field reaches the server and the trace comes back.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let c = &client;
    with_memory(c, |_id, text| async move {
        let answer = c
            .recall(&RecallInput {
                query: text,
                max_results: Some(5),
                include_trace: Some(true),
                ..Default::default()
            })
            .await
            .expect("recall with trace");
        let trace = answer
            .trace
            .expect("include_trace was requested but no trace came back");
        // A JSON STRING, not a parsed value: the ids inside are 128-bit and a
        // JSON number would round them.
        serde_json::from_str::<serde_json::Value>(&trace).expect("trace is JSON");
    })
    .await;
}

#[tokio::test]
async fn recall_omits_the_trace_by_default() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let c = &client;
    with_memory(c, |_id, text| async move {
        let answer = c
            .recall(&RecallInput {
                query: text,
                max_results: Some(1),
                ..Default::default()
            })
            .await
            .expect("recall");
        assert!(answer.trace.is_none());
    })
    .await;
}

#[tokio::test]
async fn encoding_the_same_text_twice_deduplicates() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let text = unique("all-ops dedup");
    let first = client
        .encode(&EncodeInput {
            text: text.clone(),
            ..Default::default()
        })
        .await
        .expect("encode");
    let second = client
        .encode(&EncodeInput {
            text,
            ..Default::default()
        })
        .await
        .expect("encode again");
    assert!(second.was_deduplicated);
    assert_eq!(second.memory_id, first.memory_id);

    client
        .forget(&ForgetInput {
            memory_id: first.memory_id,
            hard: false,
        })
        .await
        .expect("forget");
}

#[tokio::test]
async fn forget_is_idempotent() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let created = client
        .encode(&EncodeInput {
            text: unique("all-ops forget"),
            ..Default::default()
        })
        .await
        .expect("encode");
    let forget = |id: String| {
        let client = &client;
        async move {
            client
                .forget(&ForgetInput {
                    memory_id: id,
                    hard: false,
                })
                .await
                .expect("forget")
        }
    };
    assert!(!forget(created.memory_id.clone()).await.was_already_forgotten);
    assert!(forget(created.memory_id).await.was_already_forgotten);
}

// ── links ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn link_and_unlink_two_memories() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let encode = |text: String| {
        let client = &client;
        async move {
            client
                .encode(&EncodeInput {
                    text,
                    ..Default::default()
                })
                .await
                .expect("encode")
        }
    };
    let a = encode(unique("all-ops link source")).await;
    let b = encode(unique("all-ops link target")).await;

    let linked = client
        .link(&LinkInput {
            source: a.memory_id.clone(),
            target: b.memory_id.clone(),
            kind: "caused".into(),
            weight: None,
        })
        .await
        .expect("link");
    assert_eq!(linked.source, a.memory_id);

    let unlinked = client
        .unlink(&UnlinkInput {
            source: a.memory_id.clone(),
            target: b.memory_id.clone(),
            kind: "caused".into(),
        })
        .await
        .expect("unlink");
    assert!(unlinked.removed);

    for id in [a.memory_id, b.memory_id] {
        client
            .forget(&ForgetInput {
                memory_id: id,
                hard: false,
            })
            .await
            .expect("forget");
    }
}

// ── typed graph: reads ──────────────────────────────────────────────────────

#[tokio::test]
async fn graph_fetch_returns_a_page() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let page = client
        .graph_fetch(&GraphFetchQuery::default())
        .await
        .expect("graph fetch");
    let _ = page.nodes.len();
    let _ = page.edges.len();
}

#[tokio::test]
async fn list_entities_pages_with_a_cursor() {
    // The cursor fields were TypeScript-only: Rust callers could read the
    // first page and had no way to ask for the next.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let query = |cursor: Option<String>| ListEntitiesQuery {
        type_id: Some(PERSON_TYPE_ID),
        limit: Some(1),
        cursor,
        ..Default::default()
    };
    let page = client.list_entities(&query(None)).await.expect("list");
    if let Some(cursor) = page.next_cursor.clone() {
        let next = client
            .list_entities(&query(Some(cursor)))
            .await
            .expect("list next page");
        for entity in &next.entities {
            assert!(
                !page.entities.iter().any(|e| e.entity_id == entity.entity_id),
                "the second page repeated a row from the first"
            );
        }
    }
}

#[tokio::test]
async fn entity_and_statement_read_verbs() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let page = client
        .list_entities(&ListEntitiesQuery {
            type_id: Some(PERSON_TYPE_ID),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .expect("list entities");

    if let Some(entity) = page.entities.first() {
        let detail = client.get_entity(&entity.entity_id).await.expect("get");
        assert_eq!(detail.entity_id, entity.entity_id);

        let traversed = client
            .traverse_relations(&entity.entity_id, &TraverseInput::default())
            .await
            .expect("traverse");
        let _ = traversed.paths.len();

        let relations = client
            .list_relations(&entity.entity_id, &ListRelationsQuery::default())
            .await
            .expect("list relations");
        if let Some(relation) = relations.relations.first() {
            let fetched = client
                .get_relation(&relation.relation_id, &GetRelationQuery::default())
                .await
                .expect("get relation");
            assert_eq!(fetched.relation_id, relation.relation_id);
        }

        let resolved = client
            .resolve_entity(&ResolveEntityInput {
                candidate_name: entity.canonical_name.clone(),
                ..Default::default()
            })
            .await
            .expect("resolve");
        assert_ne!(resolved.outcome, "");
    }

    let statements = client
        .list_statements(&ListStatementsQuery {
            limit: Some(5),
            ..Default::default()
        })
        .await
        .expect("list statements");
    if let Some(statement) = statements.statements.first() {
        let fetched = client
            .get_statement(&statement.statement_id, &GetStatementQuery::default())
            .await
            .expect("get statement");
        assert_eq!(fetched.statement_id, statement.statement_id);
    }
}

/// The gateway resolves `subject_name` / `object_name` so a caller does not
/// have to. No SDK exposed them, so every consumer re-queried each id just to
/// print a name — the second call the field exists to remove.
#[tokio::test]
async fn statements_carry_the_display_names_the_server_resolved() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let page = client
        .list_statements(&ListStatementsQuery {
            limit: Some(5),
            ..Default::default()
        })
        .await
        .expect("list statements");
    if page.statements.is_empty() {
        return;
    }
    assert!(
        page.statements.iter().any(|s| s.subject_name.is_some()),
        "the server sends subject_name for a resolvable subject; the SDK must surface it"
    );
}

// ── typed graph: writes ─────────────────────────────────────────────────────

#[tokio::test]
async fn create_entity_then_read_it_back() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let name = format!("AllOps {}", &uuid::Uuid::now_v7().to_string()[..12]);
    let created = client
        .create_entity(&CreateEntityInput {
            entity_type_id: PERSON_TYPE_ID,
            canonical_name: name.clone(),
            ..Default::default()
        })
        .await
        .expect("create entity");
    let detail = client.get_entity(&created.entity_id).await.expect("get");
    assert_eq!(
        detail.canonical_name.to_lowercase(),
        name.to_lowercase(),
        "the entity read back under a different name"
    );
}

#[tokio::test]
async fn a_duplicate_entity_name_is_a_conflict_not_a_server_fault() {
    // 409, not 502. The engine reports a duplicate as an internal error and
    // the gateway used to pass it through — blaming the engine for the
    // caller's mistake AND putting it in the retryable class, so the retry
    // policy re-sent a request that could never succeed.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let name = format!("AllOps Dup {}", &uuid::Uuid::now_v7().to_string()[..12]);
    let input = CreateEntityInput {
        entity_type_id: PERSON_TYPE_ID,
        canonical_name: name,
        ..Default::default()
    };
    client.create_entity(&input).await.expect("first create");
    let err = client
        .create_entity(&input)
        .await
        .expect_err("a duplicate canonical name must be refused");
    assert_eq!(err.status, 409, "{err}");
}

// ── reasoning ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn plan_and_reason() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let c = &client;
    with_memory(c, |_id, text| async move {
        let plan = c
            .plan(&PlanInput {
                start: Endpoint::text(text.clone()),
                goal: Endpoint::text("editor preference"),
                ..Default::default()
            })
            .await
            .expect("plan");
        let _ = plan.steps.len();

        let reasoned = c
            .reason(&ReasonInput {
                observation: Endpoint::text(text),
                ..Default::default()
            })
            .await
            .expect("reason");
        let _ = reasoned.inferences.len();
    })
    .await;
}

// ── schema ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn get_schema_is_either_a_document_or_a_clean_404() {
    // A namespace with no schema is a normal state, not a fault — so the shape
    // of BOTH answers is asserted rather than one being required.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    match client.get_schema(&SchemaGetQuery::default()).await {
        Ok(schema) => assert_ne!(schema.namespace, ""),
        Err(err) => assert_eq!(err.status, 404, "{err}"),
    }
}

#[tokio::test]
async fn validate_schema_rejects_a_malformed_document() {
    // `validate` is the one schema verb safe to exercise for real: `upload`
    // merges and `replace` DROPS every declaration the document omits, so
    // neither is run against a live namespace from a test suite.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let result = client
        .validate_schema(&SchemaValidateInput {
            schema_document: "this is not a schema".into(),
        })
        .await
        .expect("validate reports problems in the body, not as an HTTP error");
    assert!(
        !result.validation_errors.is_empty(),
        "a document that cannot be parsed must come back with validation errors"
    );
}

// ── failures ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_rejected_key_is_401() {
    let _serial = serial().await;
    let Some(base_url) = env::var("BRAIN_SDK_IT_HTTP").ok() else {
        return;
    };
    // Deliberately NOT the patient policy: a 401 is terminal, and retrying it
    // would only slow the suite down to prove the same thing.
    let bad = BrainHttpClient::new("brain_not_a_real_key", base_url)
        .with_retry_policy(HttpRetryPolicy::none());
    let err = bad.whoami().await.expect_err("a bad key must be refused");
    assert_eq!(err.status, 401, "{err}");
}

#[tokio::test]
async fn an_empty_query_is_refused() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let err = client
        .recall(&RecallInput {
            query: "   ".into(),
            ..Default::default()
        })
        .await
        .expect_err("an empty query must be refused");
    assert!([400, 422].contains(&err.status), "{err}");
}

#[tokio::test]
async fn listing_entities_without_a_type_is_refused() {
    // Brain requires the type filter; the SDK makes it optional, so the
    // refusal has to be legible rather than a surprise 500.
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let err = client
        .list_entities(&ListEntitiesQuery::default())
        .await
        .expect_err("a missing type filter must be refused");
    assert_eq!(err.status, 400, "{err}");
}

#[tokio::test]
async fn an_unknown_entity_is_404_and_carries_a_code() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    let err = client
        .get_entity(ABSENT_UUID)
        .await
        .expect_err("an absent entity must be a 404");
    assert_eq!(err.status, 404, "{err}");
    // The caller branches on this. An error with only a message forces
    // string-matching, which is how error handling rots.
    assert_ne!(err.code, "");
}

#[tokio::test]
async fn unknown_memories_are_reported_without_erroring() {
    let _serial = serial().await;
    let Some(client) = client() else { return };
    // `inspect` answers 200 with `found: false` rather than 404 — it is a
    // debugging view, and "no such memory" is one of its answers.
    let inspected = client.memory_inspect("1").await.expect("inspect");
    assert!(!inspected.found);

    let forgotten = client
        .forget(&ForgetInput {
            memory_id: "1".into(),
            hard: false,
        })
        .await
        .expect("forget");
    assert!(forgotten.was_already_forgotten);
}
