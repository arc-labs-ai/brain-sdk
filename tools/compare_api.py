#!/usr/bin/env python3
"""Check that the three SDKs expose the same public API surface.

The wire boundary has `protocol.json` plus the corpus. The HTTP boundary has
`contract/http-routes.json`. This is the third boundary, and until now it was
the only one with nothing behind it: three hand-written clients that are
*supposed* to offer the same verbs, with no artifact saying so.

That gap is not theoretical. Every drift found in this repo so far has been of
exactly this shape — two independent transcriptions of one contract, with
nothing in between. `session_filter` was missing from one SDK's QueryRequest;
`RetrieverWire` went out as integers from two of them; ten of TypeScript's
codec halves did not exist. In each case the code compiled, the tests passed,
and the SDKs quietly disagreed.

What this checks: that a verb reachable from one SDK is reachable from all
three, comparing normalized names (`createEntity` == `create_entity`).

What it does NOT check: that same-named methods take the same arguments or
return the same shape. Signatures are genuinely different per language — Rust
takes `&EncodeRequest`, Python takes a dataclass, TypeScript takes an object
literal — and comparing them here reproduces the false-positive problem that
made the first three attempts at `compare_bindings.py` useless. Argument
shapes are covered by `compare_bindings.py` (the wire types those arguments
carry) and by each SDK's own tests.

Usage: compare_api.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Methods that exist for language reasons rather than protocol reasons, and so
# are not expected to appear in all three.
LANGUAGE_LOCAL = {
    # Rust splits borrow/own and sync/async where the others do not.
    "connect_with",
    "clone",
    "fmt",
    "drop",
    "default",
    "new",
    "from",
    "into",
    # `BrainHttpClient` configuration. Rust takes it through a builder
    # (`localhost`, `with_timeout`, `with_retry_policy`) because its `new`
    # requires base_url positionally; Python takes the same three as keyword
    # arguments with defaults, and TypeScript as fields on an options object.
    # Every setting is reachable in all three — only the spelling differs.
    "localhost",
    "with_timeout",
    "with_retry_policy",
    # Context-manager / disposal protocols, spelled differently per language.
    "enter",
    "exit",
    "aenter",
    "aexit",
    "dispose",
    "symbol_dispose",
    "iter",
    "next",
    "anext",
    "aiter",
    "return",
    "throw",
}


def camel_to_snake(name: str) -> str:
    """`createEntity` -> `create_entity`; already-snake names pass through."""
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()


def rust_methods(text: str, impl_for: str) -> set[str]:
    """`pub fn` / `pub async fn` inside `impl <impl_for> {`.

    The impl block is found by brace balance rather than a non-greedy match: a
    lookahead to the next `impl` runs past the closing brace on any block that
    contains a nested one, which silently merges two types' surfaces.
    """
    m = re.search(rf"^impl {re.escape(impl_for)}\s*\{{", text, re.M)
    if m is None:
        return set()
    depth = 0
    for j in range(m.end() - 1, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                break
    body = text[m.end() : j]
    return {n for n in re.findall(r"\bpub (?:async )?fn (\w+)", body)}


def python_methods(text: str, cls: str) -> set[str]:
    """`def` / `async def` at one indent level inside `class <cls>`."""
    m = re.search(rf"^class {re.escape(cls)}[:(]", text, re.M)
    if m is None:
        return set()
    rest = text[m.end() :]
    end = re.search(r"^class \w", rest, re.M)
    body = rest[: end.start()] if end else rest
    return {
        n
        for n in re.findall(r"^    (?:async )?def (\w+)\(", body, re.M)
        if not n.startswith("_")
    }


def ts_methods(text: str, cls: str) -> set[str]:
    """Methods at one indent level inside `export class <cls>`."""
    m = re.search(rf"^export class {re.escape(cls)}[\s{{]", text, re.M)
    if m is None:
        return set()
    brace = text.index("{", m.start())
    depth = 0
    for j in range(brace, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                break
    body = text[brace + 1 : j]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"//[^\n]*", "", body)
    out: set[str] = set()
    for name in re.findall(r"^  (?:static |async |get |readonly )*([a-zA-Z_]\w*)\s*[(<]", body, re.M):
        if name in ("constructor", "if", "for", "while", "switch", "return", "catch"):
            continue
        if name.startswith("_"):
            continue
        out.add(name)
    # TypeScript constructor parameter properties (`public readonly x: T`) are
    # public surface, and the other two SDKs expose the same thing as an
    # accessor. Reading only method position reported `connection` as missing
    # from TypeScript when it is a field there -- a difference in language
    # idiom, not in API.
    out |= set(re.findall(r"\bpublic (?:readonly )?([a-zA-Z_]\w*)\s*:", body))
    return out


SURFACES = [
    (
        "BrainClient (wire)",
        lambda: rust_methods((ROOT / "rust/src/client.rs").read_text(), "BrainClient"),
        lambda: python_methods(
            (ROOT / "python/src/brain_db_sdk/client.py").read_text(), "BrainClient"
        ),
        lambda: ts_methods((ROOT / "typescript/src/client.ts").read_text(), "BrainClient"),
    ),
    (
        "BrainHttpClient (HTTP)",
        lambda: rust_methods((ROOT / "rust/src/http/client.rs").read_text(), "BrainHttpClient"),
        lambda: python_methods(
            (ROOT / "python/src/brain_db_sdk/http/client.py").read_text(), "BrainHttpClient"
        ),
        lambda: ts_methods(
            (ROOT / "typescript/src/http/client.ts").read_text(), "BrainHttpClient"
        ),
    ),
]

# A floor per surface. An extractor that silently matches nothing reports "no
# differences", which reads exactly like success -- the failure mode that let
# the HTTP manifest drop every enum DTO without a trace.
MINIMUM = {"BrainClient (wire)": 40, "BrainHttpClient (HTTP)": 15}


# ── Field-level parity for the HTTP DTOs ────────────────────────────────────
#
# WHY A SECOND CHECK. The verb check above compares METHOD NAMES, and it has
# been green while three real gaps sat in the types those methods take and
# return: `include_trace` on recall, and `cursor` / `next_cursor` on the
# entity, relation and statement list endpoints — all present in TypeScript,
# all absent from Python and Rust. Every one of them is a feature the cloud
# gateway serves that two of the three SDKs could not ask for. "Same verbs"
# was never the claim worth making; "same arguments and same results" is.
#
# This parses the declared fields of every DTO that all three SDKs name, and
# compares them snake-cased. It is deliberately dumb about types — a field
# that exists in one language and not another is the drift that has actually
# happened here; a `u32` against a `number` is not.

FIELD_SOURCES = {
    "rust": "rust/src/http/types.rs",
    "python": "python/src/brain_db_sdk/http/types.py",
    "typescript": "typescript/src/http/types.ts",
}

# Differences that are correct. Keep the reason with the entry.
FIELD_LOCAL = {
    # `from` is a Python keyword, so the dataclass cannot use it. The wire
    # name is unaffected: `from_dict` reads `d["from"]`.
    ("TraversalStep", "from"),
    ("TraversalStep", "from_"),
}

# A floor, for the same reason MINIMUM exists above: an extractor that matches
# nothing reports "no differences", which reads exactly like success.
MINIMUM_SHARED_DTOS = 25


def rust_struct_fields(text: str) -> dict[str, set[str]]:
    return {
        m.group(1): set(re.findall(r"^\s*pub (\w+):", m.group(2), re.M))
        for m in re.finditer(r"pub struct (\w+)\s*\{(.*?)\n\}", text, re.S)
    }


def python_dataclass_fields(text: str) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for m in re.finditer(r"^class (\w+):\n(.*?)(?=\n\nclass |\n\n@|\Z)", text, re.S | re.M):
        fields = set()
        for line in m.group(2).split("\n"):
            if re.match(r"^    def |^    @", line):
                break  # past the attribute block, into methods
            fm = re.match(r"^    (\w+)\s*:", line)
            if fm:
                fields.add(fm.group(1))
        out[m.group(1)] = fields
    return out


def ts_interface_fields(text: str) -> dict[str, set[str]]:
    return {
        m.group(1): {camel_to_snake(f) for f in re.findall(r"^\s*(\w+)\??:", m.group(2), re.M)}
        for m in re.finditer(r"export interface (\w+)\s*\{(.*?)\n\}", text, re.S)
    }


def compare_fields() -> bool:
    """True on drift."""
    per_lang = {
        "rust": rust_struct_fields((ROOT / FIELD_SOURCES["rust"]).read_text()),
        "python": python_dataclass_fields((ROOT / FIELD_SOURCES["python"]).read_text()),
        "typescript": ts_interface_fields((ROOT / FIELD_SOURCES["typescript"]).read_text()),
    }
    shared = sorted(set.intersection(*(set(d) for d in per_lang.values())))

    print("── HTTP DTO fields")
    print(f"   {len(shared)} type(s) declared in all three")
    if len(shared) < MINIMUM_SHARED_DTOS:
        print(
            f"   ! only {len(shared)} shared types (< {MINIMUM_SHARED_DTOS}); the parser "
            "is not seeing these files — treat the result as unusable",
            file=sys.stderr,
        )
        return True

    drifted = 0
    for name in shared:
        sets = {lang: per_lang[lang][name] for lang in per_lang}
        everywhere = set.intersection(*sets.values())
        anywhere = set.union(*sets.values())
        missing = sorted(f for f in anywhere - everywhere if (name, f) not in FIELD_LOCAL)
        if not missing:
            continue
        drifted += 1
        print(f"   {name}:")
        for field in missing:
            have = sorted(l for l, f in sets.items() if field in f)
            lack = sorted(l for l, f in sets.items() if field not in f)
            print(f"     {field:28} in {'+'.join(have):24} missing from {'+'.join(lack)}")
    if drifted:
        print(f"   {drifted} type(s) with field drift")
    else:
        print("   every shared type declares the same fields in all three")
    print()
    return drifted > 0


def main() -> int:
    failed = False
    for label, get_rust, get_py, get_ts in SURFACES:
        langs = {
            "rust": {camel_to_snake(n) for n in get_rust()},
            "python": {camel_to_snake(n) for n in get_py()},
            "typescript": {camel_to_snake(n) for n in get_ts()},
        }
        for name in langs:
            langs[name] -= LANGUAGE_LOCAL

        print(f"── {label}")
        for name, methods in langs.items():
            print(f"   {name:11} {len(methods):3} methods")
            floor = MINIMUM[label]
            if len(methods) < floor:
                print(
                    f"   ! {name} extracted only {len(methods)} (< {floor}); the parser "
                    "is not seeing this surface — treat the result as unusable",
                    file=sys.stderr,
                )
                failed = True

        everywhere = set.intersection(*langs.values())
        anywhere = set.union(*langs.values())
        missing = sorted(anywhere - everywhere)
        if missing:
            failed = True
            print(f"   {len(missing)} verb(s) not present in all three:")
            for verb in missing:
                have = sorted(n for n, m in langs.items() if verb in m)
                lack = sorted(n for n, m in langs.items() if verb not in m)
                print(f"     {verb:34} in {'+'.join(have):24} missing from {'+'.join(lack)}")
        else:
            print(f"   all {len(everywhere)} verbs present in all three")
        print()

    if compare_fields():
        failed = True

    if failed:
        print(
            "API surface drift: something reachable from one SDK is not reachable from\n"
            "another. Either add it, or -- if it is genuinely language-local --\n"
            "add the name to LANGUAGE_LOCAL / FIELD_LOCAL with a reason.",
            file=sys.stderr,
        )
        return 1
    print("All three SDKs expose the same public API surface.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
