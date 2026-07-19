//! Feature: ENCODE_VECTOR_DIRECT — write a pre-computed embedding, bypassing
//! the server's owned embedding model.
//!
//! Integration test against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). The vector rides the frame's trailing raw f32
//! section, not the CBOR map — this exercises that custom framing end-to-end.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{EncodeVectorDirectRequest, MemoryKindWire};
use brain_db_sdk::EncodeBuilder;

#[tokio::test]
async fn encode_vector_direct_round_trips() {
    let Some(it) = common::It::from_env() else {
        return common::skip("encode_vector_direct_round_trips");
    };
    let (client, _agent) = it.connect_fresh().await;

    // A direct-vector write must carry the server's embedding-model fingerprint
    // so the pre-computed vector is known to match the model. A normal ENCODE
    // response reports that fingerprint, so learn it first.
    let probe = client
        .encode(&EncodeBuilder::new("fingerprint probe").build())
        .await
        .expect("probe encode");
    let fingerprint = probe.embedding_model_fp;

    // BGE-small is 384-dim; a normalized constant vector is a valid unit-ish
    // embedding for the direct-write path.
    let dim = 384usize;
    let v = (1.0f32 / (dim as f32).sqrt()).max(f32::MIN_POSITIVE);
    let vector = vec![v; dim];

    let req = EncodeVectorDirectRequest {
        text: "A memory written with a client-supplied vector.".to_string(),
        vector,
        model_fingerprint: fingerprint,
        context_id: 0,
        kind: MemoryKindWire::Episodic,
        salience_hint: 0.5,
        edges: vec![],
        request_id: new_id(),
        txn_id: None,
        deduplicate: false,
    };
    let resp = client.encode_vector_direct(&req).await.expect("encode_vector_direct");
    // Same durability contract as ENCODE: a returned response is WAL-durable.
    assert!(resp.lsn > 0, "direct-vector encode assigns a durable LSN");
    client.close().await.expect("close");
}
