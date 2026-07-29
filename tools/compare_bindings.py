#!/usr/bin/env python3
"""Compare the Python and TypeScript wire types against the Rust SDK's.

The Rust SDK is the reference because `compare_rust.py` proves it equals the
server field-for-field, and because serde ties its field names to the wire keys
so they cannot drift apart. Python and TypeScript have no such tie — they write
the key by hand — which is why they need checking from two directions:

  * this tool, on the DECLARATIONS (does the type carry the right fields?)
  * the `field-names` suites, on the DECODED VALUES (do the bytes land in them?)

`session_filter` went missing from a declaration, which is why this half exists.

What is checked: struct presence, field names, field order, optionality,
list-ness, enum variant names, and enum discriminants.

What is NOT checked, said plainly rather than implied: integer width (a Python
`int` and a TS `number` do not say u32 vs u64 — and CBOR encodes both in
shortest form, so it does not change bytes), and byte-string vs integer-array
(`[u8; 16]` and `Vec<u8>` are both `bytes` in Python and `Uint8Array` in TS, yet
encode as different CBOR major types). That second one is a real gap in this
tool; it is covered instead by the corpus, which compares bytes.

Usage: compare_bindings.py <rust-manifest.json> <python|typescript> <types-file>
"""

from __future__ import annotations

import json
import re
import sys

# --- shared shape vocabulary ----------------------------------------------


def rust_shape(ty: str) -> str:
    """Reduce a Rust wire type to `opt`/`list`/`scalar` structure."""
    ty = ty.strip()
    m = re.match(r"^Option<(.+)>$", ty)
    if m:
        return f"opt({rust_shape(m.group(1))})"
    m = re.match(r"^Vec<(.+)>$", ty)
    if m:
        inner = m.group(1).strip()
        return "blob" if inner == "u8" else f"list({rust_shape(inner)})"
    if re.match(r"^\[u8; ?\d+\]$", ty):
        return "blob"
    if ty in ("String", "str", "&str"):
        return "str"
    if ty == "bool":
        return "bool"
    if re.match(r"^[uif]\d+$", ty):
        return "num"
    return "scalar"


def py_shape(ty: str) -> str:
    ty = ty.strip()
    m = re.match(r"^Optional\[(.+)\]$", ty)
    if m:
        return f"opt({py_shape(m.group(1))})"
    m = re.match(r"^(?:list|List)\[(.+)\]$", ty)
    if m:
        return f"list({py_shape(m.group(1))})"
    if ty in ("bytes", "bytearray"):
        return "blob"
    if ty == "str":
        return "str"
    if ty == "bool":
        return "bool"
    if ty in ("int", "float"):
        return "num"
    return "scalar"


# Simple `export type X = Y;` aliases, resolved before shaping. Without this
# every `WireUuid` field read as an opaque scalar and 100+ correct fields were
# reported as mismatches.
TS_ALIASES: dict[str, str] = {}


def ts_shape(ty: str) -> str:
    ty = ty.strip().rstrip(";")
    seen = 0
    while ty in TS_ALIASES and seen < 8:
        ty = TS_ALIASES[ty]
        seen += 1
    # `X | null` is TypeScript's Option.
    parts = [p.strip() for p in re.split(r"\|(?![^<]*>)", ty)]
    if "null" in parts or "undefined" in parts:
        rest = [p for p in parts if p not in ("null", "undefined")]
        if rest:
            return f"opt({ts_shape(' | '.join(rest))})"
    if ty == "Uint8Array":
        return "blob"
    m = re.match(r"^(.+)\[\]$", ty)
    if m:
        inner = m.group(1).strip()
        return "blob" if inner == "Uint8Array" else f"list({ts_shape(inner)})"
    m = re.match(r"^(?:Array|ReadonlyArray)<(.+)>$", ty)
    if m:
        return f"list({ts_shape(m.group(1))})"
    if ty == "string":
        return "str"
    if ty == "boolean":
        return "bool"
    if ty in ("number", "bigint"):
        return "num"
    return "scalar"


# --- extractors ------------------------------------------------------------


