#!/usr/bin/env python3
"""Compare the Rust SDK's wire manifest against the server's.

Reports only on types the SDK actually declares — the SDK deliberately covers a
subset of the server's surface (admin ops, for instance, are not a data-plane
concern). What it must never do is declare a type *differently*.

Every dimension that changes bytes is checked: field names, field order, field
types, the serde attributes that select a codec or omit a value, enum variant
names, enum discriminants, and the integer-vs-tagged enum encoding.

Usage: compare_rust.py <server-manifest.json> <sdk-manifest.json>
"""

from __future__ import annotations

import json
import sys

# Fields the SDK is allowed to carry that the server's struct does not, because
# they do not come from that struct's CBOR map.
KNOWN_LOCAL_FIELDS: dict[tuple[str, str], str] = {
    ("EncodeVectorDirectRequest", "vector"): "rides the payload's raw f32 trailer, not the CBOR",
}

# SDK-local types that happen to share a name with a server type but are not the
# same thing. Narrow and reasoned on purpose: a blanket skip list would hide the
# very drift this tool exists to find.
SDK_LOCAL_TYPES: dict[str, str] = {
    "Frame": "the SDK's decoded frame (opcode/flags/stream_id/payload); the server's "
    "`Frame` wraps a parsed `header` struct. Different representations of the same "
    "32 bytes — the corpus `frame_*` cases pin the bytes themselves.",
    "FrameError": "SDK-local error taxonomy, never serialized",
    "CborError": "SDK-local error taxonomy, never serialized",
}

# Opcode families the SDK deliberately does not speak.
UNIMPLEMENTED_OPCODE_PREFIXES: dict[str, str] = {
    "Admin": "admin plane — reached over the server's separate admin listener, "
    "not the data-plane wire connection this SDK opens",
}


def cmp_serde(a: dict, b: dict) -> list[str]:
    """Differences in the serde attributes that change the wire."""
    out = []
    for key in ("with", "skip", "skip_serializing_if", "default", "rename", "rename_all"):
        av, bv = a.get(key), b.get(key)
        # `skip_serializing_if` values are predicate paths; only presence matters.
        if key == "skip_serializing_if":
            av, bv = bool(av), bool(bv)
        if av != bv:
            out.append(f"serde({key}): server={av!r} sdk={bv!r}")
    return out


def compare(server: dict, sdk: dict) -> list[str]:
    problems: list[str] = []

    # --- structs ----------------------------------------------------------
    for name, s_def in sorted(sdk["structs"].items()):
        if name in SDK_LOCAL_TYPES:
            continue
        if name not in server["structs"]:
            problems.append(f"STRUCT {name}: declared by the SDK, absent from the server")
            continue
        srv = server["structs"][name]["fields"]
        own = s_def["fields"]

        srv_names = [f["name"] for f in srv]
        own_names = [f["name"] for f in own]

        missing = [n for n in srv_names if n not in own_names]
        extra = [
            n
            for n in own_names
            if n not in srv_names and (name, n) not in KNOWN_LOCAL_FIELDS
        ]
        if missing:
            problems.append(f"STRUCT {name}: MISSING fields {missing}")
        if extra:
            problems.append(f"STRUCT {name}: EXTRA fields {extra}")

        # Order matters: serde emits in declaration order and the corpus pins
        # the resulting byte sequence.
        shared_srv = [n for n in srv_names if n in own_names]
        shared_own = [n for n in own_names if n in srv_names]
        if shared_srv != shared_own:
            problems.append(
                f"STRUCT {name}: field ORDER differs\n"
                f"      server: {shared_srv}\n      sdk   : {shared_own}"
            )

        srv_by = {f["name"]: f for f in srv}
        for f in own:
            g = srv_by.get(f["name"])
            if not g:
                continue
            if f["type"] != g["type"]:
                problems.append(
                    f"STRUCT {name}.{f['name']}: TYPE server={g['type']!r} sdk={f['type']!r}"
                )
            for d in cmp_serde(g["serde"], f["serde"]):
                problems.append(f"STRUCT {name}.{f['name']}: {d}")

    # --- enums ------------------------------------------------------------
    for name, e_def in sorted(sdk["enums"].items()):
        if name in SDK_LOCAL_TYPES:
            continue
        if name == "Opcode":
            continue  # compared by value below, not as an enum shape
        if name not in server["enums"]:
            problems.append(f"ENUM {name}: declared by the SDK, absent from the server")
            continue
        srv = server["enums"][name]

        if srv["encoding"] != e_def["encoding"]:
            problems.append(
                f"ENUM {name}: ENCODING server={srv['encoding']} sdk={e_def['encoding']} "
                "(int = CBOR integer via serde_repr; tagged = string / single-key map)"
            )
        if srv["repr"] != e_def["repr"]:
            problems.append(f"ENUM {name}: repr server={srv['repr']} sdk={e_def['repr']}")

        srv_v = {v["name"]: v for v in srv["variants"]}
        own_v = {v["name"]: v for v in e_def["variants"]}
        missing = [n for n in srv_v if n not in own_v]
        extra = [n for n in own_v if n not in srv_v]
        if missing:
            problems.append(f"ENUM {name}: MISSING variants {missing}")
        if extra:
            problems.append(f"ENUM {name}: EXTRA variants {extra}")
        for vn in sorted(set(srv_v) & set(own_v)):
            a, b = srv_v[vn], own_v[vn]
            if a.get("discriminant") != b.get("discriminant"):
                problems.append(
                    f"ENUM {name}::{vn}: DISCRIMINANT server={a.get('discriminant')} "
                    f"sdk={b.get('discriminant')}"
                )
            if a.get("payload") != b.get("payload"):
                problems.append(
                    f"ENUM {name}::{vn}: payload server={a.get('payload')!r} "
                    f"sdk={b.get('payload')!r}"
                )

        # For tagged enums the variant ORDER is irrelevant on the wire, but for
        # repr enums a reordering usually means a renumbering.
        if e_def["encoding"] == "int":
            srv_order = [v["name"] for v in srv["variants"] if v["name"] in own_v]
            own_order = [v["name"] for v in e_def["variants"] if v["name"] in srv_v]
            if srv_order != own_order:
                problems.append(f"ENUM {name}: variant order differs (repr enum)")

    # --- opcodes ----------------------------------------------------------
    unimplemented = [
        n
        for n in server["opcodes"]
        if n not in sdk["opcodes"]
        and not any(n.startswith(p) for p in UNIMPLEMENTED_OPCODE_PREFIXES)
    ]
    if unimplemented:
        problems.append(
            "OPCODE: the server declares these and the SDK does not, and they are not in "
            f"a family the SDK opts out of: {sorted(unimplemented)}"
        )

    for name, value in sorted(sdk["opcodes"].items()):
        if name not in server["opcodes"]:
            problems.append(f"OPCODE {name} ({value:#06x}): not declared by the server")
        elif server["opcodes"][name] != value:
            problems.append(
                f"OPCODE {name}: server={server['opcodes'][name]:#06x} sdk={value:#06x}"
            )

    return problems


if __name__ == "__main__":
    server = json.load(open(sys.argv[1]))
    sdk = json.load(open(sys.argv[2]))
    found = compare(server, sdk)

    print(
        f"SDK declares {len(sdk['structs'])} structs / {len(sdk['enums'])} enums / "
        f"{len(sdk['opcodes'])} opcodes against the server's "
        f"{len(server['structs'])} / {len(server['enums'])} / {len(server['opcodes'])}"
    )
    print(f"discrepancies: {len(found)}\n")
    for p in found:
        print(f"  {p}")
    sys.exit(1 if found else 0)
