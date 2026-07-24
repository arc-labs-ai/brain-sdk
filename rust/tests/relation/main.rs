//! Feature: typed-graph RELATION lifecycle + traversal — create → get →
//! supersede → traverse → tombstone.
//!
//! Integration tests against a real server, gated on `BRAIN_SDK_IT_DATA`
//! (see `scripts/it-server.sh`). Each test mints a fresh, isolated agent.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::wire::types::{
    EntityCreateRequest, EvidenceRefWire, RelationCreateRequest, RelationGetRequest,
    RelationSupersedeRequest, RelationTombstoneRequest, RelationTraverseRequest, WireUuid,
};
use brain_db_sdk::{new_id, BrainClient};

async fn entity(client: &BrainClient, name: &str) -> WireUuid {
    client
        .create_entity(&EntityCreateRequest {
            act_as: None,
            entity_type_id: 1,
            canonical_name: name.to_string(),
            aliases: vec![],
            attributes_blob: vec![],
            session_id: 0,
            request_id: new_id(),
        })
        .await
        .expect("create entity")
        .entity_id
}

fn relation(from: WireUuid, to: WireUuid) -> RelationCreateRequest {
    RelationCreateRequest {
        act_as: None,
        relation_type: "org:collaborated_with".to_string(),
        from_entity: from,
        to_entity: to,
        properties_blob: vec![],
        session_id: 0,
        evidence: EvidenceRefWire::Inline(vec![]),
        extractor_id: 0,
        confidence: 0.8,
        valid_from_unix_nanos: 0,
        valid_to_unix_nanos: u64::MAX,
        request_id: new_id(),
    }
}

#[tokio::test]
async fn get_supersede_tombstone() {
    let Some(it) = common::It::from_env() else {
        return common::skip("get_supersede_tombstone");
    };
    let (client, _agent) = it.connect_fresh().await;
    let a = entity(&client, "Ada").await;
    let b = entity(&client, "Babbage").await;

    let rel = client
        .create_relation(&relation(a, b))
        .await
        .expect("create relation");

    // GET the relation back by id.
    let got = client
        .get_relation(&RelationGetRequest {
            relation_id: rel.relation_id,
            follow_supersession: false,
            act_as: None,
        })
        .await
        .expect("get relation");
    assert_eq!(got.relation.relation_type, "org:collaborated_with");

    // SUPERSEDE with a revised relation on the same chain.
    let sup = client
        .supersede_relation(&RelationSupersedeRequest {
            old_relation_id: rel.relation_id,
            new_relation: relation(a, b),
            request_id: new_id(),
        })
        .await
        .expect("supersede");
    assert!(sup.version >= 2, "the revision is a later version");

    // TOMBSTONE the current relation.
    let ts = client
        .tombstone_relation(&RelationTombstoneRequest {
            relation_id: sup.new_relation_id,
            reason: "test cleanup".to_string(),
            request_id: new_id(),
        })
        .await
        .expect("tombstone");
    assert!(ts.tombstoned_at_unix_nanos > 0);
    client.close().await.expect("close");
}

#[tokio::test]
async fn traverse_from_entity() {
    let Some(it) = common::It::from_env() else {
        return common::skip("traverse_from_entity");
    };
    let (client, _agent) = it.connect_fresh().await;
    let a = entity(&client, "Ada").await;
    let b = entity(&client, "Babbage").await;
    client
        .create_relation(&relation(a, b))
        .await
        .expect("create relation");

    // Walk the relation graph from `a`; with one edge a→b we expect a path.
    let paths = client
        .traverse_relations(&RelationTraverseRequest {
            start_entity: a,
            relation_types: vec![],
            direction: 0,
            max_depth: 3,
            max_nodes: 100,
            time_at_unix_nanos: 0,
            include_superseded: false,
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("traverse");
    assert!(
        paths.iter().any(|p| p.steps.iter().any(|s| s.to == b)),
        "traversal reaches the neighbor across the created edge"
    );
    client.close().await.expect("close");
}
