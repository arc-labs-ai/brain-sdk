//! Feature: MATERIALIZE_PROCEDURAL — distill a procedural-memory system block
//! from stored statements.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). Each test mints a fresh, isolated agent so the
//! candidate pool it materializes over is entirely its own.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{MaterializeProceduralRequest, WaitMode};
use brain_db_sdk::EncodeBuilder;

/// Materialize is the durable end of the write path: it distills whatever
/// procedural statements the extractor produced from encoded memories into a
/// system block. This asserts the *response shape* is internally consistent,
/// not a specific extraction outcome — procedural extraction is LLM-driven and
/// its statement set is non-deterministic (and may legitimately be empty).
#[tokio::test]
async fn materialize_returns_a_coherent_block() {
    let Some(it) = common::It::from_env() else {
        return common::skip("materialize_returns_a_coherent_block");
    };
    let (client, _agent) = it.connect_fresh().await;

    // Seed a few preference/style memories the procedural distiller can draw on.
    // `wait_derived` blocks until async extraction finishes, so anything the
    // extractor produces is on disk before we materialize — no visibility race.
    for text in [
        "I always prefer concise answers over long explanations.",
        "When writing code, I like thorough comments and small functions.",
        "I dislike being interrupted with clarifying questions mid-task.",
    ] {
        client
            .encode(&EncodeBuilder::new(text).wait(WaitMode::Derived).build())
            .await
            .expect("encode source memory");
    }

    let resp = client
        .materialize_procedural(&MaterializeProceduralRequest {
            space_id: client.space_id(),
            session_filter: None,
            top_k: 10,
            min_confidence: 0.0,
            categories: vec![],
            request_id: new_id(),
        })
        .await
        .expect("materialize_procedural");

    // Shape invariants that hold for any extraction outcome:
    // the selected set never exceeds the candidate pool, nor the requested cap.
    assert!(
        resp.statement_ids.len() as u32 <= resp.total_candidates,
        "materialized ids ({}) cannot exceed total candidates ({})",
        resp.statement_ids.len(),
        resp.total_candidates
    );
    assert!(
        resp.statement_ids.len() <= 10,
        "materialized ids respect top_k = 10 (got {})",
        resp.statement_ids.len()
    );
    // The server always renders a system block — a header template even when
    // nothing was distilled — so the read verb never returns an empty payload.
    assert!(
        !resp.system_block.is_empty(),
        "materialize always renders a system block"
    );
    // Every returned id is a full 16-byte statement id.
    for id in &resp.statement_ids {
        assert_eq!(id.len(), 16, "statement ids are 16-byte ids");
    }

    client.close().await.expect("close");
}

/// A fresh space with nothing to distill still returns a well-formed response:
/// zero candidates, zero ids, nothing trimmed, and a rendered header block
/// carrying the "no procedural statements yet" sentinel rather than an error.
#[tokio::test]
async fn materialize_on_empty_space_is_empty_not_error() {
    let Some(it) = common::It::from_env() else {
        return common::skip("materialize_on_empty_space_is_empty_not_error");
    };
    let (client, _agent) = it.connect_fresh().await;

    let resp = client
        .materialize_procedural(&MaterializeProceduralRequest {
            space_id: client.space_id(),
            session_filter: None,
            top_k: 5,
            min_confidence: 0.5,
            categories: vec!["style".to_string()],
            request_id: new_id(),
        })
        .await
        .expect("materialize_procedural on an empty space");

    assert!(
        resp.statement_ids.is_empty(),
        "no statements to materialize from an empty space"
    );
    assert_eq!(
        resp.total_candidates, 0,
        "no candidates in an empty space"
    );
    assert!(
        !resp.trimmed_by_budget,
        "nothing to trim when there are no candidates"
    );
    // The block is still rendered (a header + sentinel), never empty.
    assert!(
        !resp.system_block.is_empty(),
        "an empty space still renders a header block"
    );

    client.close().await.expect("close");
}
