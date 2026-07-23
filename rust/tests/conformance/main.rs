//! Corpus drift-guard: every vendored `.bin` must decode to a value
//! whose JSON projection matches its `.json` mirror, and re-encode to
//! the exact same bytes. This is the byte-level proof that the SDK's
//! codec agrees with the server's wire format.
//!
//! Two case shapes:
//! - `frame_*` cases mirror a full `Frame` (header + payload); the
//!   `.json` carries `opcode_hex / flags / stream_id / payload_len /
//!   payload_hex`.
//! - every other case is a payload-only `.bin`; the `.json` is the
//!   serde_json mirror of the decoded payload struct.
//!
//! The decode side compares as `serde_json::Value`. The crate's
//! `arbitrary_precision` feature lets a `Value` hold the packed `u128`
//! `MemoryId`, and serializing the typed value (rather than parsing the
//! mirror into the struct) sidesteps `serde_bytes`' asymmetric handling
//! of a JSON `null` for an `Option<[u8; N]>` field.

use std::path::PathBuf;

use brain_db_sdk::wire::cbor::{
    f32_slice_to_le_bytes, from_cbor_bytes, from_cbor_prefix, le_bytes_to_f32_vec, to_cbor_bytes,
};
use brain_db_sdk::wire::frame::Frame;
use brain_db_sdk::wire::types::*;
use serde::de::DeserializeOwned;

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("conformance")
        .join("corpus")
}

fn read_bin(name: &str) -> Vec<u8> {
    std::fs::read(corpus_dir().join(format!("{name}.bin")))
        .unwrap_or_else(|e| panic!("read {name}.bin: {e}"))
}

fn read_json(name: &str) -> serde_json::Value {
    let text = std::fs::read_to_string(corpus_dir().join(format!("{name}.json")))
        .unwrap_or_else(|e| panic!("read {name}.json: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {name}.json: {e}"))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd-length hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex byte"))
        .collect()
}

/// Decode a whole-CBOR payload `.bin` to `T`, assert its JSON projection
/// equals the `.json` mirror, then re-encode and assert byte-exact
/// equality with the `.bin`.
fn check_payload<T>(name: &str)
where
    T: serde::Serialize + DeserializeOwned,
{
    let bin = read_bin(name);
    let value: T = from_cbor_bytes(&bin).unwrap_or_else(|e| panic!("decode CBOR {name}: {e}"));

    let got = serde_json::to_value(&value).unwrap_or_else(|e| panic!("{name}: value -> json: {e}"));
    assert_eq!(
        got,
        read_json(name),
        "{name}: decoded value != .json mirror"
    );

    let reencoded = to_cbor_bytes(&value);
    assert_eq!(
        reencoded,
        bin,
        "{name}: re-encoded bytes != .bin\n got: {}\n exp: {}",
        hex(&reencoded),
        hex(&bin),
    );
}

/// Decode a full `Frame` `.bin`, assert its header fields and payload
/// match the `.json` frame mirror, then re-encode byte-exact.
fn check_frame(name: &str) {
    let bin = read_bin(name);
    let expected = read_json(name);

    let (frame, rest) =
        Frame::decode(&bin).unwrap_or_else(|e| panic!("decode frame {name}: {e:?}"));
    assert!(rest.is_empty(), "{name}: trailing bytes after frame");

    let expected_opcode = {
        let h = expected["opcode_hex"].as_str().expect("opcode_hex");
        u16::from_str_radix(h.trim_start_matches("0x"), 16).expect("opcode hex")
    };
    assert_eq!(frame.opcode, expected_opcode, "{name}: opcode");
    assert_eq!(
        u64::from(frame.flags),
        expected["flags"].as_u64().expect("flags"),
        "{name}: flags"
    );
    assert_eq!(
        u64::from(frame.stream_id),
        expected["stream_id"].as_u64().expect("stream_id"),
        "{name}: stream_id"
    );
    assert_eq!(
        frame.payload.len() as u64,
        expected["payload_len"].as_u64().expect("payload_len"),
        "{name}: payload_len"
    );

    let expected_payload = hex_to_bytes(expected["payload_hex"].as_str().expect("payload_hex"));
    assert_eq!(
        frame.payload, expected_payload,
        "{name}: frame payload bytes"
    );

    let reencoded = frame.encode();
    assert_eq!(reencoded, bin, "{name}: re-encoded frame != .bin");
}

