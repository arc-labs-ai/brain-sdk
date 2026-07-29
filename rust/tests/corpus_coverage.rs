//! Coverage gate: every opcode is either pinned by the corpus or on the
//! tracked gap list. Nothing gets to be silently unverified.
//!
//! The corpus is the only oracle in this repo that comes from outside it. Every
//! other suite — round-trips, mock servers, cross-language parity — is built
//! from the SDK's own types, so an opcode with no corpus vector is verified by
//! nothing but its own reflection.
//!
//! That is not theoretical. `QueryRequest` was missing `session_filter` in all
//! three SDKs; the server treats a missing `Option` as `None` rather than an
//! error, so a session-scoped query silently searched every session. Both verbs
//! that carry it, QUERY_EXPLAIN and QUERY_TRACE, are on the gap list.
//!
//! This test does not demand the gap be closed. It demands the gap be *known*:
//! add an opcode, and it must show up in the corpus or in `coverage.json`.

use std::collections::BTreeSet;
use std::path::PathBuf;

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("conformance")
}

fn read_json(path: PathBuf) -> serde_json::Value {
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// `(name, value)` for every opcode the SDK declares, read from the source at
/// compile time so this cannot drift from the enum it is asserting about.
fn declared_opcodes() -> Vec<(String, u16)> {
    const SRC: &str = include_str!("../src/wire/opcode.rs");
    SRC.lines()
        .filter_map(|line| {
            // Variants are `    Name = 0x0000,` at exactly one indent level.
            // Deeper indentation is the test module's `assert_eq!` lines.
            let rest = line.strip_prefix("    ")?;
            if rest.starts_with([' ', '/', '#']) {
                return None;
            }
            let (name, value) = rest.split_once(" = 0x")?;
            let hex: String = value.chars().take_while(char::is_ascii_hexdigit).collect();
            Some((name.trim().to_string(), u16::from_str_radix(&hex, 16).ok()?))
        })
        .collect()
}

#[test]
fn every_opcode_is_corpus_pinned_or_on_the_tracked_gap_list() {
    let index = read_json(conformance_dir().join("corpus").join("index.json"));
    let covered_values: BTreeSet<u16> = index
        .as_array()
        .expect("index.json is an array")
        .iter()
        .map(|c| {
            let hex = c["opcode"].as_str().expect("opcode is a string");
            u16::from_str_radix(hex.trim_start_matches("0x"), 16).expect("opcode parses")
        })
        .collect();

    // Matched by VALUE, not name: the three SDKs spell the variants
    // differently (`EntityGetReq` / `ENTITY_GET_REQ` / `EntityGetReq`), and the
    // number is the thing the wire actually carries.
    let coverage = read_json(conformance_dir().join("coverage.json"));
    let gap: BTreeSet<u16> = coverage["opcode_values"]
        .as_object()
        .expect("coverage.opcode_values is an object")
        .values()
        .map(|v| {
            let hex = v.as_str().expect("opcode value is a string");
            u16::from_str_radix(hex.trim_start_matches("0x"), 16).expect("opcode parses")
        })
        .collect();

    let declared = declared_opcodes();
    assert!(
        declared.len() > 100,
        "opcode parsing found only {} variants — the parser has drifted from the file",
        declared.len()
    );

    let unaccounted: Vec<String> = declared
        .iter()
        .filter(|(_, value)| !covered_values.contains(value) && !gap.contains(value))
        .map(|(name, value)| format!("{name} ({value:#06x})"))
        .collect();
    assert!(
        unaccounted.is_empty(),
        "these opcodes have no corpus vector and are not on the tracked gap list, so nothing \
         verifies their wire shape. Add a corpus case upstream in brain, or add the name to \
         conformance/coverage.json with the rest.\n{unaccounted:#?}"
    );

    // The gap list must not outlive the gap: an entry that has since been
    // covered has to be deleted, or the list stops meaning anything.
    let stale: Vec<String> = declared
        .iter()
        .filter(|(_, value)| covered_values.contains(value) && gap.contains(value))
        .map(|(name, value)| format!("{name} ({value:#06x})"))
        .collect();
    assert!(
        stale.is_empty(),
        "these opcodes now HAVE a corpus vector but are still listed as uncovered in \
         conformance/coverage.json — delete them from it.\n{stale:#?}"
    );
}
