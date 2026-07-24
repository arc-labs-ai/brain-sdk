//! Feature: typed-graph ENTITY lifecycle — create → update → rename → merge →
//! unmerge → tombstone.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). Each test mints a fresh, isolated agent.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{
    EntityCreateRequest, EntityGetRequest, EntityMergeRequest, EntityRenameRequest,
    EntityTombstoneRequest, EntityUnmergeRequest, EntityUpdateRequest,
};

fn create(name: &str) -> EntityCreateRequest {
    EntityCreateRequest {
        act_as: None,
        entity_type_id: 1,
        canonical_name: name.to_string(),
        aliases: vec![],
        attributes_blob: vec![],
            session_id: 0,
        request_id: new_id(),
    }
}

#[tokio::test]
async fn update_then_rename_then_tombstone() {
    let Some(it) = common::It::from_env() else {
        return common::skip("update_then_rename_then_tombstone");
    };
    let (client, _agent) = it.connect_fresh().await;

    let id = client.create_entity(&create("Ada")).await.expect("create").entity_id;

    // UPDATE replaces name + aliases + attributes wholesale.
    let updated = client
        .update_entity(&EntityUpdateRequest {
            entity_id: id,
            canonical_name: "Ada Lovelace".to_string(),
            aliases: vec!["Ada".to_string()],
            attributes_blob: b"role=mathematician".to_vec(),
            request_id: new_id(),
        })
        .await
        .expect("update");
    assert_eq!(updated.entity.canonical_name, "Ada Lovelace");

    // RENAME with move_to_alias keeps the prior name reachable.
    let renamed = client
        .rename_entity(&EntityRenameRequest {
            entity_id: id,
            new_canonical_name: "Countess Lovelace".to_string(),
            move_to_alias: true,
            request_id: new_id(),
        })
        .await
        .expect("rename");
    assert_eq!(renamed.entity.canonical_name, "Countess Lovelace");
    assert!(
        renamed.entity.aliases.iter().any(|a| a == "Ada Lovelace"),
        "the prior canonical name is retained as an alias"
    );

    // Deep check: re-read from the server to prove the rename actually persisted
    // — not merely echoed back in the mutation response.
    let fetched = client
        .get_entity(&EntityGetRequest {
            entity_id: id,
            act_as: None,
        })
        .await
        .expect("get after rename")
        .entity;
    assert_eq!(fetched.canonical_name, "Countess Lovelace", "rename persisted");
    assert!(fetched.aliases.iter().any(|a| a == "Ada Lovelace"), "alias persisted");

    // TOMBSTONE retires it with an audit reason.
    let ts = client
        .tombstone_entity(&EntityTombstoneRequest {
            entity_id: id,
            reason: "test cleanup".to_string(),
            request_id: new_id(),
        })
        .await
        .expect("tombstone");
    assert!(ts.tombstoned_at_unix_nanos > 0, "tombstone records a time");

    // Deep check: tombstone is *soft* — the row survives (recoverable) and is
    // still fetchable by id; it's resolution/traversal that exclude it. So a
    // direct get must still succeed and return the same entity.
    let after = client
        .get_entity(&EntityGetRequest {
            entity_id: id,
            act_as: None,
        })
        .await
        .expect("tombstoned entity is still fetchable by id (soft)")
        .entity;
    assert_eq!(after.entity_id, id, "get-by-id survives a soft tombstone");
    client.close().await.expect("close");
}

#[tokio::test]
async fn merge_then_unmerge() {
    let Some(it) = common::It::from_env() else {
        return common::skip("merge_then_unmerge");
    };
    let (client, _agent) = it.connect_fresh().await;

    let survivor = client.create_entity(&create("NYC")).await.expect("create a").entity_id;
    let merged = client
        .create_entity(&create("New York City"))
        .await
        .expect("create b")
        .entity_id;

    // MERGE folds `merged` into `survivor`; the response carries the grace
    // window during which it can be undone.
    let m = client
        .merge_entities(&EntityMergeRequest {
            survivor,
            merged,
            confidence: 0.95,
            reason: "same city".to_string(),
            request_id: new_id(),
        })
        .await
        .expect("merge");
    assert!(m.grace_period_seconds > 0, "merge is reversible for a window");

    // UNMERGE undoes it within that window.
    let u = client
        .unmerge_entity(&EntityUnmergeRequest {
            merged_entity: merged,
            request_id: new_id(),
        })
        .await
        .expect("unmerge");
    assert_eq!(u.restored_entity_id, merged, "the folded entity is restored");
    client.close().await.expect("close");
}
