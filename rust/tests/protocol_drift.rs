//! Every wire type this SDK shares with `brain-protocol` must agree on names.
//!
//! `field_names.rs` forbids `#[serde(rename)]` here, which pins *wire key ==
//! Rust field name* inside this crate. `spec_opcode_drift.rs` and
//! `spec_error_drift.rs` in brain pin *spec == server enum*. Between those two
//! guarantees sits the one nothing checked: **server struct == SDK struct**.
//!
//! That gap is not hypothetical. Brain's tenancy rename moved `agent_id` →
//! `space_id` and `context_id` → `session_id` across the wire types, and the
//! admin plane's mint body from `agent_id_hex` → `space_id_hex`. The server
//! and the Rust SDK were updated; three callers were not, and every one of
//! them failed at runtime with `missing field 'space_id_hex'` — after the
//! rename had shipped. Two independent transcriptions of one contract with
//! nothing in between is the arrangement that produced it.
//!
//! # Why names are the right invariant
//!
//! Both sides encode with `ciborium` + `serde` derive, so a struct becomes a
//! CBOR **map keyed by field name** (see `codec/cbor.rs`: "a self-describing
//! CBOR map carrying the structured fields"). Field *order* is fixed for
//! reproducible encoding but decoding is by key, so a rename is the break that
//! matters and a reorder is not. Neither side carries a single
//! `#[serde(rename)]` — verified here for the server, and forbidden outright
//! for the SDK by `field_names.rs` — so the Rust identifier *is* the wire key
//! on both ends, and comparing identifiers compares the wire contract.
//!
//! # Direction
//!
//! Shared types only, in both directions on their members. A type present on
//! just one side is not asserted: the server legitimately owns 34 `Admin*`
//! opcodes and their payloads that no client SDK implements, and flagging
//! those would make this test noise that gets muted. What is asserted is that
//! where both sides claim to describe the *same* type, they agree completely —
//! a field added, removed, or renamed on one side only is a live
//! deserialization break and fails here.
//!
//! # Skips when brain is not checked out alongside
//!
//! This crate ships independently, so `../../brain` is not guaranteed to
//! exist. When it is absent the test prints and returns rather than failing —
//! the same shape as the eval's `BRAIN_EVAL_ENDPOINT` skip. In the workspace
//! checkout, where drift actually gets introduced, it runs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The SDK side, read at compile time so it cannot drift from the file it
/// asserts about.
const SDK_TYPES: &str = include_str!("../src/wire/types.rs");

/// Brain's protocol crate, relative to this crate's manifest.
fn brain_protocol_src() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../brain/crates/brain-protocol/src")
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Kind {
    Struct,
    Enum,
}

/// `type name -> (kind, member names in declaration order)`.
type Types = BTreeMap<String, (Kind, Vec<String>)>;

/// Pull `pub struct` / `pub enum` bodies out of Rust source.
///
/// Deliberately a line scanner rather than a real parser: it needs to be
/// dependency-free (this crate has no `syn`/`regex` dev-dependency) and it
/// only has to understand the shape these two files are actually written in —
/// one item per `pub struct X {` / `pub enum X {` line, members one per line.
fn parse(src: &str, out: &mut Types) {
    let lines: Vec<&str> = src.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let kind = if let Some(rest) = line.trim().strip_prefix("pub struct ") {
            rest.contains('{').then_some(Kind::Struct)
        } else if let Some(rest) = line.trim().strip_prefix("pub enum ") {
            rest.contains('{').then_some(Kind::Enum)
        } else {
            None
        };
        let Some(kind) = kind else {
            i += 1;
            continue;
        };

        let head = line.trim();
        let name: String = head
            .trim_start_matches("pub struct ")
            .trim_start_matches("pub enum ")
            .split(|c: char| c == '<' || c == '{' || c.is_whitespace())
            .next()
            .unwrap_or_default()
            .to_string();

        let mut depth = line.matches('{').count().saturating_sub(line.matches('}').count());
        let mut members: Vec<String> = Vec::new();
        i += 1;
        while i < lines.len() && depth > 0 {
            let ln = lines[i];
            let t = ln.trim();
            let skip = t.is_empty() || t.starts_with("//") || t.starts_with("#[");
            if depth == 1 && !skip {
                match kind {
                    Kind::Struct => {
                        if let Some(rest) = t.strip_prefix("pub ") {
                            if let Some(field) = rest.split(':').next() {
                                let f = field.trim();
                                if !f.is_empty() && f.chars().all(|c| c.is_alphanumeric() || c == '_')
                                {
                                    members.push(f.to_string());
                                }
                            }
                        }
                    }
                    Kind::Enum => {
                        let v: String = t
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect();
                        // A variant line starts with the identifier itself;
                        // anything else at depth 1 (a `}` etc.) yields empty.
                        if !v.is_empty() && v.chars().next().is_some_and(char::is_uppercase) {
                            members.push(v);
                        }
                    }
                }
            }
            depth = depth
                .saturating_add(ln.matches('{').count())
                .saturating_sub(ln.matches('}').count());
            i += 1;
        }
        out.entry(name).or_insert((kind, members));
    }
}

