#!/usr/bin/env python3
"""Every request and response FIELD the HTTP contract declares, in all three SDKs.

`check_http_contract.py` proves each SDK reaches every ROUTE. This proves each
one can send every filter and read every field on those routes — which is a
different question, and the one that was failing. While the route check was
green, `include_trace`, the keyset cursors on three list endpoints, and the
`*_name` display fields the gateway resolves were each present in some SDKs
and absent from others. A caller on the wrong SDK simply could not ask.

Two sources, because they are two contracts:

  * `contract/http-routes.json` — brain-edge's, vendored (see contract/SOURCE.txt)
  * the cloud gateway's own DTOs — which EXTEND brain-edge and are vendored
    nowhere, so this reads them from the sibling checkout when it is present
    and says so when it is not

Three lessons are baked into the matcher below, each learned by it reporting
confident nonsense:

  1. Match request types to `*Input`/`*Query` and response types to
     `*Result`/`*Page`/`*Detail` — never let a response match an `*Input`.
     Searching one unordered set made `SchemaValidateDto` match
     `SchemaValidateInput` and report every result field as missing, in two
     languages at once.
  2. Compare on the WIRE name. `relation_type` goes out as `type`
     (`#[serde(rename)]`), and the TypeScript field called `type` is correct,
     not missing.
  3. Python has no request TYPES — it takes filters as keyword arguments — so
     its request side is read from the client's method signatures with `ast`,
     not from the types module. Regex over `def` lines matched a third of them
     and silently passed the rest.

Exit code 1 on any gap. Run from the repo root:

    python3 tools/check_http_fields.py
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: The gateway lives in a sibling checkout and is not vendored. Absent is not
#: a failure — it just narrows the audit to brain-edge's contract, and the
#: report says which half ran.
GATEWAY_DTOS = ROOT.parent / "api.arc-labs.ai/services/gateway/src/api/dto"

#: `module::verb` in the manifest -> the Python client's method name. They
#: disagree often enough (`entity::list` is `list_entities`) that guessing
#: from the verb matched a third of the routes.
HANDLER_TO_METHOD = {
    "entity::list": "list_entities",
    "entity::create": "create_entity",
    "entity::resolve": "resolve_entity",
    "entity::traverse": "traverse_relations",
    "relation::list": "list_relations",
    "relation::get": "get_relation",
    "statement::list": "list_statements",
    "statement::get": "get_statement",
    "graph::fetch": "graph_fetch",
    "graph::link": "link",
    "graph::unlink": "unlink",
    "memory::forget": "forget",
    "memory::list": "memory_list",
    "memory::encode": "encode",
    "memory::recall": "recall",
    "memory::inspect": "memory_inspect",
    "reasoning::plan": "plan",
    "reasoning::reason": "reason",
    "schema::get": "get_schema",
    "schema::upload": "upload_schema",
    "schema::replace": "replace_schema",
    "schema::validate": "validate_schema",
    "identity::whoami": "whoami",
    "identity::capabilities": "capabilities",
}

#: Differences that are correct. Keep the reason with the entry.
ALLOWED = {
    # `from` is a Python keyword, so the dataclass spells it `from_`. The wire
    # name is unaffected: `from_map` reads `m["from"]`.
    ("TraversalStep", "python", "from"),
}

#: A floor, for the reason the other tools carry one: a matcher that finds
#: nothing reports "no gaps", which reads exactly like success.
MINIMUM_ROUTES = 20

#: Same floor for the gateway half, which is where the real gaps have been.
MINIMUM_GATEWAY_MATCHES = 100


def camel_to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def rust_fields(text: str) -> dict[str, set[str]]:
    return {
        m.group(1): set(re.findall(r"^\s*pub (\w+):", m.group(2), re.M))
        for m in re.finditer(r"pub struct (\w+)\s*\{(.*?)\n\}", text, re.S)
    }


def ts_fields(text: str) -> dict[str, set[str]]:
    return {
        m.group(1): {camel_to_snake(f) for f in re.findall(r"^\s*(\w+)\??:", m.group(2), re.M)}
        for m in re.finditer(r"export interface (\w+)\s*\{(.*?)\n\}", text, re.S)
    }


def python_type_fields(text: str) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for m in re.finditer(r"^class (\w+):\n(.*?)(?=\n\nclass |\n\n@|\Z)", text, re.S | re.M):
        fields = set()
        for line in m.group(2).split("\n"):
            if re.match(r"^    def |^    @", line):
                break  # past the attributes, into methods
            fm = re.match(r"^    (\w+)\s*:", line)
            if fm:
                fields.add(fm.group(1))
        out[m.group(1)] = fields
    return out


def python_method_params(text: str) -> dict[str, set[str]]:
    """Python takes request filters as keyword arguments, not as types."""
    tree = ast.parse(text)
    out: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "BrainHttpClient":
            for fn in node.body:
                if isinstance(fn, ast.FunctionDef) and not fn.name.startswith("_"):
                    names = {a.arg for a in fn.args.args if a.arg != "self"}
                    names |= {a.arg for a in fn.args.kwonlyargs}
                    out[fn.name] = names
    return out


def request_names(dto: str) -> list[str]:
    """Candidate SDK type names for a REQUEST — most specific first."""
    base = re.sub(r"(Dto|Body)$", "", dto)
    return [base + "Input", base + "Query", base]


def response_names(dto: str) -> list[str]:
    """Candidate SDK type names for a RESPONSE — never an `*Input`."""
    base = re.sub(r"(Dto|Response)$", "", dto)
    return [base + "Result", base + "Page", base + "Detail", base]


def wire_names(fields: list[dict]) -> tuple[set[str], dict[str, str]]:
    """Declared names plus their serde renames, and the alias map between."""
    names: set[str] = set()
    aliases: dict[str, str] = {}
    for field in fields:
        name = field["name"]
        renamed = field.get("serde", {}).get("rename")
        names.add(name)
        if renamed:
            names.add(renamed)
            aliases[name] = renamed
            aliases[renamed] = name
    return names, aliases


def gateway_structs(directory: Path) -> dict[str, list[set[str]]]:
    """The cloud gateway's DTO fields, keyed by struct name, WIRE names.

    The gateway extends brain-edge — `include_trace`, the keyset cursors, the
    resolved `*_name` display fields — and none of that is in the vendored
    manifest, so it is read from source. Every gap this tool has found so far
    lived on this side of the line.

    Each field is returned as the SET OF SPELLINGS that satisfy it — the Rust
    field name and its `#[serde(rename)]`, when there is one — so a check can
    ask "is any of these present?" rather than comparing flattened name sets.
    Flattening them lost the pairing and let one satisfied field vouch for
    every other, which is a green that means nothing.
    """
    out: dict[str, list[set[str]]] = {}
    for file in sorted(directory.glob("*.rs")):
        text = file.read_text()
        for m in re.finditer(r"pub struct (\w+)\s*\{(.*?)\n\}", text, re.S):
            fields: list[set[str]] = []
            for fm in re.finditer(
                r"((?:#\[serde\([^\]]*\)\]\s*)?)pub (\w+):", m.group(2)
            ):
                spellings = {fm.group(2)}
                renamed = re.search(r'rename\s*=\s*"([^"]+)"', fm.group(1))
                if renamed:
                    spellings.add(renamed.group(1))
                fields.append(spellings)
            if fields:
                out[m.group(1)] = fields
    return out


def main() -> int:
    manifest = json.loads((ROOT / "contract/http-routes.json").read_text())
    dtos = manifest["dtos"]

    types = {
        "rust": rust_fields((ROOT / "rust/src/http/types.rs").read_text()),
        "typescript": ts_fields((ROOT / "typescript/src/http/types.ts").read_text()),
        "python": python_type_fields(
            (ROOT / "python/src/brain_db_sdk/http/types.py").read_text()
        ),
    }
    py_params = python_method_params(
        (ROOT / "python/src/brain_db_sdk/http/client.py").read_text()
    )

    gaps: list[str] = []
    matched = {lang: 0 for lang in types}
    routes = 0

    for route in manifest["routes"]:
        label = f"{route['method']} {route['path']}"
        method = HANDLER_TO_METHOD.get(route["handler"], route["handler"].split("::")[-1])
        path_params = set(re.findall(r"\{(\w+)\}", route["path"]))
        routes += 1

        # ── request: query + body ──────────────────────────────────────────
        want: set[str] = set()
        aliases: dict[str, str] = {}
        for kind in ("query", "request_body"):
            dto = route.get(kind)
            if dto and dto in dtos:
                names, alias = wire_names(dtos[dto]["fields"])
                want |= names
                aliases |= alias
        want -= path_params

        if want:
            for lang in types:
                if lang == "python":
                    have = py_params.get(method)
                else:
                    dto = route.get("query") or route.get("request_body") or ""
                    have = next(
                        (types[lang][c] for c in request_names(dto) if c in types[lang]), None
                    )
                    if route.get("query") and route.get("request_body"):
                        for c in request_names(route["request_body"]):
                            if c in types[lang]:
                                have = (have or set()) | types[lang][c]
                if have is None:
                    continue
                matched[lang] += 1
                missing = [
                    n
                    for n in sorted(want)
                    if n not in have and aliases.get(n, n) not in have
                ]
                for name in missing:
                    if (dto, lang, name) not in ALLOWED:
                        gaps.append(f"  {label:44} {lang:11} request  {name}")

        # ── response ───────────────────────────────────────────────────────
        dto = route.get("response")
        if dto and dto in dtos:
            want, aliases = wire_names(dtos[dto]["fields"])
            for lang in types:
                have = next(
                    (types[lang][c] for c in response_names(dto) if c in types[lang]), None
                )
                if have is None:
                    continue
                missing = [
                    n
                    for n in sorted(want)
                    if n not in have and aliases.get(n, n) not in have
                ]
                base = re.sub(r"(Dto|Response)$", "", dto)
                for name in missing:
                    if (base, lang, name) not in ALLOWED:
                        gaps.append(f"  {label:44} {lang:11} response {name}")

    print(f"brain-edge contract: {routes} routes")
    for lang, count in matched.items():
        print(f"  {lang:11} matched {count} request shapes")
    if routes < MINIMUM_ROUTES:
        print(
            f"! only {routes} routes read (< {MINIMUM_ROUTES}); the manifest or the "
            "parser is wrong — treat this result as unusable",
            file=sys.stderr,
        )
        return 1

    if GATEWAY_DTOS.is_dir():
        gw = gateway_structs(GATEWAY_DTOS)
        checked = 0
        for dto, want in sorted(gw.items()):
            is_request = dto.endswith("Body")
            names = request_names(dto) if is_request else response_names(dto)
            for lang in types:
                if is_request and lang == "python":
                    continue  # Python takes request filters as kwargs
                have = next((types[lang][c] for c in names if c in types[lang]), None)
                if have is None:
                    continue
                checked += 1
                base = re.sub(r"(Dto|Body|Response)$", "", dto)
                for spellings in want:
                    if spellings & have:
                        continue  # present under one of its names
                    name = sorted(spellings)[0]
                    if (base, lang, name) in ALLOWED:
                        continue
                    gaps.append(f"  {dto:44} {lang:11} gateway  {name}")
        print(f"gateway DTOs: {len(gw)} structs, {checked} matched to an SDK type")
        if checked < MINIMUM_GATEWAY_MATCHES:
            print(
                f"! only {checked} gateway DTOs matched (< {MINIMUM_GATEWAY_MATCHES}); "
                "the matcher is not seeing them — treat this result as unusable",
                file=sys.stderr,
            )
            return 1
    else:
        print(
            "gateway DTOs: sibling checkout not found — only brain-edge's "
            "contract was audited"
        )

    print()
    if gaps:
        print("field gaps:")
        print("\n".join(gaps))
        print(
            f"\n{len(gaps)} field(s) the server declares that an SDK cannot send or read.\n"
            "Add them, or — if the difference is correct — add an entry to ALLOWED\n"
            "with the reason.",
            file=sys.stderr,
        )
        return 1

    print("Every field the HTTP contract declares is reachable from all three SDKs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
