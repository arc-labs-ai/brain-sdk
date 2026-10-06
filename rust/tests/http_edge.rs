//! Opt-in integration tests against a running Brain HTTP edge.
//!
//! Set `BRAIN_SDK_IT_HTTP` and `BRAIN_SDK_IT_HTTP_KEY` to run these tests.
//! `BRAIN_SDK_IT_REQUIRED=1` turns missing configuration into a failure.

use std::env;

use brain_db_sdk::http::{BrainHttpClient, EncodeInput, ForgetInput, MemoryListQuery, RecallInput};

fn client() -> Option<BrainHttpClient> {
    let base_url = env::var("BRAIN_SDK_IT_HTTP").ok();
    let api_key = env::var("BRAIN_SDK_IT_HTTP_KEY")
        .or_else(|_| env::var("BRAIN_SDK_IT_API_KEY"))
        .ok();
    match (base_url, api_key) {
        (Some(base_url), Some(api_key)) => Some(BrainHttpClient::new(api_key, base_url)),
        _ if env::var("BRAIN_SDK_IT_REQUIRED").as_deref() == Ok("1") => {
            panic!("live edge tests require BRAIN_SDK_IT_HTTP and BRAIN_SDK_IT_HTTP_KEY");
        }
        _ => None,
    }
}

#[tokio::test]
async fn live_edge_identity_and_capabilities() {
    let Some(client) = client() else { return };
    let identity = client.whoami().await.expect("whoami");
    let capabilities = client.capabilities().await.expect("capabilities");

    assert_ne!(identity.namespace, "");
    assert_ne!(identity.space_id, "");
    assert!(capabilities.vector_dim > 0);
}

#[tokio::test]
async fn live_edge_memory_lifecycle() {
    let Some(client) = client() else { return };
    let text = format!("brain-sdk live edge integration {}", uuid::Uuid::now_v7());
    let encoded = client
        .encode(&EncodeInput {
            text: text.clone(),
            session: None,
            occurred_at: None,
        })
        .await
        .expect("encode");
    assert_ne!(encoded.memory_id, "");

    let recalled = client
        .recall(&RecallInput {
            query: text,
            max_results: Some(5),
            subject: None,
        })
        .await
        .expect("recall");
    let _ = recalled.memories;

    let page = client
        .memory_list(&MemoryListQuery::default())
        .await
        .expect("memory list");
    assert!(page
        .items
        .iter()
        .any(|item| item.memory_id == encoded.memory_id));

    let forgotten = client
        .forget(&ForgetInput {
            memory_id: encoded.memory_id.clone(),
            hard: false,
        })
        .await
        .expect("forget");
    assert_eq!(forgotten.memory_id, encoded.memory_id);
}
