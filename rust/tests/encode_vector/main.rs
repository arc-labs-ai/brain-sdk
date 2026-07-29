//! Feature: ENCODE_VECTOR_DIRECT — write a pre-computed embedding, bypassing
//! the server's owned embedding model.
//!
//! Integration test against a real server, gated on `BRAIN_SDK_IT_DATA` (see
//! `scripts/it-server.sh`). The vector rides the frame's trailing raw f32
//! section, not the CBOR map — the only verb in the protocol whose payload is
//! two differently-encoded regions, and so the easiest framing to get subtly
//! wrong without anything looking malformed.
//!
//! What proves the framing is the *accepting* case, not the rejecting ones.
//! Verified by dropping the trailer from the Python encoder: the wrong-length
//! cases still passed, because zero floats is also a wrong count. Only the
//! round-trip failed. A successful 384-float write can only happen if the
//! trailer arrived, carried exactly 384 f32s, and was little-endian — the
//! server checks all three. The rejection cases below prove the server
//! validates rather than accepts anything, without which the accepting case
//! would prove nothing.

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
    #[allow(clippy::cast_precision_loss)] // test dimensions are < 2^24
    let v = (1.0f32 / (dim as f32).sqrt()).max(f32::MIN_POSITIVE);
    let vector = vec![v; dim];

    let req = EncodeVectorDirectRequest {
        text: "A memory written with a client-supplied vector.".to_string(),
        vector,
        model_fingerprint: fingerprint,
        session_id: 0,
        kind: MemoryKindWire::Episodic,
        salience_hint: 0.5,
        edges: vec![],
        request_id: new_id(),
        txn_id: None,
        deduplicate: false,
    };
    let resp = client
        .encode_vector_direct(&req)
        .await
        .expect("encode_vector_direct");
    // Same durability contract as ENCODE: a returned response is WAL-durable.
    assert!(resp.lsn > 0, "direct-vector encode assigns a durable LSN");
    client.close().await.expect("close");
}

/// BGE-small is 384-dim.
const DIM: usize = 384;

fn unit_vector(dim: usize) -> Vec<f32> {
    {
        #[allow(clippy::cast_precision_loss)] // test dimensions are < 2^24
        let inv = 1.0f32 / (dim as f32).sqrt();
        vec![inv; dim]
    }
}

fn request(fingerprint: [u8; 16], vector: Vec<f32>, label: &str) -> EncodeVectorDirectRequest {
    EncodeVectorDirectRequest {
        text: format!("{label} {}", uuid_like()),
        vector,
        model_fingerprint: fingerprint,
        session_id: 0,
        kind: MemoryKindWire::Episodic,
        salience_hint: 0.5,
        edges: vec![],
        request_id: new_id(),
        txn_id: None,
        deduplicate: false,
    }
}

/// A per-call unique suffix so repeated runs do not dedupe into one memory.
fn uuid_like() -> String {
    new_id().iter().fold(String::with_capacity(32), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Learn the server's embedding-model fingerprint from a normal ENCODE.
async fn fingerprint_of(client: &brain_db_sdk::BrainClient) -> [u8; 16] {
    client
        .encode(&EncodeBuilder::new("fingerprint probe").build())
        .await
        .expect("probe encode")
        .embedding_model_fp
}

#[tokio::test]
async fn a_wrong_length_vector_is_rejected() {
    // The server counts the f32s in the raw section. On its own this does not
    // prove the trailer is well-framed — a dropped trailer is zero floats,
    // which is also wrong. It establishes that the server is checking, which is
    // what makes the accepting case above meaningful.
    let Some(it) = common::It::from_env() else {
        return common::skip("a_wrong_length_vector_is_rejected");
    };
    let (client, _agent) = it.connect_fresh().await;
    let fp = fingerprint_of(&client).await;

    for dim in [DIM - 1, DIM + 1, 8] {
        let err = client
            .encode_vector_direct(&request(fp, unit_vector(dim), "dim"))
            .await
            .expect_err("a wrong-length vector must be refused");
        assert!(
            format!("{err}").contains("dimension"),
            "expected a dimension complaint for {dim} floats, got: {err}"
        );
    }
    client.close().await.expect("close");
}

#[tokio::test]
async fn a_byte_swapped_vector_is_rejected() {
    // Pins little-endian byte order for the trailer. Three independent
    // implementations write these bytes, endianness is the classic thing to get
    // quietly wrong, and a byte-swapped trailer still has the right element
    // count so the dimension check sails past it. The server also requires a
    // roughly unit-magnitude vector, and a unit vector read in the wrong byte
    // order is nowhere near unit — magnitude is what catches it.
    let Some(it) = common::It::from_env() else {
        return common::skip("a_byte_swapped_vector_is_rejected");
    };
    let (client, _agent) = it.connect_fresh().await;
    let fp = fingerprint_of(&client).await;

    let swapped: Vec<f32> = unit_vector(DIM)
        .into_iter()
        .map(|x| f32::from_le_bytes(x.to_be_bytes()))
        .collect();
    let err = client
        .encode_vector_direct(&request(fp, swapped, "byte-swapped"))
        .await
        .expect_err("a mis-ordered vector must be refused");
    assert!(
        format!("{err}").contains("vector"),
        "expected the server to reject a mis-ordered vector, got: {err}"
    );
    client.close().await.expect("close");
}

#[tokio::test]
async fn a_wrong_model_fingerprint_is_rejected() {
    // The companion proof, for the CBOR half of the payload. That this check
    // fires confirms the CBOR map is read alongside the raw trailer, rather
    // than the payload being treated as one undivided blob.
    let Some(it) = common::It::from_env() else {
        return common::skip("a_wrong_model_fingerprint_is_rejected");
    };
    let (client, _agent) = it.connect_fresh().await;

    let err = client
        .encode_vector_direct(&request([0u8; 16], unit_vector(DIM), "wrong fingerprint"))
        .await
        .expect_err("a foreign fingerprint must be refused");
    assert!(
        format!("{err}").contains("fingerprint"),
        "expected a fingerprint complaint, got: {err}"
    );
    client.close().await.expect("close");
}
