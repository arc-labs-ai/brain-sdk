//! Feature: RECALL — read episodic memory.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). ENCODE is durable on ack but the semantic
//! index becomes searchable a beat later, so these use `common::recall_until`
//! to poll for read-your-writes visibility rather than racing the index.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::AnswerKindWire;
use brain_db_sdk::{EncodeBuilder, RecallBuilder};

#[tokio::test]
async fn recall_finds_what_was_encoded() {
    let Some(it) = common::It::from_env() else {
        return common::skip("recall_finds_what_was_encoded");
    };
    let (client, _agent) = it.connect_fresh().await;

    let enc = EncodeBuilder::new("My favorite programming language is Rust.").build();
    let stored = client.encode(&enc).await.expect("encode").memory_id;

    // A paraphrased cue: exercises the real embedding + retrieval path.
    let rec = RecallBuilder::new("What language do I like?")
        .max_results(10)
        .include_text(true)
        .build();
    let answer = common::recall_until(&client, &rec, |a| {
        a.memories().iter().any(|m| m.memory_id == stored)
    })
    .await;

    assert_ne!(
        answer.answer_kind,
        AnswerKindWire::None,
        "recall found something"
    );
    assert!(
        answer.memories().iter().any(|m| m.memory_id == stored),
        "the freshly-encoded memory is among the recall hits"
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn recall_respects_max_results_cap() {
    let Some(it) = common::It::from_env() else {
        return common::skip("recall_respects_max_results_cap");
    };
    let (client, _agent) = it.connect_fresh().await;

    for i in 0..8 {
        let e = EncodeBuilder::new(format!("Fact number {i} about coffee brewing.")).build();
        client.encode(&e).await.expect("encode");
    }

    // Wait until at least one is visible, then assert the cap holds.
    let rec = RecallBuilder::new("coffee")
        .max_results(3)
        .include_text(true)
        .build();
    let answer = common::recall_until(&client, &rec, |a| !a.is_empty()).await;
    assert!(!answer.is_empty(), "at least one coffee fact is recalled");
    assert!(
        answer.memories().len() <= 3,
        "server honors the max_results cap: got {}",
        answer.memories().len()
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn recall_confidence_threshold_is_accepted() {
    let Some(it) = common::It::from_env() else {
        return common::skip("recall_confidence_threshold_is_accepted");
    };
    let (client, _agent) = it.connect_fresh().await;

    let enc = EncodeBuilder::new("The capital of Japan is Tokyo.").build();
    client.encode(&enc).await.expect("encode");

    // A permissive threshold must still surface the memory; the param is a
    // valid RECALL knob and the server applies it without error.
    let rec = RecallBuilder::new("capital of Japan")
        .confidence_threshold(0.0)
        .include_text(true)
        .build();
    let answer = common::recall_until(&client, &rec, |a| !a.is_empty()).await;
    assert!(!answer.is_empty(), "threshold=0 recalls the memory");
    client.close().await.expect("close");
}
