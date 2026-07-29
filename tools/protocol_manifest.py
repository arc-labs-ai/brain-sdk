#!/usr/bin/env python3
"""Extract the wire-protocol surface from Rust source into a normalized manifest.

Run against either the server (`brain-protocol`) or the Rust SDK; the two
manifests are directly comparable, and that comparison is the only mechanical
check that the SDK's types match the ones the server actually speaks.

Parsing Rust with a regex is normally a bad idea. It is workable *here* because
the wire types are deliberately plain: `#[derive(Serialize, Deserialize)]`
structs and enums with a closed set of serde attributes and no macros. The
parser refuses to guess — anything it does not recognize is reported as
`unparsed` rather than silently dropped, because a silent drop is exactly the
failure mode this whole exercise exists to eliminate.

Two enum encodings exist and they are not interchangeable:
  * `serde_repr::Serialize_repr` + `#[repr(u8)]` -> a CBOR integer
  * plain `serde::Serialize`                     -> a CBOR string (unit variant)
                                                    or single-key map (payload)

Usage:
    protocol_manifest.py <crate-src-dir-or-file> [more paths...] > manifest.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# --- source cleanup --------------------------------------------------------


def strip_comments(text: str) -> str:
    """Remove line comments but keep doc comments' line structure intact.

    Only `//`-style comments are stripped, and only outside string literals.
    Block comments do not appear in these files; if one shows up, the item it
    guards lands in `unparsed` rather than being silently mis-read.
    """
    out = []
    for line in text.split("\n"):
        in_str = False
        escaped = False
        cut = len(line)
        for i, c in enumerate(line):
            if escaped:
                escaped = False
                continue
            if c == "\\":
                escaped = True
                continue
            if c == '"':
                in_str = not in_str
                continue
            if not in_str and c == "/" and i + 1 < len(line) and line[i + 1] == "/":
                cut = i
                break
        out.append(line[:cut].rstrip())
    return "\n".join(out)


def block_at(text: str, open_brace: int) -> tuple[str, int]:
    """Return the balanced `{...}` body starting at `open_brace`, and its end."""
    depth = 0
    for j in range(open_brace, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace + 1 : j], j
    raise ValueError("unbalanced braces")


# --- attribute + type normalization ---------------------------------------

SERDE_ATTR = re.compile(r"#\[serde\((.*?)\)\]", re.S)
DERIVE = re.compile(r"#\[derive\((.*?)\)\]", re.S)
REPR = re.compile(r"#\[repr\((\w+)\)\]")


def serde_attrs(attr_text: str) -> dict:
    """Normalize the serde attributes that change what goes on the wire."""
    found: dict = {}
    for m in SERDE_ATTR.finditer(attr_text):
        for part in re.split(r",(?![^()]*\))", m.group(1)):
            part = part.strip()
            if not part:
                continue
            key, _, value = part.partition("=")
            key = key.strip()
            value = value.strip().strip('"')
            if key == "with":
                # Codec module selection. Only the last path segment matters:
                # the SDK and the server reach the same codec by different
                # paths (`crate::wire::cbor::x` vs `crate::codec::cbor::x`).
                found["with"] = value.rsplit("::", 1)[-1]
            elif key in ("default", "skip", "skip_serializing_if", "rename", "rename_all"):
                found[key] = value or True
    return found


def normalize_type(ty: str) -> str:
    """Reduce a Rust type to its wire-relevant shape.

    Paths are dropped (`crate::ops::memory::ActAs` -> `ActAs`) and the SDK's
    local aliases are folded onto the server's names, so the comparison is
    about wire shape rather than where a type happens to live.
    """
    ty = re.sub(r"\s+", " ", ty).strip().rstrip(",")
    ty = re.sub(r"\b[A-Za-z_][A-Za-z0-9_]*::", "", ty)
    aliases = {
        "WireUuid": "[u8; 16]",
        "WireSessionId": "u64",
        "WireMemoryId": "u128",
        "MemoryId": "u128",
        "SpaceId": "[u8; 16]",
        "RequestId": "[u8; 16]",
        "TxnId": "[u8; 16]",
    }
    for src, dst in aliases.items():
        ty = re.sub(rf"\b{src}\b", dst, ty)
    return re.sub(r"\s+", " ", ty).replace("[u8 ; 16]", "[u8; 16]").strip()


# --- item parsing ----------------------------------------------------------

FIELD = re.compile(r"^\s*pub\s+(\w+)\s*:\s*(.+?),?\s*$")


def parse_struct_body(body: str) -> tuple[list, list]:
    """`(fields, unparsed_lines)` for a struct body."""
    fields: list = []
    unparsed: list = []
    pending: list[str] = []
    depth = 0
    buffer = ""
    for raw in body.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#["):
            pending.append(line)
            continue
        buffer = (buffer + " " + line).strip() if buffer else line
        depth += buffer.count("<") - buffer.count(">")
        depth += buffer.count("(") - buffer.count(")")
        if depth > 0:
            continue
        m = FIELD.match(buffer)
        if m:
            fields.append(
                {
                    "name": m.group(1),
                    "type": normalize_type(m.group(2)),
                    "serde": serde_attrs(" ".join(pending)),
                }
            )
        elif buffer not in ("", "}"):
            unparsed.append(buffer)
        pending = []
        buffer = ""
    return fields, unparsed


def parse_enum_body(body: str) -> tuple[list, list]:
    """`(variants, unparsed_lines)` for an enum body."""
    variants: list = []
    unparsed: list = []
    depth = 0
    buffer = ""
    for raw in body.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#["):
            continue
        buffer = (buffer + " " + line).strip() if buffer else line
        depth += buffer.count("(") - buffer.count(")")
        depth += buffer.count("{") - buffer.count("}")
        if depth > 0:
            continue
        item = buffer.rstrip(",").strip()
        buffer = ""
        if not item:
            continue
        m = re.match(r"^(\w+)\s*=\s*(-?\w+)$", item)
        if m:
            variants.append({"name": m.group(1), "discriminant": int(m.group(2), 0)})
            continue
        m = re.match(r"^(\w+)\s*\((.+)\)$", item)
        if m:
            variants.append({"name": m.group(1), "payload": normalize_type(m.group(2))})
            continue
        m = re.match(r"^(\w+)\s*\{(.+)\}$", item)
        if m:
            inner, _ = parse_struct_body(
                "\n".join("pub " + p.strip() + "," for p in m.group(2).split(",") if p.strip())
            )
            variants.append({"name": m.group(1), "struct": inner})
            continue
        if re.match(r"^\w+$", item):
            variants.append({"name": item})
            continue
        unparsed.append(item)
    return variants, unparsed


ITEM = re.compile(r"pub\s+(struct|enum)\s+(\w+)\s*(?:<[^>]*>)?\s*\{")


def attrs_before(text: str, item_start: int) -> str:
    """The attributes attached to the item starting at `item_start`.

    Only the *contiguous* run of attribute and doc-comment lines directly above
    the item counts. A naive fixed-size lookback picks up the previous item's
    attributes — which it did, reporting `#[repr(u8)]` on three enums that do
    not carry it. An attribute is a wire-level fact here, so mis-attributing one
    is not a cosmetic bug.
    """
    lines = text[:item_start].split("\n")
    # `lines[-1]` is the partial line the item sits on.
    collected: list[str] = []
    for line in reversed(lines[:-1]):
        stripped = line.strip()
        if not stripped:
            # A blank line inside an attribute block is unusual but harmless;
            # a blank line before one ends the run.
            break
        if stripped.startswith("#[") or stripped.startswith("///") or stripped.startswith("//!"):
            collected.append(stripped)
            continue
        # Continuation of a multi-line `#[derive(...)]`.
        if collected and (stripped.endswith(",") or stripped.endswith(")]")):
            collected.append(stripped)
            continue
        break
    return "\n".join(reversed(collected))


def parse_source(text: str) -> dict:
    text = strip_comments(text)
    structs: dict = {}
    enums: dict = {}
    unparsed: list = []

    for m in ITEM.finditer(text):
        kind, name = m.group(1), m.group(2)
        brace = text.index("{", m.end() - 1)
        try:
            body, _ = block_at(text, brace)
        except ValueError:
            unparsed.append(f"{kind} {name}: unbalanced braces")
            continue

        head = attrs_before(text, m.start())
        derives = " ".join(d.group(1) for d in DERIVE.finditer(head))
        repr_m = list(REPR.finditer(head))
        container = serde_attrs(head)

        if kind == "struct":
            fields, bad = parse_struct_body(body)
            structs[name] = {"fields": fields, "serde": container}
            unparsed += [f"struct {name}: {b}" for b in bad]
        else:
            variants, bad = parse_enum_body(body)
            enums[name] = {
                "variants": variants,
                # The distinction that decides integer-vs-string on the wire.
                "repr": repr_m[-1].group(1) if repr_m else None,
                "encoding": "int" if "Serialize_repr" in derives else "tagged",
                "serde": container,
            }
            unparsed += [f"enum {name}: {b}" for b in bad]

    return {"structs": structs, "enums": enums, "unparsed": unparsed}


def parse_opcodes(text: str) -> dict:
    """The `Opcode` enum's `Name = 0x....` variants."""
    text = strip_comments(text)
    m = re.search(r"pub\s+enum\s+Opcode\s*\{", text)
    if not m:
        return {}
    body, _ = block_at(text, text.index("{", m.end() - 1))
    return {
        name: int(value, 16)
        for name, value in re.findall(r"(\w+)\s*=\s*(0x[0-9A-Fa-f]+)", body)
    }


def collect(paths: list[str]) -> dict:
    manifest = {"structs": {}, "enums": {}, "opcodes": {}, "unparsed": []}
    files: list[Path] = []
    for p in paths:
        path = Path(p).expanduser()
        files += sorted(path.rglob("*.rs")) if path.is_dir() else [path]
    for f in files:
        text = f.read_text()
        parsed = parse_source(text)
        for name, value in parsed["structs"].items():
            manifest["structs"].setdefault(name, value)
        for name, value in parsed["enums"].items():
            manifest["enums"].setdefault(name, value)
        manifest["unparsed"] += [f"{f.name}: {u}" for u in parsed["unparsed"]]
        manifest["opcodes"].update(parse_opcodes(text))
    return manifest


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    print(json.dumps(collect(sys.argv[1:]), indent=1, sort_keys=True))
