//! Feature: SPACE registry lifecycle — create → list → delete → list.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). Each test mints a fresh, isolated agent bound to a
//! brand-new random space, so the row it provisions is entirely its own.
//!
//! Note on identity: the harness mints keys with a raw `space_id_hex`, so the
//! server has no *human-readable* structured space string to echo back — the
//! `space_id` field on both the create response and every `SpaceView` comes
//! back empty. The listing also spans the whole shared test namespace. So the
//! stable way to find *this* test's space in the listing is its unique
//! `created_at_unix_nanos`, not the (empty) `space_id` string.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{SpaceCreateRequest, SpaceDeleteRequest, SpaceListRequest};

/// A space is provisioned for the caller's *effective* space — the one bound to
/// the auth token — so there is no space_id to pass; the token is the identity.
fn create() -> SpaceCreateRequest {
    SpaceCreateRequest {
        metadata: None,
        request_id: new_id(),
        act_as: None,
    }
}

#[tokio::test]
async fn create_list_delete_round_trip() {
    let Some(it) = common::It::from_env() else {
        return common::skip("create_list_delete_round_trip");
    };
    let (client, _agent) = it.connect_fresh().await;

    // CREATE provisions the caller's effective space and stamps its birth time.
    let created = client.create_space(&create()).await.expect("create_space");
    assert!(created.created, "a brand-new space reports created = true");
    // This unique nanosecond stamp is our handle on the row in a shared-namespace
    // listing (the space_id string is empty for hex-minted keys — see header).
    let birth = created.created_at_unix_nanos;
    assert!(birth > 0, "create stamps a birth time");

    // LIST the namespace's spaces — the one we just made must be present.
    let listed = client
        .list_spaces(&SpaceListRequest {
            limit: 0,
            act_as: None,
        })
        .await
        .expect("list_spaces");
    assert!(
        listed
            .spaces
            .iter()
            .any(|s| s.created_at_unix_nanos == birth),
        "the created space (born {birth}) appears in the listing"
    );

    // DELETE erases the caller's effective space (GDPR-hard cascade).
    let deleted = client
        .delete_space(&SpaceDeleteRequest {
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete_space");
    assert!(deleted.existed, "the space had a registry row to delete");

    // LIST again — the space must be gone.
    let after = client
        .list_spaces(&SpaceListRequest {
            limit: 0,
            act_as: None,
        })
        .await
        .expect("list_spaces after delete");
    assert!(
        !after
            .spaces
            .iter()
            .any(|s| s.created_at_unix_nanos == birth),
        "the deleted space (born {birth}) is absent from the listing"
    );

    client.close().await.expect("close");
}

#[tokio::test]
async fn create_is_idempotent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("create_is_idempotent");
    };
    let (client, _agent) = it.connect_fresh().await;

    // First create provisions the row.
    let first = client.create_space(&create()).await.expect("first create");
    assert!(first.created, "first create reports created = true");

    // Second create for the same effective space is a no-op that returns the
    // existing row with created = false and the same birth time.
    let second = client.create_space(&create()).await.expect("second create");
    assert!(
        !second.created,
        "an idempotent create of an existing space reports created = false"
    );
    assert_eq!(
        second.created_at_unix_nanos, first.created_at_unix_nanos,
        "the idempotent replay returns the original birth time"
    );

    client.close().await.expect("close");
}

#[tokio::test]
async fn delete_missing_space_reports_absent() {
    let Some(it) = common::It::from_env() else {
        return common::skip("delete_missing_space_reports_absent");
    };
    // A fresh agent whose space was never provisioned: deleting it is a clean
    // no-op success with existed = false, not an error.
    let (client, _agent) = it.connect_fresh().await;

    let deleted = client
        .delete_space(&SpaceDeleteRequest {
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete of an unprovisioned space succeeds as a no-op");
    assert!(
        !deleted.existed,
        "a space that was never created reports existed = false"
    );
    assert_eq!(
        deleted.memories_forgotten, 0,
        "nothing to cascade-forget on an empty space"
    );

    client.close().await.expect("close");
}
