//! Feature: REASON — abductive/deductive inference over the graph from an
//! observation.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). These assert the end-to-end wire contract
//! across the REASON parameters (observation shape, depth, thresholds,
//! budgets). Inference-content assertions need a populated statement/relation
//! graph and live with the graph feature folders.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::{ObservationInput, ReasonRequest};
use brain_db_sdk::EncodeBuilder;

#[tokio::test]
async fn reason_from_text_observation_round_trips() {
    let Some(it) = common::It::from_env() else {
        return common::skip("reason_from_text_observation_round_trips");
    };
    let (client, _agent) = it.connect_fresh().await;

    let req = ReasonRequest {
        observation: ObservationInput::ByText("the lights are off".to_string()),
        depth: 4,
        confidence_threshold: 0.6,
        context_filter: None,
        max_inferences: 32,
        budget_wall_time_ms: 2_000,
        request_id: None,
        txn_id: None,
    };
    // The contract under test is that the server accepts every parameter and
    // returns a well-formed list, capped by max_inferences. Note:
    // `confidence_threshold` gates *traversal* (which premises reasoning will
    // follow), not the *output* — returned inferences can carry a computed
    // confidence below it, so we don't assert a floor on step.confidence here.
    let inferences = client.reason(&req).await.expect("reason by text");
    assert!(
        inferences.len() <= 32,
        "server honors the max_inferences cap: got {}",
        inferences.len()
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn reason_from_memory_observation_round_trips() {
    let Some(it) = common::It::from_env() else {
        return common::skip("reason_from_memory_observation_round_trips");
    };
    let (client, _agent) = it.connect_fresh().await;

    let obs = client
        .encode(&EncodeBuilder::new("The server returned a 500 error.").build())
        .await
        .expect("encode observation")
        .memory_id;

    let req = ReasonRequest {
        observation: ObservationInput::ByMemoryId(obs),
        depth: 2,
        confidence_threshold: 0.0,
        context_filter: Some(vec![9]),
        max_inferences: 8,
        budget_wall_time_ms: 1_000,
        request_id: None,
        txn_id: None,
    };
    let inferences = client.reason(&req).await.expect("reason by memory id");
    assert!(
        inferences.len() <= 8,
        "server honors the max_inferences cap: got {}",
        inferences.len()
    );
    client.close().await.expect("close");
}