// ---------------------------------------------------------------------------
// Payload-only cases.
// ---------------------------------------------------------------------------

#[test]
fn payload_cases_round_trip() {
    // Handshake.
    check_payload::<HelloPayload>("req_hello");
    check_payload::<AuthPayload>("req_auth");
    check_payload::<WelcomePayload>("resp_welcome");
    check_payload::<AuthOkPayload>("resp_auth_ok");

    // v1 verbs.
    check_payload::<EncodeRequest>("req_encode");
    check_payload::<EncodeRequest>("req_encode_trace");
    check_payload::<EncodeRequest>("req_encode_allow_duplicates");
    check_payload::<RecallRequest>("req_recall");
    check_payload::<ForgetRequest>("req_forget");

    // Per-request `act_as` effective identity on the data-plane ops. The
    // non-act_as goldens above prove the field is omitted from the wire when
    // absent; these prove it round-trips byte-exact when present.
    check_payload::<EncodeRequest>("req_encode_act_as");
    check_payload::<RecallRequest>("req_recall_act_as");
    check_payload::<ForgetRequest>("req_forget_act_as");
    check_payload::<PlanRequest>("req_plan_act_as");
    check_payload::<ReasonRequest>("req_reason_act_as");
    check_payload::<EntityCreateRequest>("req_entity_create_act_as");
    check_payload::<AuthOkPayload>("resp_auth_ok_act_as");
    check_payload::<ErrorResponse>("resp_error_act_as_denied");
    check_payload::<EncodeResponse>("resp_encode");
    check_payload::<EncodeResponse>("resp_encode_trace");
    check_payload::<RecallResponseFrame>("resp_recall");
    check_payload::<RecallResponseFrame>("resp_recall_trace");
    check_payload::<MemoryListRequest>("req_memory_list");
    check_payload::<MemoryListResponseFrame>("resp_memory_list");
    check_payload::<MemoryInspectRequest>("req_memory_inspect");
    check_payload::<MemoryInspectResponse>("resp_memory_inspect");
    check_payload::<GraphFetchRequest>("req_graph_fetch");
    check_payload::<GraphFetchResponseFrame>("resp_graph_fetch");
    check_payload::<ForgetResponse>("resp_forget");

    // Typed-graph ops in the corpus.
    check_payload::<EntityCreateRequest>("req_entity_create");
    check_payload::<EntityCreateResponse>("resp_entity_create");
    check_payload::<StatementCreateRequest>("req_statement_create");
    check_payload::<StatementCreateResponse>("resp_statement_create");
    check_payload::<RelationCreateRequest>("req_relation_create");
    check_payload::<RelationCreateResponse>("resp_relation_create");
    check_payload::<SchemaUploadRequest>("req_schema_upload");
    check_payload::<SchemaUploadResponse>("resp_schema_upload");
    check_payload::<MaterializeProceduralRequest>("req_materialize_procedural");
    check_payload::<MaterializeProceduralResponse>("resp_materialize_procedural");

    // Read-side typed-graph responses.
    check_payload::<EntityGetResponse>("resp_entity_get");
    check_payload::<EntityListResponseFrame>("resp_entity_list");
    check_payload::<EntityResolveResponse>("resp_entity_resolve");
    check_payload::<StatementGetResponse>("resp_statement_get");
    check_payload::<StatementListResponseFrame>("resp_statement_list");
    check_payload::<RelationListFromResponseFrame>("resp_relation_list");

    // Cognitive read-side responses.
    check_payload::<PlanResponseFrame>("resp_plan");
    check_payload::<PlanResponseFrame>("resp_plan_trace");
    check_payload::<ReasonResponseFrame>("resp_reason");
    check_payload::<ReasonResponseFrame>("resp_reason_trace");
    check_payload::<LinkResponse>("resp_link");

    // Transaction responses.
    check_payload::<TxnBeginResponse>("resp_txn_begin");
    check_payload::<TxnCommitResponse>("resp_txn_commit");
    check_payload::<TxnAbortResponse>("resp_txn_abort");

    // Capabilities + subscription event.
    check_payload::<GetCapabilitiesResponse>("resp_get_capabilities");
    check_payload::<SubscriptionEvent>("resp_subscribe_event");

    // Extractor introspection.
    check_payload::<ExtractorListRequest>("req_extractor_list");
    check_payload::<ExtractorListResponseFrame>("resp_extractor_list");

    // Keepalive responses.
    check_payload::<PongResponse>("resp_pong");
    check_payload::<ServerPingResponse>("resp_server_ping");

    // ERROR frame body, one per category.
    for name in [
        "resp_error_protocol",
        "resp_error_authentication",
        "resp_error_authorization",
        "resp_error_validation",
        "resp_error_not_found",
        "resp_error_conflict",
        "resp_error_resource_exhausted",
        "resp_error_internal",
        "resp_error_unavailable",
    ] {
        check_payload::<ErrorResponse>(name);
    }
}

