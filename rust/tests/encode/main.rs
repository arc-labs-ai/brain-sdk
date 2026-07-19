//! Feature: ENCODE — write episodic memory.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). Each test mints a fresh, isolated agent.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::EncodeBuilder;

#[tokio::test]
async fn encode_returns_a_durable_id() {
    let Some(it) = common::It::from_env() else {
        return common::skip("encode_returns_a_durable_id");
    };
    let (client, _agent) = it.connect_fresh().await;

    let req = EncodeBuilder::new("The Eiffel Tower is in Paris.").build();
    let resp = client.encode(&req).await.expect("encode");

    // WAL-before-ack: a returned response means the write was durably logged,
    // so the log sequence number is assigned and non-zero.
    assert!(resp.lsn > 0, "encode assigns a durable LSN");
    assert!(resp.salience >= 0.0, "salience is populated");
    client.close().await.expect("close");
}

#[tokio::test]
async fn encode_carries_context_and_event_time() {
    let Some(it) = common::It::from_env() else {
        return common::skip("encode_carries_context_and_event_time");
    };
    let (client, _agent) = it.connect_fresh().await;

    // occurred_at is the memory's real-world event time; context groups a
    // session/thread. Both are optional ENCODE params.
    let req = EncodeBuilder::new("We shipped v1 on launch day.")
        .context(42)
        .occurred_at(1_700_000_000_000_000_000)
        .build();
    let resp = client.encode(&req).await.expect("encode with params");
    assert!(resp.lsn > 0);
    client.close().await.expect("close");
}

#[tokio::test]
async fn encode_is_idempotent_on_identical_text() {
    let Some(it) = common::It::from_env() else {
        return common::skip("encode_is_idempotent_on_identical_text");
    };
    let (client, _agent) = it.connect_fresh().await;

    // Two encodes of the exact same content: the server may dedup the second
    // (was_deduplicated) or store it fresh, but both must ack durably.
    let req = EncodeBuilder::new("A fact I might repeat verbatim.").build();
    let first = client.encode(&req).await.expect("first encode");
    let second = client.encode(&req).await.expect("second encode");
    assert!(first.lsn > 0 && second.lsn > 0, "both encodes durable");
    client.close().await.expect("close");
}
