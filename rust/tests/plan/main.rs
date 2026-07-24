//! Feature: PLAN — goal-directed traversal over the memory/graph space.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). These assert the end-to-end wire contract:
//! the request is accepted with each parameter shape and a well-formed
//! (possibly empty) step list comes back. Depth-of-path assertions need a
//! pre-built edge graph and live with the graph feature folders.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::{PlanBudget, PlanRequest, PlanState, PlanStrategy};
use brain_db_sdk::EncodeBuilder;

/// The server caps `budget.max_steps` at its configured `max_traversal_depth`
/// (10 by default) and rejects anything larger with a validation error, so a
/// realistic budget stays at or under that bound.
const MAX_STEPS: u32 = 8;

fn budget() -> PlanBudget {
    PlanBudget {
        max_steps: MAX_STEPS,
        max_wall_time_ms: 5_000,
        max_branches_explored: 256,
    }
}

#[tokio::test]
async fn plan_between_two_memories_round_trips() {
    let Some(it) = common::It::from_env() else {
        return common::skip("plan_between_two_memories_round_trips");
    };
    let (client, _agent) = it.connect_fresh().await;

    let start = client
        .encode(&EncodeBuilder::new("Start: I am in Paris.").build())
        .await
        .expect("encode start")
        .memory_id;
    let goal = client
        .encode(&EncodeBuilder::new("Goal: I want to reach Rome.").build())
        .await
        .expect("encode goal")
        .memory_id;

    let req = PlanRequest {
        act_as: None,
        start: PlanState::ByMemoryId(start),
        goal: PlanState::ByMemoryId(goal),
        budget: budget(),
        strategy_hint: Some(PlanStrategy::Auto),
        session_filter: None,
        request_id: None,
        txn_id: None,
        trace: false,
    };
    // A path may or may not exist between two unlinked memories; either way the
    // server answers with a well-formed step list rather than erroring.
    let steps = client.plan(&req).await.expect("plan by memory id");
    for (i, step) in steps.iter().enumerate() {
        assert_eq!(
            step.step_index as usize, i,
            "steps are contiguously indexed"
        );
    }
    client.close().await.expect("close");
}

#[tokio::test]
async fn plan_to_text_goal_with_astar_round_trips() {
    let Some(it) = common::It::from_env() else {
        return common::skip("plan_to_text_goal_with_astar_round_trips");
    };
    let (client, _agent) = it.connect_fresh().await;

    let start = client
        .encode(&EncodeBuilder::new("The project kicked off in January.").build())
        .await
        .expect("encode")
        .memory_id;

    // ByText goal + an explicit A* strategy hint: exercises the alternate
    // PlanState shape and the strategy parameter.
    let req = PlanRequest {
        act_as: None,
        start: PlanState::ByMemoryId(start),
        goal: PlanState::ByText("the project shipped".to_string()),
        budget: budget(),
        strategy_hint: Some(PlanStrategy::AStar),
        session_filter: Some(vec![1]),
        request_id: None,
        txn_id: None,
        trace: false,
    };
    let _steps = client.plan(&req).await.expect("plan to text goal");
    client.close().await.expect("close");
}

#[tokio::test]
async fn plan_rejects_budget_over_max_traversal_depth() {
    let Some(it) = common::It::from_env() else {
        return common::skip("plan_rejects_budget_over_max_traversal_depth");
    };
    let (client, _agent) = it.connect_fresh().await;

    let start = client
        .encode(&EncodeBuilder::new("anywhere").build())
        .await
        .expect("encode")
        .memory_id;

    // A budget above the server's max_traversal_depth (10) is a validation
    // error, not a silent clamp — this test pins that documented limit.
    let over = PlanRequest {
        act_as: None,
        start: PlanState::ByMemoryId(start),
        goal: PlanState::ByText("somewhere".to_string()),
        budget: PlanBudget {
            max_steps: 11,
            max_wall_time_ms: 5_000,
            max_branches_explored: 256,
        },
        strategy_hint: Some(PlanStrategy::Auto),
        session_filter: None,
        request_id: None,
        txn_id: None,
        trace: false,
    };
    let err = client
        .plan(&over)
        .await
        .expect_err("over-depth budget is rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("max_steps") || msg.contains("max_traversal_depth"),
        "rejection names the offending budget bound: {msg}"
    );
    client.close().await.expect("close");
}