/// The payload-only `req_encode_vector_direct.bin` is `CBOR map ++ raw
/// LE f32`, so it needs the prefix codec plus the trailing-vector seam
/// rather than the whole-buffer decode `check_payload` uses. Decode the
/// CBOR prefix, attach the trailer to `vector`, check the JSON projection
/// (the `.json` mirror omits `vector`, which is `serde(skip)`), then
/// re-encode prefix + trailer byte-exact.
#[test]
fn encode_vector_direct_payload_round_trips() {
    let name = "req_encode_vector_direct";
    let bin = read_bin(name);

    let (mut req, consumed): (EncodeVectorDirectRequest, usize) =
        from_cbor_prefix(&bin).unwrap_or_else(|e| panic!("decode CBOR {name}: {e}"));
    req.vector = le_bytes_to_f32_vec(&bin[consumed..]).expect("trailing f32");
    assert_eq!(req.vector, vec![1.0_f32, 0.5, -0.25, 0.125]);

    let got = serde_json::to_value(&req).expect("value -> json");
    assert_eq!(
        got,
        read_json(name),
        "{name}: decoded value != .json mirror"
    );

    let mut reencoded = to_cbor_bytes(&req);
    assert_eq!(reencoded.len(), consumed, "CBOR prefix invariant to vector");
    reencoded.extend_from_slice(&f32_slice_to_le_bytes(&req.vector));
    assert_eq!(reencoded, bin, "{name}: re-encoded bytes != .bin");
}

// ---------------------------------------------------------------------------
// Full-frame cases.
// ---------------------------------------------------------------------------

#[test]
fn frame_cases_round_trip() {
    check_frame("frame_hello");
    check_frame("frame_welcome");
    check_frame("frame_encode");
    check_frame("frame_error");
    check_frame("frame_recall_eos");
    check_frame("frame_encode_vector_direct");
}

/// The ENCODE_VECTOR_DIRECT frame payload is `CBOR map ++ raw LE f32`.
/// Decode the prefix to the struct, read the trailer into `vector`, then
/// re-encode (CBOR prefix + trailer) and assert the whole frame is
/// byte-exact.
#[test]
fn encode_vector_direct_frame_carries_trailing_vector() {
    let name = "frame_encode_vector_direct";
    let bin = read_bin(name);
    let (frame, rest) = Frame::decode(&bin).expect("decode frame");
    assert!(rest.is_empty());

    let (mut req, consumed): (EncodeVectorDirectRequest, usize) =
        from_cbor_prefix(&frame.payload).expect("cbor prefix");
    req.vector = le_bytes_to_f32_vec(&frame.payload[consumed..]).expect("trailing f32");
    // LE trailer: 0000803f 0000003f 000080be 0000003e.
    assert_eq!(req.vector, vec![1.0_f32, 0.5, -0.25, 0.125]);

    let mut payload = to_cbor_bytes(&req);
    assert_eq!(payload.len(), consumed, "CBOR prefix invariant to vector");
    payload.extend_from_slice(&f32_slice_to_le_bytes(&req.vector));
    assert_eq!(payload, frame.payload, "re-encoded payload != original");

    let rebuilt = Frame::new(frame.opcode, frame.flags, frame.stream_id, payload).encode();
    assert_eq!(rebuilt, bin, "re-encoded frame != .bin");
}