def extract_python(text: str) -> dict:
    """`@dataclass` field declarations and int-constant enum classes."""
    structs: dict = {}
    enums: dict = {}
    # Iterate class definitions directly. Splitting the file on
    # `@dataclass|class` instead put the decorator in the *previous* chunk —
    # every dataclass then looked like a plain class and 209 types silently
    # vanished from the comparison.
    starts = [m for m in re.finditer(r"^class (\w+)", text, re.M)]
    for i, m in enumerate(starts):
        name = m.group(1)
        end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        body = text[m.end() : end]
        # Stop at the first method: everything above is the field list.
        cut = re.search(r"\n    (?:def |@classmethod|@staticmethod)", body)
        decls = body[: cut.start()] if cut else body
        # Drop the docstring: a prose line like "Unlike X: ..." otherwise parses
        # as a field declaration.
        decls = re.sub(r'"""(?:.|\n)*?"""', "", decls)

        # The decorator sits on the line(s) directly above the `class`.
        preceding = text[:  m.start()].rstrip().rsplit("\n", 1)[-1].strip()
        if preceding.startswith("@dataclass"):
            fields = []
            for fm in re.finditer(r"^    (\w+)\s*:\s*([^=\n]+?)(?:\s*=.*)?$", decls, re.M):
                fname = fm.group(1)
                fty = fm.group(2).split("#", 1)[0].strip().strip('"')
                if fname.startswith("_"):
                    continue
                has_default = "=" in fm.group(0).split(":", 1)[1]
                fields.append(
                    {"name": fname, "shape": py_shape(fty), "default": has_default}
                )
            structs[name] = {"fields": fields}
        else:
            variants = [
                {"name": vm.group(1), "discriminant": int(vm.group(2), 0)}
                for vm in re.finditer(r"^    ([A-Z][A-Z0-9_]*)\s*=\s*(-?\w+)\s*$", decls, re.M)
            ]
            if variants:
                enums[name] = {"variants": variants}
    return {"structs": structs, "enums": enums}