fn parse_dir(dir: &Path, out: &mut Types) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        if p.extension().is_some_and(|e| e == "rs") {
            if let Ok(s) = std::fs::read_to_string(&p) {
                parse(&s, out);
            }
        }
    }
}

/// Collect the server's wire types, or `None` when brain is not alongside.
fn server_types() -> Option<Types> {
    let root = brain_protocol_src();
    if !root.exists() {
        return None;
    }
    let mut out = Types::new();
    parse_dir(&root.join("ops"), &mut out);
    parse_dir(&root.join("shared"), &mut out);
    parse_dir(&root.join("envelope"), &mut out);
    Some(out)
}

fn sdk_types() -> Types {
    let mut out = Types::new();
    parse(SDK_TYPES, &mut out);
    out
}

#[test]
fn shared_wire_types_agree_with_brain_protocol() {
    let Some(server) = server_types() else {
        eprintln!(
            "brain not checked out at {} — skipping protocol drift check",
            brain_protocol_src().display()
        );
        return;
    };
    let sdk = sdk_types();

    // A parser that silently matched nothing would report a clean contract
    // forever, which is the one failure mode this test cannot afford.
    assert!(
        server.len() > 100 && sdk.len() > 100,
        "parsed too few types (server={}, sdk={}) — the scanner stopped \
         matching the source layout and this test is no longer checking anything",
        server.len(),
        sdk.len(),
    );

    let mut shared = 0usize;
    let mut drift: Vec<String> = Vec::new();
    for (name, (sdk_kind, sdk_members)) in &sdk {
        let Some((srv_kind, srv_members)) = server.get(name) else {
            continue;
        };
        shared += 1;
        if srv_kind != sdk_kind {
            drift.push(format!("{name}: server is {srv_kind:?}, SDK is {sdk_kind:?}"));
            continue;
        }
        let only_server: Vec<&String> =
            srv_members.iter().filter(|m| !sdk_members.contains(m)).collect();
        let only_sdk: Vec<&String> =
            sdk_members.iter().filter(|m| !srv_members.contains(m)).collect();
        if !only_server.is_empty() || !only_sdk.is_empty() {
            drift.push(format!(
                "{name}: server-only {only_server:?}, SDK-only {only_sdk:?}"
            ));
        }
    }

    assert!(
        shared > 100,
        "only {shared} shared types found — expected the SDK to mirror most of \
         the server's wire surface; the scanner or a path is wrong"
    );

    assert!(
        drift.is_empty(),
        "wire types disagree between brain-protocol and this SDK. Both encode \
         name-keyed CBOR maps, so a differing member name is a live \
         deserialization break for every caller.\n{}",
        drift.join("\n")
    );
}

#[test]
fn shared_opcodes_agree_with_brain_protocol() {
    /// `Name = 0x0123,` → (Name, 0x0123)
    fn discriminants(src: &str) -> BTreeMap<String, u32> {
        let mut out = BTreeMap::new();
        for line in src.lines() {
            let t = line.trim();
            let Some((name, rest)) = t.split_once(" = ") else {
                continue;
            };
            if !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_')
                || !name.chars().next().is_some_and(char::is_uppercase)
            {
                continue;
            }
            let val = rest.trim_end_matches(',').trim();
            if let Some(hex) = val.strip_prefix("0x") {
                if let Ok(v) = u32::from_str_radix(hex, 16) {
                    out.insert(name.to_string(), v);
                }
            }
        }
        out
    }

    let root = brain_protocol_src();
    if !root.exists() {
        eprintln!("brain not checked out — skipping opcode drift check");
        return;
    }
    let Ok(server_src) = std::fs::read_to_string(root.join("codec/opcode.rs")) else {
        eprintln!("brain opcode.rs unreadable — skipping");
        return;
    };
    let sdk_src = include_str!("../src/wire/opcode.rs");

    let server = discriminants(&server_src);
    let sdk = discriminants(sdk_src);
    assert!(
        server.len() > 100 && sdk.len() > 100,
        "parsed too few opcodes (server={}, sdk={})",
        server.len(),
        sdk.len()
    );

    let mismatched: Vec<String> = sdk
        .iter()
        .filter_map(|(name, sdk_val)| {
            server.get(name).and_then(|srv_val| {
                (srv_val != sdk_val)
                    .then(|| format!("{name}: server=0x{srv_val:04x} SDK=0x{sdk_val:04x}"))
            })
        })
        .collect();
    assert!(
        mismatched.is_empty(),
        "opcode values disagree — a request would route to the wrong handler:\n{}",
        mismatched.join("\n")
    );

    // An opcode the SDK can emit but the server does not know is an
    // unroutable request. The reverse (server-only) is expected: the admin
    // opcode family is deliberately not in any client SDK.
    let orphans: Vec<&String> = sdk.keys().filter(|k| !server.contains_key(*k)).collect();
    assert!(
        orphans.is_empty(),
        "SDK declares opcodes the server does not: {orphans:?}"
    );
}
