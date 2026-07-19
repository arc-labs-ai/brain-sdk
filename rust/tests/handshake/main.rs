//! Feature: handshake + mandatory auth.
//!
//! This binary bundles both layers of the feature:
//! - `wire` — offline codec/handshake tests over a mock transport (no server).
//! - the `live_*` tests below — integration tests against a real server,
//!   gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`).

#[path = "../common/mod.rs"]
mod common;
mod wire;

use brain_db_sdk::{new_id, Auth, BrainClient};

#[tokio::test]
async fn live_minted_token_resolves_session() {
    let Some(it) = common::It::from_env() else {
        return common::skip("live_minted_token_resolves_session");
    };

    let agent = new_id();
    let client = it.connect_as(agent).await;
    let session = client.session();

    // The server derives identity from the credential: the session's agent is
    // exactly the one the key was minted for, bound to the tenant namespace.
    assert_eq!(session.agent_id, agent, "session agent == minted agent");
    assert_eq!(session.namespace, it.namespace, "session namespace == tenant");
    assert_eq!(session.chosen_version, 1, "wire version negotiated to 1");
    client.close().await.expect("clean close");
}

#[tokio::test]
async fn live_two_agents_get_distinct_sessions() {
    let Some(it) = common::It::from_env() else {
        return common::skip("live_two_agents_get_distinct_sessions");
    };

    let (a, a_id) = it.connect_fresh().await;
    let (b, b_id) = it.connect_fresh().await;

    assert_ne!(a_id, b_id, "fresh agents differ");
    assert_eq!(a.session().agent_id, a_id);
    assert_eq!(b.session().agent_id, b_id);
    assert_eq!(a.session().namespace, b.session().namespace, "same tenant");
    a.close().await.expect("close a");
    b.close().await.expect("close b");
}

#[tokio::test]
async fn live_bad_token_is_refused() {
    let Some(it) = common::It::from_env() else {
        return common::skip("live_bad_token_is_refused");
    };

    // A token the server never minted must not resolve to a session.
    let bogus = Auth::Token(b"brain_not-a-real-key".to_vec());
    assert!(
        BrainClient::connect(it.data, bogus).await.is_err(),
        "an unminted token must be refused"
    );
}
