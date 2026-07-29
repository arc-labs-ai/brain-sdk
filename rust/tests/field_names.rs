//! Pins the invariant that makes a separate field-name guard unnecessary here.
//!
//! The Python and TypeScript SDKs each carry a `field-names` suite, because in
//! those languages the declared field and the wire key are independent strings:
//! `to_map()` / `encodeX()` write the key by hand, so a decoder and its encoder
//! can be inverted together and every byte-level assertion still passes. That
//! was verified by injecting exactly such a swap — all 134 Python tests and all
//! 88 TypeScript conformance cases stayed green while the caller read the wrong
//! value.
//!
//! Rust is not exposed to that, but for a specific reason worth writing down:
//! serde derives the wire key **from the field name**, so the two cannot
//! diverge — unless someone adds `#[serde(rename)]`. That single attribute is
//! the whole attack surface, and it is what this test forbids.
//!
//! For completeness, a rename would in fact be caught today: swapping two
//! renames also swaps their emission order, and `conformance` compares bytes.
//! But that is incidental — it holds only because struct order drives map
//! order. Forbidding the attribute keeps the guarantee resting on something
//! stated rather than on a coincidence of the encoding.
//!
//! `rename_all` is covered by the same check: it would silently recase every
//! key in a struct.

/// The wire types, read at compile time so this cannot drift from the file it
/// is asserting about.
const WIRE_TYPES: &str = include_str!("../src/wire/types.rs");

#[test]
fn wire_types_never_rename_a_field() {
    let offenders: Vec<(usize, &str)> = WIRE_TYPES
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("serde(rename"))
        .map(|(i, line)| (i + 1, line.trim()))
        .collect();

    assert!(
        offenders.is_empty(),
        "`#[serde(rename)]` decouples the Rust field name from the wire key, which is the \
         one way this SDK can hand a caller a value under the wrong name. If a rename is \
         genuinely required, add a field-name suite here first — see \
         python/tests/test_field_names.py and typescript/test/field-names.test.ts.\n\
         Found:\n{offenders:#?}"
    );
}

/// The serde attributes the wire types are allowed to use.
///
/// Not style policing: each of these changes what goes on the wire, and the
/// list exists so a new one has to be considered against the corpus rather
/// than arriving unnoticed. `with` selects a codec (`serde_bytes`,
/// `opt_byte_array16`), `skip_serializing_if` + `default` are the
/// omitted-when-default convention, `skip` is the raw-trailer vector.
#[test]
fn wire_types_use_only_reviewed_serde_attributes() {
    const ALLOWED: &[&str] = &["with", "skip_serializing_if", "default", "skip"];

    let mut unexpected: Vec<(usize, String)> = Vec::new();
    for (i, line) in WIRE_TYPES.lines().enumerate() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("#[serde(") else {
            continue;
        };
        for attr in rest.trim_end_matches(")]").split(',') {
            let name = attr.trim().split(['=', '(']).next().unwrap_or("").trim();
            if name.is_empty() || ALLOWED.contains(&name) {
                continue;
            }
            unexpected.push((i + 1, name.to_string()));
        }
    }

    assert!(
        unexpected.is_empty(),
        "unreviewed serde attribute in the wire types — every attribute here changes the \
         bytes, so add a corpus case that pins the new behaviour before allowing it.\n\
         Allowed: {ALLOWED:?}\nFound:\n{unexpected:#?}"
    );
}
