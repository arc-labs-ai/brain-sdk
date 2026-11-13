//! The extractor stage payload's wire keys, decoded from bytes this test
//! builds itself.
//!
//! `StageExtractorPayload` exists in two places — the engine
//! (`brain/crates/brain-protocol/src/shared/enums.rs`) and here. Nothing
//! compiles both, and each derives its serde keys from its own field names,
//! so a spelling that drifts in either copy compiles and passes clippy while
//! the consumer silently reads a default.
//!
//! These cases therefore build the CBOR map from explicit key strings rather
//! than round-tripping this crate's struct, which would only prove the file
//! agrees with itself.
//!
//! The yield counts are strict — no `#[serde(default)]` — so a mismatch is a
//! decode error rather than a silent `0`.

use brain_db_sdk::wire::types::{StageAuditStatus, StageExtractorPayload};
use ciborium::value::{Integer, Value};

/// Build a CBOR map from `(key, value)` pairs, keys written out longhand.
fn cbor(pairs: Vec<(&str, Value)>) -> Vec<u8> {
    let map = Value::Map(
        pairs
            .into_iter()
            .map(|(k, v)| (Value::Text(k.to_string()), v))
            .collect(),
    );
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&map, &mut bytes).expect("encode");
    bytes
}

fn int(n: u32) -> Value {
    Value::Integer(Integer::from(n))
}

/// Every field the engine sends, under the exact key it sends it under.
fn full_payload() -> Vec<u8> {
    cbor(vec![
        ("entity_count", int(11)),
        ("statement_count", int(22)),
        ("relation_count", int(33)),
        ("dropped_count", int(44)),
        ("contradiction_count", int(55)),
        ("undeclared_entity_count", int(66)),
        ("has_active_schema", Value::Bool(true)),
        ("audit_status", int(0)),
        ("error_message", Value::Text(String::new())),
    ])
}

#[test]
fn the_yield_counts_decode_from_the_keys_the_engine_writes() {
    let p: StageExtractorPayload =
        ciborium::de::from_reader(full_payload().as_slice()).expect("decode");

    assert_eq!(p.entity_count, 11);
    assert_eq!(p.statement_count, 22);
    assert_eq!(p.relation_count, 33);
    // The counts a spelling drift would leave unbound.
    assert_eq!(p.dropped_count, 44, "`dropped_count` key did not bind");
    assert_eq!(
        p.contradiction_count, 55,
        "`contradiction_count` key did not bind"
    );
    assert_eq!(
        p.undeclared_entity_count, 66,
        "`undeclared_entity_count` key did not bind"
    );
    assert!(
        p.has_active_schema,
        "`has_active_schema` key did not bind; the undeclared count has no \
         denominator without it"
    );
}

/// A payload without the yield counts is refused rather than defaulted.
///
/// `0` is a real reading — "nothing was discarded" — so a defaulted value
/// would be indistinguishable from a version mismatch. The engine must ship
/// these fields before any consumer that reads them.
#[test]
fn a_payload_missing_the_yield_counts_is_refused() {
    let bytes = cbor(vec![
        ("entity_count", int(1)),
        ("statement_count", int(2)),
        ("relation_count", int(3)),
        ("audit_status", int(0)),
        ("error_message", Value::Text(String::new())),
    ]);
    let got: Result<StageExtractorPayload, _> = ciborium::de::from_reader(bytes.as_slice());
    assert!(
        got.is_err(),
        "a payload with no `dropped_count` must fail to decode, not read as 0"
    );
}

/// Every field the struct declares survives its own encode/decode, so a field
/// present on the wire is one this crate actually reads.
#[test]
fn the_payload_round_trips_through_its_own_encoder() {
    let want = StageExtractorPayload {
        entity_count: 7,
        statement_count: 8,
        relation_count: 9,
        dropped_count: 10,
        contradiction_count: 11,
        undeclared_entity_count: 12,
        has_active_schema: true,
        audit_status: StageAuditStatus::Succeeded,
        error_message: "x".to_string(),
    };
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&want, &mut bytes).expect("encode");
    let back: StageExtractorPayload = ciborium::de::from_reader(bytes.as_slice()).expect("decode");
    assert_eq!(back, want);
}