def extract_typescript(text: str) -> dict:
    """`export interface` property declarations and `as const` enum objects."""
    structs: dict = {}
    enums: dict = {}

    for m in re.finditer(r"^export type (\w+) = ([A-Za-z0-9_<>\[\]]+);\s*$", text, re.M):
        TS_ALIASES[m.group(1)] = m.group(2)
    # A union of string literals is how TypeScript spells a unit-only tagged
    # enum; it is a string on the wire.
    for m in re.finditer(r'^export type (\w+) =((?:\s*\|?\s*"[^"]+")+);', text, re.M):
        TS_ALIASES[m.group(1)] = "string"

    for m in re.finditer(r"export interface (\w+)\s*\{", text):
        name = m.group(1)
        depth = 0
        for j in range(m.end() - 1, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
        body = text[m.end() : j]
        # Drop comments so a `//` or `/** */` cannot look like a property.
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        body = re.sub(r"//[^\n]*", "", body)
        fields = []
        for fm in re.finditer(r"^\s{2}(\w+)(\??)\s*:\s*([^;]+);", body, re.M):
            shape = ts_shape(fm.group(3))
            if fm.group(2) == "?" and not shape.startswith("opt("):
                shape = f"opt({shape})"
            fields.append({"name": fm.group(1), "shape": shape})
        structs[name] = {"fields": fields}

    for m in re.finditer(r"export enum (\w+)\s*\{", text):
        depth = 0
        for j in range(m.end() - 1, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
        body = re.sub(r"//[^\n]*", "", text[m.end() : j])
        variants = [
            {"name": vm.group(1), "discriminant": int(vm.group(2), 0)}
            for vm in re.finditer(r"(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)", body)
        ]
        if variants:
            enums[m.group(1)] = {"variants": variants}

    for m in re.finditer(r"export const (\w+) = \{(.*?)\}\s*as const;", text, re.S):
        body = re.sub(r"//[^\n]*", "", m.group(2))
        variants = [
            {"name": vm.group(1), "discriminant": int(vm.group(2), 0)}
            for vm in re.finditer(r"(\w+)\s*:\s*(0x[0-9a-fA-F]+|\d+)\s*,", body)
        ]
        if variants:
            enums[m.group(1)] = {"variants": variants}
    return {"structs": structs, "enums": enums}


# --- comparison ------------------------------------------------------------

def leaf_agnostic(shape: str) -> str:
    """Collapse leaf distinctions the bindings cannot express.

    A repr enum is `MemoryKindWire` in Rust and a plain `int`/`number`
    elsewhere; a byte blob is `bytes`/`Uint8Array` whether the wire carries a
    CBOR byte string or an array of integers. Neither distinction survives into
    a Python annotation or a TS type, so comparing them here produces noise
    rather than signal. Both are pinned by the corpus, which compares bytes.
    """
    for leaf in ("scalar", "num"):
        shape = re.sub(rf"\b{leaf}\b", "leaf", shape)
    return shape


def enum_aware_shape(ty: str, ref: dict) -> str:
    """Shape a Rust type, resolving tagged enums to their binding-side form.

    A tagged enum with only unit variants encodes as a bare CBOR string, and the
    bindings model it as `str` / a string-literal union — correctly. One with a
    payload variant encodes as a single-key map for that variant, so a binding
    typing it `str` alone cannot express it.
    """
    inner = re.sub(r"^(?:Option|Vec)<(.+)>$", r"\1", ty.strip())
    e = ref["enums"].get(inner)
    if e and e["encoding"] == "tagged":
        has_payload = any("payload" in v or "struct" in v for v in e["variants"])
        leaf = "str_or_map" if has_payload else "str"
        return rust_shape(ty).replace("scalar", leaf)
    return rust_shape(ty)


def shapes_compatible(want: str, got: str) -> bool:
    """Whether two collapsed shapes describe the same wire value.

    `blob` and `list(leaf)` are interchangeable: Rust's `Vec<u8>` encodes as a
    CBOR array of integers and `[u8; N]` as a byte string, but Python annotates
    both `bytes` and TypeScript both `Uint8Array`, and some fields are annotated
    `list[int]` instead. The distinction is real and is pinned by the corpus;
    it simply is not visible in a type annotation.
    """
    if want == got:
        return True
    blobbish = {"blob", "list(leaf)"}
    if want in blobbish and got in blobbish:
        return True
    # A tagged enum with a payload variant needs a union on the binding side;
    # `scalar` is what a union shapes to. A bare `str` is too narrow.
    if want == "str_or_map" and got in ("leaf", "scalar"):
        return True
    if want.startswith("opt(") and got.startswith("opt("):
        return shapes_compatible(want[4:-1], got[4:-1])
    return False


# camelCase -> snake_case, for the TypeScript side.
def snake(s: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s).lower()


# Python renames fields that collide with keywords.
PY_ALIASES = {"from_": "from"}

# Types a binding deliberately declares as a partial view. Each needs a reason
# recorded in the binding itself, not just here.
# A binding may satisfy a Rust type with a differently-named one, or fold
# several into a shared one, provided the wire shape is identical. Each entry
# below was checked field-for-field before being added; `verify_equivalences`
# re-checks them on every run so an entry cannot rot into a blanket skip.
EQUIVALENT_TYPES: dict[str, dict[str, str]] = {
    "typescript": {
        # One shared response/request type where the server names two.
        "EntityUpdateResponse": "EntityViewResponse",
        "EntityRenameResponse": "EntityViewResponse",
        "StatementTombstoneRequest": "StatementReasonRequest",
        "StatementRetractRequest": "StatementReasonRequest",
    },
    "python": {},
}

# Types a binding legitimately does not name at all.
UNNAMED_TYPES: dict[str, dict[str, str]] = {
    "typescript": {
        "MtlsClaim": "inlined into the AuthCredentials union variant "
        "`{ kind: 'Mtls'; certFingerprint; assertedSubject }` — same wire shape, no separate name",
        "Frame": "SDK-local decoded frame, never CBOR-encoded; the corpus frame_* cases pin the bytes",
    },
    "python": {"Frame": "SDK-local decoded frame, never CBOR-encoded"},
}

# Enums a binding satisfies with an identical one under another name.
EQUIVALENT_ENUMS: dict[str, dict[str, str]] = {
    "typescript": {
        # Byte-identical to RankedItemKindWire (Memory/Statement/Entity/Relation
        # = 0..3); the bindings name it once rather than twice.
        "RecallCandidateKind": "RankedItemKindWire",
        # A string on the wire, so TypeScript spells it as a string-literal
        # union rather than a numeric enum.
        "RetrieverWire": None,
    },
    "python": {
        "RecallCandidateKind": "RankedItemKindWire",
        # Modelled as the `Retriever` string-constant class, not an int enum.
        "RetrieverWire": None,
    },
}

DOCUMENTED_SUBSETS: dict[str, str] = {
    "ErrorCodeWire": "the bindings name only the codes they reason about; "
    "ErrorResponse.code is a plain integer, so unnamed codes still round-trip",
    "ErrorCode": "same",
}


def compare(ref: dict, other: dict, lang: str) -> tuple[list[str], int]:
    problems: list[str] = []
    key = (lambda n: PY_ALIASES.get(n, n)) if lang == "python" else snake
    compared = 0

    def counterpart(n: str, pool: dict) -> str | None:
        # Rust suffixes wire-domain types with `Wire`; Python and TypeScript
        # drop it. A naming convention, not a discrepancy.
        for candidate in (n, n[:-4] if n.endswith("Wire") else None):
            if candidate and candidate in pool:
                return candidate
        return None

    # An equivalence is a claim that two differently-named types have the same
    # wire shape. Re-checked here every run, so an entry cannot decay into a
    # blanket skip if either side changes.
    for rust_name, other_name in EQUIVALENT_TYPES.get(lang, {}).items():
        if rust_name not in ref["structs"] or other_name not in other["structs"]:
            problems.append(
                f"EQUIVALENCE {rust_name} == {other_name}: one side no longer exists"
            )
            continue
        a = [f["name"] for f in ref["structs"][rust_name]["fields"]]
        b = [key(f["name"]) for f in other["structs"][other_name]["fields"]]
        if a != b:
            problems.append(
                f"EQUIVALENCE {rust_name} == {other_name} no longer holds\n"
                f"      rust: {a}\n      {lang}: {b}"
            )

    for name, r_def in sorted(ref["structs"].items()):
        if name in UNNAMED_TYPES.get(lang, {}):
            continue
        name = EQUIVALENT_TYPES.get(lang, {}).get(name, name)
        name = counterpart(name, other["structs"]) or name
        if name not in other["structs"]:
            # Not every Rust type needs a named counterpart — some are inlined
            # into a parent. Reported so the omission is a decision.
            problems.append(f"MISSING TYPE {name}: no {lang} declaration")
            continue
        compared += 1
        r_fields = [f for f in r_def["fields"]]
        o_fields = other["structs"][name]["fields"]

        r_names = [f["name"] for f in r_fields]
        o_names = [key(f["name"]) for f in o_fields]

        missing = [n for n in r_names if n not in o_names]
        extra = [n for n in o_names if n not in r_names]
        if missing:
            problems.append(f"{name}: MISSING fields {missing}")
        if extra:
            problems.append(f"{name}: EXTRA fields {extra}")

        shared_r = [n for n in r_names if n in o_names]
        shared_o = [n for n in o_names if n in r_names]
        if shared_r != shared_o:
            defaulted = {
                key(f["name"]) for f in o_fields if f.get("default")
            }
            # Drop the defaulted fields from both sides: if what remains agrees,
            # the only difference is where the language forced them to sit.
            if [n for n in shared_r if n not in defaulted] != [
                n for n in shared_o if n not in defaulted
            ] or not defaulted:
                problems.append(
                    f"{name}: field ORDER differs\n      rust: {shared_r}\n"
                    f"      {lang}: {shared_o}"
                )

        o_by = {key(f["name"]): f for f in o_fields}
        for f in r_fields:
            g = o_by.get(f["name"])
            if not g:
                continue
            want = leaf_agnostic(enum_aware_shape(f["type"], ref))
            got = leaf_agnostic(g["shape"])
            # `skip_serializing_if` on a NON-Option Rust field means "omit when
            # it holds its default"; a binding spelling that as an optional
            # property models the same thing. When the Rust field is already an
            # Option the two `opt(...)`s must line up as usual.
            if (
                f.get("serde", {}).get("skip_serializing_if")
                and not want.startswith("opt(")
                and got.startswith("opt(")
            ):
                got = got[4:-1]
            if not shapes_compatible(want, got):
                problems.append(
                    f"{name}.{f['name']}: SHAPE rust={rust_shape(f['type'])} {lang}={g['shape']}"
                )

    for name, r_def in sorted(ref["enums"].items()):
        r_variants = {v["name"]: v.get("discriminant") for v in r_def["variants"]}
        if not any(d is not None for d in r_variants.values()):
            continue  # tagged enum: no discriminants to compare
        if name in DOCUMENTED_SUBSETS:
            continue
        if name in EQUIVALENT_ENUMS.get(lang, {}):
            alias = EQUIVALENT_ENUMS[lang][name]
            if alias is None:
                continue  # not an int enum in this binding
            name = alias
        name = counterpart(name, other["enums"]) or name
        if name not in other["enums"]:
            problems.append(f"MISSING ENUM {name}: no {lang} declaration")
            continue
        compared += 1
        o_variants = {}
        for v in other["enums"][name]["variants"]:
            o_variants[snake(v["name"]).replace("_", "").lower()] = v["discriminant"]
        for vn, disc in r_variants.items():
            got = o_variants.get(vn.lower().replace("_", ""))
            if got is None:
                problems.append(f"ENUM {name}::{vn}: missing from {lang}")
            elif got != disc:
                problems.append(f"ENUM {name}::{vn}: DISCRIMINANT rust={disc} {lang}={got}")

    return problems, compared


if __name__ == "__main__":
    ref = json.load(open(sys.argv[1]))
    lang = sys.argv[2]
    text = open(sys.argv[3]).read()
    other = extract_python(text) if lang == "python" else extract_typescript(text)

    found, compared = compare(ref, other, lang)
    print(
        f"{lang}: extracted {len(other['structs'])} types / {len(other['enums'])} enums; "
        f"compared {compared} against the Rust reference"
    )
    print(f"discrepancies: {len(found)}\n")
    for p in found:
        print(f"  {p}")
    sys.exit(1 if found else 0)
