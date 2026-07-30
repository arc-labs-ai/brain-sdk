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

    if failed:
        print(
            "API surface drift: a verb reachable from one SDK is not reachable from\n"
            "another. Either add it, or -- if it is genuinely language-local --\n"
            "add the name to LANGUAGE_LOCAL with a reason.",
            file=sys.stderr,
        )
        return 1
    print("All three SDKs expose the same public API surface.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
