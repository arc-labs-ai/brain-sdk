//! Adversarial frame decoding: what the SDK does with bytes a hostile or buggy
//! peer sends.
//!
//! Every SDK validates magic, version, reserved bytes, reserved flag bits, both
//! CRC32Cs and the payload-length bound. That code is written three times and
//! was exercised zero times — it is the layer standing between a client and a
//! peer it does not control, and a client SDK reads bytes it did not produce by
//! definition.
//!
//! Cases come from `conformance/malformed.json` so all three SDKs feed their
//! decoders byte-identical input, the same way the corpus works. A case this
//! runner cannot reproduce fails rather than skipping.

use std::path::PathBuf;

use brain_db_sdk::wire::cbor::from_cbor_bytes;
use brain_db_sdk::wire::frame::{Frame, FrameError, HEADER_SIZE, OFF_HEADER_CRC};

fn vectors() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("conformance")
        .join("malformed.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("parse malformed.json")
}

/// The shared taxonomy name for a decode error, so the three SDKs can assert
/// against one vocabulary despite different error representations.
fn taxonomy(e: &FrameError) -> &'static str {
    match e {
        FrameError::BadMagic => "BadMagic",
        FrameError::BadVersion { .. } => "BadVersion",
        FrameError::BadHeaderCrc => "BadHeaderCrc",
        FrameError::BadPayloadCrc => "BadPayloadCrc",
        FrameError::OversizePayload { .. } => "OversizePayload",
        FrameError::ReservedNonZero => "ReservedNonZero",
        FrameError::Truncated { .. } => "Truncated",
    }
}

fn valid_frame(base: &serde_json::Value) -> Vec<u8> {
    Frame {
        opcode: u16::try_from(base["opcode"].as_u64().expect("opcode")).expect("opcode fits u16"),
        flags: u8::try_from(base["flags"].as_u64().expect("flags")).expect("flags fit u8"),
        stream_id: u32::try_from(base["stream_id"].as_u64().expect("stream_id"))
            .expect("stream_id fits u32"),
        payload: hex_decode(base["payload_hex"].as_str().expect("payload_hex")),
    }
    .encode()
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Re-stamp `header_crc32c` so a case reaches the check it is actually about.
/// Without this, any mutation inside the CRC's coverage is caught as
/// `BadHeaderCrc` first and the case under test never runs.
fn recompute_header_crc(buf: &mut [u8]) {
    buf[OFF_HEADER_CRC..OFF_HEADER_CRC + 4].fill(0);
    let mut header = [0u8; HEADER_SIZE];
    header.copy_from_slice(&buf[..HEADER_SIZE]);
    // CRC32C over header bytes 0..8 ++ 12..32 — the field itself is excluded.
    let mut covered = Vec::with_capacity(HEADER_SIZE - 4);
    covered.extend_from_slice(&header[..OFF_HEADER_CRC]);
    covered.extend_from_slice(&header[OFF_HEADER_CRC + 4..]);
    let crc = crc32c::crc32c(&covered);
    buf[OFF_HEADER_CRC..OFF_HEADER_CRC + 4].copy_from_slice(&crc.to_be_bytes());
}

#[test]
fn malformed_frames_are_rejected_with_the_right_error() {
    let v = vectors();
    let cases = v["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "no cases loaded from malformed.json");

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut buf = valid_frame(&v["base"]);

        for m in case["mutate"].as_array().expect("mutate") {
            let op = m["op"].as_str().expect("op");
            match op {
                "set" => {
                    let off = usize::try_from(m["offset"].as_u64().expect("offset"))
                        .expect("offset fits usize");
                    buf[off] =
                        u8::try_from(m["value"].as_u64().expect("value")).expect("value fits u8");
                }
                "xor" => {
                    let off = usize::try_from(m["offset"].as_u64().expect("offset"))
                        .expect("offset fits usize");
                    buf[off] ^=
                        u8::try_from(m["value"].as_u64().expect("value")).expect("value fits u8");
                }
                "truncate" => buf.truncate(
                    usize::try_from(m["len"].as_u64().expect("len")).expect("len fits usize"),
                ),
                other => panic!("{name}: unknown mutation op {other:?}"),
            }
        }
        if case["recrc"].as_bool().unwrap_or(false) {
            recompute_header_crc(&mut buf);
        }

        let want = case["expect"].as_str().expect("expect");
        match Frame::decode(&buf) {
            Ok(_) => panic!(
                "{name}: decoded a malformed frame; expected {want}\n  why: {}",
                case["why"].as_str().unwrap_or("")
            ),
            Err(e) => assert_eq!(
                taxonomy(&e),
                want,
                "{name}: wrong error\n  why: {}",
                case["why"].as_str().unwrap_or("")
            ),
        }
    }
}

#[test]
fn the_unmutated_frame_still_decodes() {
    // Proves the mutations are what break these frames, not the harness.
    let v = vectors();
    let buf = valid_frame(&v["base"]);
    let (frame, rest) = Frame::decode(&buf).expect("valid frame decodes");
    assert_eq!(
        frame.opcode,
        u16::try_from(v["base"]["opcode"].as_u64().unwrap()).expect("opcode fits u16")
    );
    assert_eq!(rest.len(), 0, "a single frame leaves no trailing bytes");
}

fn cbor_payload(spec: &str) -> Vec<u8> {
    let (kind, rest) = spec.split_once(':').expect("payload spec");
    match kind {
        "hex" => hex_decode(rest),
        "repeat" => {
            let (byte, count) = rest.split_once(':').expect("repeat spec");
            let b = u8::from_str_radix(byte, 16).expect("hex byte");
            let n: usize = count.parse().expect("count");
            let mut v = vec![b; n];
            v.push(0x00);
            v
        }
        other => panic!("unknown payload spec kind {other:?}"),
    }
}

#[test]
fn malformed_cbor_errors_rather_than_crashing() {
    // The bar is "returns Err", not "returns a particular Err". What matters is
    // that a hostile payload cannot take the process down — CVE-2026-26209 was
    // exactly this shape, a sub-100KB nested payload driving a decoder into
    // unbounded recursion. ciborium bounds it natively; the assertion here is
    // that the SDK does not undo that.
    let v = vectors();
    for case in v["cbor_cases"].as_array().expect("cbor_cases") {
        let name = case["name"].as_str().expect("name");
        let payload = cbor_payload(case["payload"].as_str().expect("payload"));
        let decoded: Result<serde_json::Value, _> = from_cbor_bytes(&payload);
        if case["expect"].as_str() == Some("error_not_crash") {
            assert!(
                decoded.is_err(),
                "{name}: decoded without error\n  why: {}",
                case["why"].as_str().unwrap_or("")
            );
        }
    }
}
