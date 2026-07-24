//! Feature: QUERY introspection debug surface — explain (plan) and trace
//! (execution).
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). Each test mints a fresh, isolated agent.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::{
    QueryExplainRequest, QueryRequest, QueryTraceRequest, RetrieverSelectionWire,
};
use brain_db_sdk::{new_id, EncodeBuilder};

fn query(text: &str) -> QueryRequest {
    QueryRequest {
        text: text.to_string(),
        entity_anchor: None,
        kind_filter: vec![],
        predicate_filter: vec![],
        time_filter: None,
        as_of_record_time_unix_nanos: None,
        confidence_min: None,
        include_tombstoned: false,
        include_superseded: false,
        limit: 10,
        retrievers: RetrieverSelectionWire::Auto,
        fusion_config: None,
        request_id: new_id(),
    }
}

#[tokio::test]
async fn explain_returns_a_plan() {
    let Some(it) = common::It::from_env() else {
        return common::skip("explain_returns_a_plan");
    };
    let (client, _agent) = it.connect_fresh().await;

    let resp = client
        .query_explain(&QueryExplainRequest {
            query: query("coffee"),
        })
        .await
        .expect("query_explain");
    assert!(
        !resp.plan_text.is_empty(),
        "explain returns a non-empty plan"
    );
    assert!(resp.estimated_cost_ms >= 0.0);
    client.close().await.expect("close");
}

#[tokio::test]
async fn trace_returns_an_execution_trace() {
    let Some(it) = common::It::from_env() else {
        return common::skip("trace_returns_an_execution_trace");
    };
    let (client, _agent) = it.connect_fresh().await;
    client
        .encode(&EncodeBuilder::new("Espresso is a concentrated coffee.").build())
        .await
        .expect("encode");

    let resp = client
        .query_trace(&QueryTraceRequest {
            query: query("coffee"),
        })
        .await
        .expect("query_trace");
    assert!(
        !resp.trace_text.is_empty(),
        "trace returns a non-empty trace"
    );
    assert!(resp.total_latency_ms >= 0.0);
    client.close().await.expect("close");
}
