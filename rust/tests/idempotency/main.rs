//! Feature: idempotency by request id — replaying a write with the same
//! `request_id` returns the cached response, not a second row.
//!
//! This exercises core invariant #5 (idempotency by RequestId) end-to-end,
//! which is what makes at-least-once client retries safe. Integration only;
//! gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`).

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::EntityCreateRequest;
use brain_db_sdk::EncodeBuilder;

#[tokio::test]
async fn repeated_encode_is_idempotent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("repeated_encode_is_idempotent");
    };
    let (client, _agent) = it.connect_fresh().await;

    // One request value (so one request_id) sent twice: a retry, not a new write.
    let req = EncodeBuilder::new("A memory that must not double on retry.").build();
    let first = client.encode(&req).await.expect("first encode");
    let second = client.encode(&req).await.expect("retry encode");
    assert_eq!(
        first.memory_id, second.memory_id,
        "same request_id must return the same memory, not a second row"
    );
    assert_eq!(
        first.lsn, second.lsn,
        "the retry replays the cached response"
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn repeated_create_entity_is_idempotent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("repeated_create_entity_is_idempotent");
    };
    let (client, _agent) = it.connect_fresh().await;

    let req = EntityCreateRequest {
        act_as: None,
        entity_type_id: 1,
        canonical_name: "Idempotent Ada".to_string(),
        aliases: vec![],
        attributes_blob: vec![],
        session_id: 0,
        request_id: new_id(),
    };
    let first = client.create_entity(&req).await.expect("first create");
    let second = client.create_entity(&req).await.expect("retry create");
    assert_eq!(
        first.entity_id, second.entity_id,
        "same request_id must resolve to the same entity"
    );
    client.close().await.expect("close");
}
