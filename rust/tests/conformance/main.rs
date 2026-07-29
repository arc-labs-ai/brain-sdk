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

use std::collections::BTreeMap;
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

/// `req_encode_vector_direct.bin` is `CBOR map ++ raw LE f32`, so it needs the
/// prefix codec plus the trailing-vector seam rather than the whole-buffer
/// decode `check_payload` uses. Decode the CBOR prefix, attach the trailer to
/// `vector`, check the JSON projection (the `.json` mirror omits `vector`,
/// which is `serde(skip)`), then re-encode prefix + trailer byte-exact.
fn check_vector_payload(name: &str) {
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

/// The ENCODE_VECTOR_DIRECT *frame* payload is `CBOR map ++ raw LE f32`.
/// Decode the prefix to the struct, read the trailer into `vector`, then
/// re-encode (CBOR prefix + trailer) and assert the whole frame is byte-exact.
fn check_vector_frame(name: &str) {
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

// ---------------------------------------------------------------------------
// Case registry, driven by `index.json`.
//
// The case list used to be a hand-written sequence of `check_payload::<T>(name)`
// calls. It covered every case, but nothing said so: add a vector to the corpus
// and Rust would silently not test it, while Python and TypeScript — both
// index-driven — would fail loudly. Registering the handlers by name and
// iterating the index closes that asymmetry.
//
// A `Box<dyn Fn(&str)>` is what lets heterogeneous `check_payload::<T>` share
// one map: each monomorphised instance already has the shape `fn(&str)`.
// ---------------------------------------------------------------------------

type Checker = Box<dyn Fn(&str)>;

fn registry() -> BTreeMap<&'static str, Checker> {
    let mut m: BTreeMap<&'static str, Checker> = BTreeMap::new();

    /// `payload!("case_name", TypeName)` — whole-buffer CBOR round-trip.
    macro_rules! payload {
        ($name:literal, $t:ty) => {
            m.insert($name, Box::new(check_payload::<$t>) as Checker);
        };
    }

    payload!("req_hello", HelloPayload);
    payload!("req_auth", AuthPayload);
    payload!("resp_welcome", WelcomePayload);
    payload!("resp_auth_ok", AuthOkPayload);
    payload!("req_encode", EncodeRequest);
    payload!("req_encode_trace", EncodeRequest);
    payload!("req_encode_allow_duplicates", EncodeRequest);
    payload!("req_recall", RecallRequest);
    payload!("req_forget", ForgetRequest);
    payload!("req_encode_act_as", EncodeRequest);
    payload!("req_recall_act_as", RecallRequest);
    payload!("req_forget_act_as", ForgetRequest);
    payload!("req_plan_act_as", PlanRequest);
    payload!("req_reason_act_as", ReasonRequest);
    payload!("req_entity_create_act_as", EntityCreateRequest);
    payload!("resp_auth_ok_act_as", AuthOkPayload);
    payload!("resp_error_act_as_denied", ErrorResponse);
    payload!("resp_encode", EncodeResponse);
    payload!("resp_encode_trace", EncodeResponse);
    payload!("resp_recall", RecallResponseFrame);
    payload!("resp_recall_trace", RecallResponseFrame);
    payload!("req_memory_list", MemoryListRequest);
    payload!("resp_memory_list", MemoryListResponseFrame);
    payload!("req_memory_inspect", MemoryInspectRequest);
    payload!("resp_memory_inspect", MemoryInspectResponse);
    payload!("req_graph_fetch", GraphFetchRequest);
    payload!("resp_graph_fetch", GraphFetchResponseFrame);
    payload!("resp_forget", ForgetResponse);
    payload!("req_entity_create", EntityCreateRequest);
    payload!("resp_entity_create", EntityCreateResponse);
    payload!("req_statement_create", StatementCreateRequest);
    payload!("resp_statement_create", StatementCreateResponse);
    payload!("req_relation_create", RelationCreateRequest);
    payload!("resp_relation_create", RelationCreateResponse);
    payload!("req_schema_upload", SchemaUploadRequest);
    payload!("resp_schema_upload", SchemaUploadResponse);
    payload!("req_materialize_procedural", MaterializeProceduralRequest);
    payload!("resp_materialize_procedural", MaterializeProceduralResponse);
    payload!("resp_entity_get", EntityGetResponse);
    payload!("resp_entity_list", EntityListResponseFrame);
    payload!("resp_entity_resolve", EntityResolveResponse);
    payload!("resp_statement_get", StatementGetResponse);
    payload!("resp_statement_list", StatementListResponseFrame);
    payload!("resp_relation_list", RelationListFromResponseFrame);
    payload!("resp_plan", PlanResponseFrame);
    payload!("resp_plan_trace", PlanResponseFrame);
    payload!("resp_reason", ReasonResponseFrame);
    payload!("resp_reason_trace", ReasonResponseFrame);
    payload!("resp_link", LinkResponse);
    payload!("resp_txn_begin", TxnBeginResponse);
    payload!("resp_txn_commit", TxnCommitResponse);
    payload!("resp_txn_abort", TxnAbortResponse);
    payload!("resp_get_capabilities", GetCapabilitiesResponse);
    payload!("resp_subscribe_event", SubscriptionEvent);
    payload!("req_space_create", SpaceCreateRequest);
    payload!("req_space_list", SpaceListRequest);
    payload!("req_space_delete", SpaceDeleteRequest);
    payload!("resp_space_create", SpaceCreateResponse);
    payload!("resp_space_list", SpaceListResponse);
    payload!("resp_space_delete", SpaceDeleteResponse);
    payload!("req_session_create", SessionCreateRequest);
    payload!("req_session_list", SessionListRequest);
    payload!("req_session_delete", SessionDeleteRequest);
    payload!("resp_session_create", SessionCreateResponse);
    payload!("resp_session_list", SessionListResponse);
    payload!("resp_session_delete", SessionDeleteResponse);
    payload!("req_extractor_list", ExtractorListRequest);
    payload!("resp_extractor_list", ExtractorListResponseFrame);
    payload!("resp_pong", PongResponse);
    payload!("resp_server_ping", ServerPingResponse);

    payload!("req_query_explain", QueryExplainRequest);
    payload!("req_query_trace", QueryTraceRequest);
    payload!("resp_query_explain", QueryExplainResponse);
    payload!("resp_query_trace", QueryTraceResponse);

    // One ERROR body per category; all share `ErrorResponse`.
    payload!("resp_error_protocol", ErrorResponse);
    payload!("resp_error_authentication", ErrorResponse);
    payload!("resp_error_authorization", ErrorResponse);
    payload!("resp_error_validation", ErrorResponse);
    payload!("resp_error_not_found", ErrorResponse);
    payload!("resp_error_conflict", ErrorResponse);
    payload!("resp_error_resource_exhausted", ErrorResponse);
    payload!("resp_error_internal", ErrorResponse);
    payload!("resp_error_unavailable", ErrorResponse);

    // Full-frame cases: 32-byte header + payload.
    m.insert("frame_hello", Box::new(check_frame) as Checker);
    m.insert("frame_welcome", Box::new(check_frame) as Checker);
    m.insert("frame_encode", Box::new(check_frame) as Checker);
    m.insert("frame_error", Box::new(check_frame) as Checker);
    m.insert("frame_recall_eos", Box::new(check_frame) as Checker);
    m.insert(
        "frame_encode_vector_direct",
        Box::new(check_frame) as Checker,
    );

    // The two ENCODE_VECTOR_DIRECT cases carry `CBOR map ++ raw LE f32`, so
    // they need the prefix codec plus the trailing-vector seam rather than the
    // whole-buffer decode the others use.
    m.insert(
        "req_encode_vector_direct",
        Box::new(check_vector_payload) as Checker,
    );
    m.insert(
        "frame_encode_vector_direct",
        Box::new(check_vector_frame) as Checker,
    );

    m
}

/// Every case the vendored `index.json` declares.
fn index_cases() -> Vec<String> {
    let text = std::fs::read_to_string(corpus_dir().join("index.json")).expect("read index.json");
    let index: serde_json::Value = serde_json::from_str(&text).expect("parse index.json");
    index
        .as_array()
        .expect("index.json is an array")
        .iter()
        .map(|c| c["name"].as_str().expect("case name").to_string())
        .collect()
}

#[test]
fn every_corpus_case_has_a_handler() {
    let reg = registry();
    let cases = index_cases();
    assert!(!cases.is_empty(), "index.json produced no cases");

    let missing: Vec<&String> = cases
        .iter()
        .filter(|n| !reg.contains_key(n.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "corpus cases with no Rust handler — add them to registry(), or they go untested \
         here while Python and TypeScript check them: {missing:#?}"
    );

    // The other direction: a handler for a case the corpus no longer carries is
    // dead weight that reads like coverage.
    let names: std::collections::BTreeSet<&str> = cases.iter().map(String::as_str).collect();
    let stale: Vec<&&str> = reg.keys().filter(|k| !names.contains(*k)).collect();
    assert!(
        stale.is_empty(),
        "handlers for cases not in index.json — delete them: {stale:#?}"
    );
}

#[test]
fn all_corpus_cases_round_trip() {
    let reg = registry();
    for name in index_cases() {
        let check = reg.get(name.as_str()).unwrap_or_else(|| {
            panic!("no handler for {name}; every_corpus_case_has_a_handler should have caught this")
        });
        check(&name);
    }
}
