//! Feature: FORGET — retire episodic memory.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). Soft FORGET tombstones (invisible to recall,
//! recoverable through the grace window); hard FORGET zeroes the slot now.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::ForgetMode;
use brain_db_sdk::{EncodeBuilder, ForgetBuilder, RecallBuilder};

#[tokio::test]
async fn soft_forget_removes_from_recall() {
    let Some(it) = common::It::from_env() else {
        return common::skip("soft_forget_removes_from_recall");
    };
    let (client, _agent) = it.connect_fresh().await;

    let enc = EncodeBuilder::new("The meeting is scheduled for Tuesday.").build();
    let id = client.encode(&enc).await.expect("encode").memory_id;

    // First wait until it is actually recallable, so the post-forget assertion
    // is meaningful (not vacuously true because the index lagged).
    let rec = RecallBuilder::new("When is the meeting?").include_text(true).build();
    let before = common::recall_until(&client, &rec, |a| {
        a.memories().iter().any(|m| m.memory_id == id)
    })
    .await;
    assert!(
        before.memories().iter().any(|m| m.memory_id == id),
        "precondition: the memory is recallable before we forget it"
    );

    client
        .forget(&ForgetBuilder::new(id).mode(ForgetMode::Soft).build())
        .await
        .expect("soft forget");

    // After a soft forget it must drop out of recall.
    let after = common::recall_until(&client, &rec, |a| {
        !a.memories().iter().any(|m| m.memory_id == id)
    })
    .await;
    assert!(
        !after.memories().iter().any(|m| m.memory_id == id),
        "a soft-forgotten memory must not surface in recall"
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn hard_forget_is_idempotent_on_missing() {
    let Some(it) = common::It::from_env() else {
        return common::skip("hard_forget_is_idempotent_on_missing");
    };
    let (client, _agent) = it.connect_fresh().await;

    let enc = EncodeBuilder::new("A secret worth zeroing immediately.").build();
    let id = client.encode(&enc).await.expect("encode").memory_id;

    // Hard FORGET zeroes the slot now.
    client
        .forget(&ForgetBuilder::new(id).hard().build())
        .await
        .expect("hard forget");

    // FORGET is lenient: forgetting an already-gone id is a no-op success, so a
    // retry (at-least-once delivery) is safe.
    client
        .forget(&ForgetBuilder::new(id).hard().build())
        .await
        .expect("second hard forget is an idempotent no-op");
    client.close().await.expect("close");
}
