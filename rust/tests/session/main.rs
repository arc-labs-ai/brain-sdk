//! Feature: SESSION registry lifecycle — create → list → delete → list.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). Each test mints a fresh, isolated agent bound to a
//! brand-new random space, so its sessions live under a private space and never
//! collide with another test's listing.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{SessionCreateRequest, SessionDeleteRequest, SessionListRequest};

#[tokio::test]
async fn create_list_delete_round_trip() {
    let Some(it) = common::It::from_env() else {
        return common::skip("create_list_delete_round_trip");
    };
    let (client, _agent) = it.connect_fresh().await;

    // Sessions live under the caller's effective space; a non-zero id is
    // required because the default session (0) is implicit and non-deletable.
    let session_id: u64 = 7;

    // CREATE provisions the session under the caller's effective space.
    let created = client
        .create_session(&SessionCreateRequest {
            session_id,
            title: Some("planning thread".to_string()),
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("create_session");
    assert!(
        created.created,
        "a brand-new session reports created = true"
    );
    assert_eq!(created.session_id, session_id);

    // LIST the space's sessions — the one we just made must be present.
    let listed = client
        .list_sessions(&SessionListRequest {
            limit: 0,
            act_as: None,
        })
        .await
        .expect("list_sessions");
    assert!(
        listed.sessions.iter().any(|s| s.session_id == session_id),
        "the created session {session_id} appears in the listing"
    );

    // DELETE it (hard so the row is gone immediately rather than soft-grace).
    let deleted = client
        .delete_session(&SessionDeleteRequest {
            session_id,
            hard: true,
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete_session");
    assert!(deleted.existed, "the session had a registry row to delete");
    assert_eq!(deleted.session_id, session_id);

    // LIST again — the session must be gone.
    let after = client
        .list_sessions(&SessionListRequest {
            limit: 0,
            act_as: None,
        })
        .await
        .expect("list_sessions after delete");
    assert!(
        !after.sessions.iter().any(|s| s.session_id == session_id),
        "the deleted session {session_id} is absent from the listing"
    );

    client.close().await.expect("close");
}

#[tokio::test]
async fn create_is_idempotent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("create_is_idempotent");
    };
    let (client, _agent) = it.connect_fresh().await;

    let session_id: u64 = 11;
    let make = || SessionCreateRequest {
        session_id,
        title: Some("repeatable".to_string()),
        request_id: new_id(),
        act_as: None,
    };

    let first = client.create_session(&make()).await.expect("first create");
    assert!(first.created, "first create reports created = true");

    // Re-creating the same session id is a no-op returning the existing row.
    let second = client.create_session(&make()).await.expect("second create");
    assert!(
        !second.created,
        "an idempotent create of an existing session reports created = false"
    );
    assert_eq!(second.session_id, session_id);

    client.close().await.expect("close");
}

#[tokio::test]
async fn delete_missing_session_reports_absent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("delete_missing_session_reports_absent");
    };
    let (client, _agent) = it.connect_fresh().await;

    // A session id that was never provisioned: deleting it is a clean no-op
    // success with existed = false, not an error.
    let deleted = client
        .delete_session(&SessionDeleteRequest {
            session_id: 999,
            hard: true,
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete of a missing session succeeds as a no-op");
    assert!(
        !deleted.existed,
        "a session that was never created reports existed = false"
    );

    client.close().await.expect("close");
}
