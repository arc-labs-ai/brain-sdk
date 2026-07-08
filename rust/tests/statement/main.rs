//! Feature: typed-graph STATEMENT lifecycle — create → supersede → history →
//! tombstone / retract.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). Each test mints a fresh, isolated agent and its own
//! subject entity, so the version chain it inspects is entirely its own.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{
    EntityCreateRequest, EvidenceRefWire, StatementCreateRequest, StatementHistoryRequest,
    StatementKindWire, StatementObjectWire, StatementRetractRequest, StatementSupersedeRequest,
    StatementTombstoneRequest, StatementValueWire, WireUuid,
};

async fn subject_entity(client: &brain_db_sdk::BrainClient) -> WireUuid {
    client
        .create_entity(&EntityCreateRequest {
            entity_type_id: 1,
            canonical_name: "Ada".to_string(),
            aliases: vec![],
            attributes_blob: vec![],
            request_id: new_id(),
        })
        .await
        .expect("create subject entity")
        .entity_id
}

fn fact(subject: WireUuid, object: &str) -> StatementCreateRequest {
    StatementCreateRequest {
        kind: StatementKindWire::Fact,
        subject,
        predicate: "org:works_on".to_string(),
        object: StatementObjectWire::Value(StatementValueWire::Text(object.to_string())),
        confidence: 0.9,
        evidence: EvidenceRefWire::Inline(vec![]),
        extractor_id: 0,
        valid_from_unix_nanos: 0,
        valid_to_unix_nanos: u64::MAX,
        event_at_unix_nanos: 0,
        schema_version: 1,
        request_id: new_id(),
    }
}

#[tokio::test]
async fn supersede_builds_a_history_chain() {
    let Some(it) = common::It::from_env() else {
        return common::skip("supersede_builds_a_history_chain");
    };
    let (client, _agent) = it.connect_fresh().await;
    let subject = subject_entity(&client).await;

    let first = client.create_statement(&fact(subject, "brain")).await.expect("create");

    // SUPERSEDE revises the claim; both stay linked on one chain.
    let superseded = client
        .supersede_statement(&StatementSupersedeRequest {
            old_statement_id: first.statement_id,
            new_statement: fact(subject, "brain-db"),
            request_id: new_id(),
        })
        .await
        .expect("supersede");
    assert_eq!(superseded.chain_root, first.chain_root, "same supersession chain");
    assert!(superseded.version >= 2, "the revision is a later version");

    // HISTORY walks every version on that chain.
    let history = client
        .statement_history(&StatementHistoryRequest {
            anchor_id: first.statement_id,
            include_tombstoned: true,
        })
        .await
        .expect("history");
    assert!(history.len() >= 2, "history carries both versions, got {}", history.len());

    // Deep check: the chain actually holds *both* object values we wrote, not
    // just two rows — proving supersede revised content rather than duplicating.
    let objects: Vec<String> = history
        .iter()
        .filter_map(|s| match &s.object {
            StatementObjectWire::Value(StatementValueWire::Text(t)) => Some(t.clone()),
            _ => None,
        })
        .collect();
    assert!(objects.iter().any(|o| o == "brain"), "history retains the original object");
    assert!(objects.iter().any(|o| o == "brain-db"), "history retains the revised object");
    client.close().await.expect("close");
}

#[tokio::test]
async fn tombstone_and_retract_are_accepted() {
    let Some(it) = common::It::from_env() else {
        return common::skip("tombstone_and_retract_are_accepted");
    };
    let (client, _agent) = it.connect_fresh().await;
    let subject = subject_entity(&client).await;

    let a = client.create_statement(&fact(subject, "one")).await.expect("create a");
    let ts = client
        .tombstone_statement(&StatementTombstoneRequest {
            statement_id: a.statement_id,
            reason: 1,
            reason_message: "superseded by hand".to_string(),
            request_id: new_id(),
        })
        .await
        .expect("tombstone");
    assert!(ts.tombstoned_at_unix_nanos > 0);

    let b = client.create_statement(&fact(subject, "two")).await.expect("create b");
    let rt = client
        .retract_statement(&StatementRetractRequest {
            statement_id: b.statement_id,
            reason: 1,
            reason_message: "was wrong".to_string(),
            request_id: new_id(),
        })
        .await
        .expect("retract");
    // Retraction schedules a hard-zero strictly after it retracts.
    assert!(rt.will_zero_at_unix_nanos >= rt.retracted_at_unix_nanos);
    client.close().await.expect("close");
}
