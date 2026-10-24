#!/usr/bin/env python3
"""Check the three SDK HTTP clients against brain-edge's vendored contract.

The wire boundary has `protocol.json` plus the corpus. This is the same idea for
the HTTP boundary: `contract/http-routes.json` is generated from brain-edge's
own DTOs and router, and every SDK is checked against it.

Without this, the two sides were independent hand transcriptions of the same
JSON with nothing in between — the setup that produced `session_filter` and
`RetrieverWire` on the wire side. It had already produced two instances here:
`whoami` documented as returning `agent_id` when the edge returns `space_id`,
and the clients covering 10 of the edge's 25 method+path combos, so an HTTP-tier
user could not reach entities, statements, relations, graph or schema at all.

Two checks, because a route being reachable and a route being USABLE are
different questions and only the first one was being asked:

  ROUTES   every method+path the edge exposes is reachable from every SDK.
           Catches a route added to the edge and never wired into a client.

  FIELDS   every request parameter and response field on those routes agrees.
           Catches the opposite failure, which this file was blind to for the
           whole life of the feature: all three SDKs carried an `include_trace`
           request flag and a `trace` response field that NO edge DTO declared.
           The clients serialized the flag, the edge dropped it on the floor,
           `trace` came back null on every call, and the one test that asserted
           otherwise was written off as flaky. Routes were 57/57 green
           throughout. Coverage of the surface says nothing about the contents.

The field check compares three ways, and the asymmetry is the point:

  sdk-only    the SDK sends or reads a field no edge DTO declares. A parameter
              that silently does nothing — the `include_trace` shape.
  edge-only   the edge declares a field no SDK surfaces. A server capability
              no SDK user can reach — how `subject_name` and the keyset cursors
              sat unused.
  shape       both sides have the field and disagree on its type.

PRECISION OVER RECALL, deliberately. A gate that cries wolf gets switched off,
which is strictly worse than no gate — that is what killed the first three
attempts at `compare_bindings.py`. So anything this cannot decide is printed
under `advisory` and does NOT fail the build, and the places where it declines
to look are listed in `what this does NOT check` below. Better to miss drift
than to teach people to skip the output.

What this does NOT check, and why:

  * Nested DTOs. A response is compared field-for-field at the top level only.
    `list(MemoryListItemDto)` is checked as "a list", not element by element,
    because the SDK element type is named by its own convention and matching it
    means guessing. Most nested DTOs are reached anyway: they are the top-level
    response of some other route. The advisory block counts the ones that
    are not.
  * Optionality. The manifest cannot settle it: `serde(default)` plus
    `skip_serializing_if` make a field that is not `opt(...)` absent from the
    wire anyway, so "required here, optional there" is not decidable from what
    is written down, and reporting it would be noise on nearly every field.
  * Query parameter types. A query string carries everything as text, and the
    SDKs legitimately accept a richer type and stringify it — `subscribe`
    takes a list of session ids and sends `?sessions=1,2,3`. Comparing those
    shapes reports three false positives on that one route alone.
  * Anything not bound to a route by the client's own call site. SDK types are
    only ever reached THROUGH a client method signature, so client-side-only
    types — retry policy, base url, SSE frame internals — are out of scope
    structurally rather than by an allowlist that would rot.

Usage: check_http_contract.py [contract/http-routes.json] [--root DIR]
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where each SDK's HTTP client lives, and how a route literal appears in it.
# Only path string literals are parsed — the most reliable thing in any of the
# three languages — and the method is read from the surrounding call.
CLIENTS = {
    "rust": Path("rust/src/http/client.rs"),
    "python": Path("python/src/brain_db_sdk/http/client.py"),
    "typescript": Path("typescript/src/http/client.ts"),
}

# Where each SDK declares the request/response types those clients name. The
# field check reads these; the route check does not need them.
TYPES = {
    "rust": Path("rust/src/http/types.rs"),
    "python": Path("python/src/brain_db_sdk/http/types.py"),
    "typescript": Path("typescript/src/http/types.ts"),
}

# All three clients pass the method and the path as adjacent arguments to one
# call:
#     rust    self.request(Method::POST, "/v1/memories", Some(input), true)
#     python  self._request("POST", "/v1/memories", body, idempotent=True)
#     ts      this.request("POST", "/v1/memories", input)
#
# So the two are matched together rather than by looking for a method somewhere
# near a path. A window-based search reported DELETE /v1/plan, GET /v1/reason
# and POST /v1/whoami — each of them the *neighbouring* verb's method paired
# with this verb's path.
ROUTE_CALL = re.compile(
    r"""(?:Method::)?["']?\b(GET|POST|PUT|DELETE|PATCH)\b["']?\s*,\s*"""
    # A string prefix or wrapper may sit between the comma and the quote:
    #   python  f"/v1/entities/{id}"        f-string
    #   rust    format!("/v1/entities/{}")  macro
    #   rust    &format!(...)               borrowed
    # Missing the f-string prefix made all six parameterized Python routes
    # invisible, and the SDK author worked around the tool by writing
    # `"...{}".format(...)` instead — the tool distorting the code it checks.
    r"""(?:&?\s*format!\(\s*)?[a-zA-Z]{0,2}["'`](/v1/[^"'`]*)["'`]""",
    re.I,
)

#: Differences that are correct. Keep the reason with the entry, because the
#: next person's only defence against an allowlist is knowing why each line is
#: on it. Keyed `("METHOD /path", language, wire_name)` — the route, not the
#: DTO, so silencing one endpoint cannot quietly silence every other endpoint
#: that happens to answer with the same type.
ALLOWED: set[tuple[str, str, str]] = set()

#: A floor, for the reason the other tools carry one: a comparator that binds
#: nothing finds nothing and prints "no drift", which reads exactly like
#: success. If the client parsers stop recognising the code they are pointed
#: at, that is a broken tool, not a clean tree, and it must say so.
MIN_BOUND_FRACTION = 0.8


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------
def normalize(path: str) -> str:
    """Collapse every interpolation form to the manifest's `{id}` placeholder."""
    path = re.sub(r"\$\{[^}]*\}", "{id}", path)  # TS template
    path = re.sub(r"\{[^}]*\}", "{id}", path)  # Rust/Python format braces
    path = path.replace("{}", "{id}")  # bare Rust positional
    return path.rstrip("/") or "/"


def routes_in(source: str) -> set[tuple[str, str]]:
    """`(METHOD, path)` pairs a client source declares."""
    return {
        (meth.upper(), normalize(path)) for meth, path in ROUTE_CALL.findall(source)
    }


# --------------------------------------------------------------------------
# source scanning
# --------------------------------------------------------------------------
def strip_comments(text: str, backtick: bool = False) -> str:
    """Blank out `//` and `/* */` comments without touching string literals.

    Naive comment stripping ate the rest of any line containing `https://`,
    and the clients build their base URL on such a line. Blanking rather than
    deleting keeps every byte offset intact, so a slice taken afterwards still
    lines up with the original text.
    """
    out = list(text)
    i, n = 0, len(text)
    quotes = '"\'' + ("`" if backtick else "")
    while i < n:
        c = text[i]
        if c in quotes:
            q = c
            i += 1
            while i < n and text[i] != q:
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                out[i] = " "
                i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                if text[i] != "\n":
                    out[i] = " "
                i += 1
            out[i : i + 2] = "  "
            i += 2
        else:
            i += 1
    return "".join(out)


def _match(text: str, start: int, opener: str, closer: str) -> int:
    """Index of the delimiter closing the one at `start`, or `len(text)`."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == opener:
            depth += 1
        elif text[i] == closer:
            depth -= 1
            if depth == 0:
                return i
    return len(text)


def _blocks(text: str, head: re.Pattern[str]) -> list[tuple[str, str, str]]:
    """`(name, signature, body)` for each `head` match, delimited by braces.

    Signature and body are separated rather than handed over as one slice
    because the doc comment of the NEXT method sits inside a naive "run to the
    following method" slice, and a route mentioned in prose there binds the
    wrong method to the wrong path.
    """
    out = []
    for m in head.finditer(text):
        args_open = text.index("(", m.end() - 1)
        args_close = _match(text, args_open, "(", ")")
        brace = text.find("{", args_close)
        if brace < 0:
            continue
        end = _match(text, brace, "{", "}")
        out.append((m.group(1), text[m.start() : brace], text[brace : end + 1]))
    return out


# --------------------------------------------------------------------------
# the contract side
# --------------------------------------------------------------------------
def contract_kind(shape: str) -> str:
    """The manifest's shape grammar, reduced to what can be compared."""
    while True:
        m = re.fullmatch(r"(opt|list)\((.*)\)", shape)
        if not m:
            break
        if m.group(1) == "list":
            return "list"
        shape = m.group(2)
    return {"string": "string", "int": "int", "float": "float", "bool": "bool"}.get(
        shape, "?"
    )


def contract_fields(
    dtos: dict, name: str, seen: frozenset[str] = frozenset()
) -> dict[str, tuple[str, set[str]]]:
    """`{wire_name: (kind, spellings)}` for a DTO, flattened fields expanded.

    `spellings` is every name that satisfies the field — the declared one, its
    `serde(rename)`, and its `serde(alias)`. They have to travel together: the
    edge accepts `cue` for `RecallBody::query` and `type` for
    `ListRelationsQuery::relation_type`, and an SDK spelling either one is
    correct, not missing.

    `serde(flatten)` fields have no name on the wire at all — the inner DTO's
    fields appear in their place — so they are expanded rather than compared.
    `SupersedeStatementBody` is nothing but a flattened `CreateStatementBody`,
    so without this the whole body reads as missing from all three SDKs.
    """
    if name in seen or name not in dtos:
        return {}
    seen = seen | {name}
    out: dict[str, tuple[str, set[str]]] = {}
    for field in dtos[name]["fields"]:
        serde = field.get("serde") or {}
        if serde.get("flatten"):
            out.update(contract_fields(dtos, field["shape"], seen))
            continue
        wire = serde.get("rename") or field["name"]
        spellings = {field["name"], wire}
        if serde.get("alias"):
            spellings.add(serde["alias"])
        out[wire] = (contract_kind(field["shape"]), spellings)
    return out


# --------------------------------------------------------------------------
# the SDK side — declared types
# --------------------------------------------------------------------------
def rust_kind(ty: str) -> str:
    ty = ty.strip().rstrip(",").strip()
    m = re.fullmatch(r"Option<(.*)>", ty)
    if m:
        return rust_kind(m.group(1))
    if re.fullmatch(r"Vec<.*>", ty):
        return "list"
    if ty in ("String", "&str"):
        return "string"
    if re.fullmatch(r"[iu](8|16|32|64|128)|usize|isize", ty):
        return "int"
    if ty in ("f32", "f64"):
        return "float"
    if ty == "bool":
        return "bool"
    return "?"  # a nested DTO, a map, a serde_json::Value — not comparable


def rust_types(text: str) -> dict[str, dict[str, str]]:
    """`{struct: {wire_name: kind}}` from the SDK's own `types.rs`."""
    out: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"pub struct (\w+)\s*\{(.*?)\n\}", text, re.S):
        fields: dict[str, str] = {}
        for fm in re.finditer(
            r"((?:#\[serde\([^\]]*\)\]\s*)*)pub (\w+):\s*(.+?),?\s*$",
            m.group(2),
            re.M,
        ):
            attrs, name, ty = fm.group(1), fm.group(2), fm.group(3)
            if re.search(r"\bskip\b(?!_serializing_if)", attrs):
                continue  # never reaches the wire, so the edge cannot declare it
            rename = re.search(r'rename\s*=\s*"([^"]+)"', attrs)
            fields[rename.group(1) if rename else name] = rust_kind(ty)
        out[m.group(1)] = fields
    return out


def camel_to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def ts_kind(ty: str) -> str:
    ty = re.sub(r"\s*\|\s*(null|undefined)\b", "", ty.strip().rstrip(";")).strip()
    if ty.endswith("[]") or re.fullmatch(r"(Readonly)?Array<.*>", ty):
        return "list"
    if ty == "string":
        return "string"
    if ty == "number":
        return "number"  # TypeScript cannot tell int from float; see kinds_agree
    if ty == "bigint":
        return "bigint"  # unlike `number`, this one says "integer" and nothing else
    if ty == "boolean":
        return "bool"
    return "?"


def ts_types(text: str) -> dict[str, dict[str, str]]:
    """`{interface: {wire_name: kind}}`, TypeScript's camelCase undone.

    Only top-level members are taken: a member whose type is an inline object
    contributes itself, not its innards.
    """
    out: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"export interface (\w+)\s*\{", text):
        open_brace = text.index("{", m.end() - 1)
        body = text[open_brace + 1 : _match(text, open_brace, "{", "}")]
        fields: dict[str, str] = {}
        depth = 0
        for line in body.split("\n"):
            fm = re.match(r"\s*(\w+)\??\s*:\s*(.+?);?\s*$", line)
            if fm and depth == 0:
                fields[camel_to_snake(fm.group(1))] = ts_kind(fm.group(2))
            depth += line.count("{") + line.count("[") + line.count("(")
            depth -= line.count("}") + line.count("]") + line.count(")")
        out[m.group(1)] = fields
    return out


def py_kind(annotation: str) -> str:
    annotation = annotation.strip().strip("\"'")
    m = re.fullmatch(r"Optional\[(.*)\]", annotation) or re.fullmatch(
        r"Union\[(.*),\s*None\]", annotation
    )
    if m:
        return py_kind(m.group(1))
    if re.fullmatch(r"(list|List|Sequence|tuple|Tuple)\[.*\]", annotation):
        return "list"
    return {"str": "string", "int": "int", "float": "float", "bool": "bool"}.get(
        annotation, "?"
    )


def py_wire_name(attr: str) -> str:
    """`from_` is `from` on the wire — a Python keyword dodged, not a rename."""
    return attr[:-1] if attr.endswith("_") and not attr.startswith("_") else attr


def py_types(text: str) -> dict[str, dict[str, str]]:
    """`{dataclass: {wire_name: kind}}` read with `ast`, not regex.

    The regex version of this matched the attributes of some classes and
    silently returned an empty set for the rest, and an empty set compares
    equal to nothing missing.
    """
    out: dict[str, dict[str, str]] = {}
    for node in ast.parse(text).body:
        if isinstance(node, ast.ClassDef):
            out[node.name] = {
                py_wire_name(st.target.id): py_kind(ast.unparse(st.annotation))
                for st in node.body
                if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name)
            }
    return out


# --------------------------------------------------------------------------
# the SDK side — binding a route to the types that serve it
# --------------------------------------------------------------------------
# Which SDK type carries a route's request and response is NOT guessed from the
# DTO's name. Deriving `EncodeResult` from `EncodeResponseDto` by suffix
# surgery is where the previous attempt lost most of its coverage — it produced
# `EncodeResponseResult`, found nothing, and skipped the route in silence. The
# client's own method signature says which types it uses, so that is read
# instead: no name convention to keep in step, and a renamed type cannot
# quietly drop out of the audit.
def rust_bindings(client: str, declared: dict) -> dict:
    out: dict[tuple[str, str], list[dict]] = {}
    for name, sig, body in _blocks(client, re.compile(r"\n    pub async fn (\w+)\(")):
        call = ROUTE_CALL.search(body)
        if not call:
            continue
        key = (call.group(1).upper(), normalize(call.group(2)))
        req = [t for _, t in re.findall(r"(\w+)\s*:\s*&?\s*(\w+)", sig) if t in declared]
        resp = re.search(r"->\s*Result<\s*(\w+)", sig)
        out.setdefault(key, []).append(
            {"method": name, "req": req, "resp": resp.group(1) if resp else None}
        )
    return out


def ts_bindings(client: str, declared: dict) -> dict:
    out: dict[tuple[str, str], list[dict]] = {}
    head = re.compile(r"\n  (?:async )?(\w+)(?:<[^>\n]*>)?\(")
    for name, sig, body in _blocks(client, head):
        call = ROUTE_CALL.search(body)
        if not call:
            continue
        key = (call.group(1).upper(), normalize(call.group(2)))
        req = [t for _, t in re.findall(r"(\w+)\??\s*:\s*(\w+)", sig) if t in declared]
        resp = re.search(r"Promise<\s*(\w+)", sig)
        out.setdefault(key, []).append(
            {"method": name, "req": req, "resp": resp.group(1) if resp else None}
        )
    return out


def py_bindings(client: str) -> dict:
    """Python has no request TYPES — filters are keyword arguments — so the
    request side is the set of KEYS the method puts on the wire.

    Reading the keyword names instead would report `entity_id` as a field the
    edge never declares on every parameterized route: it is a path segment, not
    a body key. The dict literal the method builds is what is actually sent, so
    it is compared directly, with one hop into the `_*_body` helpers that
    `create_statement` and `create_relation` share with their supersede twins.
    The transport itself is not followed — its header dict would contribute
    `authorization` to all 57 routes.
    """
    tree = ast.parse(client)
    cls = next(
        (
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.ClassDef) and n.name == "BrainHttpClient"
        ),
        None,
    )
    if cls is None:
        return {}
    helpers = {
        fn.name: fn
        for fn in cls.body
        if isinstance(fn, ast.FunctionDef) and fn.name.startswith("_")
    }

    def sent_keys(fn: ast.FunctionDef, depth: int = 0) -> set[str]:
        keys: set[str] = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Dict):
                keys |= {
                    k.value
                    for k in node.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)
                }
            if (
                depth == 0
                and isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "self"
                and node.func.attr.endswith(("_body", "_query"))
                and node.func.attr in helpers
            ):
                keys |= sent_keys(helpers[node.func.attr], depth + 1)
        return keys

    def route_of(fn: ast.FunctionDef) -> tuple[str, str] | None:
        # Read from the transport CALL, not from the function's source text:
        # several docstrings quote a `/v1/...` path in prose.
        for node in ast.walk(fn):
            if not (isinstance(node, ast.Call) and len(node.args) >= 2):
                continue
            meth, path = node.args[0], node.args[1]
            if not (isinstance(meth, ast.Constant) and isinstance(meth.value, str)):
                continue
            if isinstance(path, ast.Constant) and isinstance(path.value, str):
                literal = path.value
            elif isinstance(path, ast.JoinedStr):
                literal = "".join(
                    p.value if isinstance(p, ast.Constant) else "{id}"
                    for p in path.values
                )
            else:
                continue
            if literal.startswith("/v1/"):
                return meth.value.upper(), normalize(literal)
        return None

    out: dict[tuple[str, str], list[dict]] = {}
    for fn in cls.body:
        if not isinstance(fn, ast.FunctionDef) or fn.name.startswith("_"):
            continue
        key = route_of(fn)
        if key is None:
            continue
        out.setdefault(key, []).append(
            {
                "method": fn.name,
                "sent": sent_keys(fn),
                "resp": ast.unparse(fn.returns).strip() if fn.returns else None,
            }
        )
    return out


# --------------------------------------------------------------------------
# comparison
# --------------------------------------------------------------------------
def kinds_agree(contract: str, sdk: str) -> bool:
    """Only an unambiguous disagreement counts.

    `?` on either side means one of them is a nested DTO, a map or a union this
    does not model — not evidence of anything. TypeScript's `number` is both
    `int` and `float`, so it satisfies either.

    `bigint` is the TypeScript SDK's 64-bit integer — the `*_unix_nanos`
    timestamps and the session ids, which a `number` rounds. It is an `int` and
    only an `int`: against a `float` it is a real disagreement, not an
    unmodelled type, so it must not fall through to `?` and be waved past.
    """
    if contract == "?" or sdk == "?":
        return True
    if sdk == "number":
        return contract in ("int", "float")
    if sdk == "bigint":
        return contract == "int"
    return contract == sdk


class Report:
    def __init__(self) -> None:
        self.findings: dict[str, list[str]] = {}
        self.advisory: list[str] = []
        self.bound: dict[str, int] = {}
        self.fields: dict[str, int] = {}

    def finding(self, lang: str, kind: str, label: str, where: str, detail: str) -> None:
        self.findings.setdefault(lang, []).append(
            f"{kind:11} {label:40} {where:8} {detail}"
        )


def compare_route(rep: Report, route: dict, dtos: dict, sdks: dict) -> None:
    """One route, three SDKs, both directions, against the manifest."""
    key = (route["method"], normalize(route["path"]))
    label = f"{route['method']} {normalize(route['path'])}"

    expected_req: dict[str, tuple[str, set[str]]] = {}
    # Query and body are one request as far as a caller is concerned, so they
    # are compared as one set. Only the body's shapes are compared — see the
    # module docstring on why a query parameter's type proves nothing.
    body_shapes: set[str] = set()
    for part in ("query", "request_body"):
        dto = route.get(part)
        if dto and dto in dtos:
            fields = contract_fields(dtos, dto)
            expected_req.update(fields)
            if part == "request_body":
                body_shapes |= set(fields)
    declares_request = bool(expected_req)
    expected_resp = (
        contract_fields(dtos, route["response"])
        if route.get("response") in dtos
        else {}
    )

    for lang, sdk in sdks.items():
        bindings = sdk["bindings"].get(key, [])
        if not bindings:
            rep.advisory.append(f"{label:40} {lang:11} no client method takes this route")
            continue
        if len(bindings) > 1:
            names = ", ".join(b["method"] for b in bindings)
            rep.advisory.append(
                f"{label:40} {lang:11} bound to {len(bindings)} methods ({names}) "
                "— fields not compared"
            )
            continue
        bind = bindings[0]
        rep.bound[lang] = rep.bound.get(lang, 0) + 1
        declared = sdk["types"]

        # --- request -------------------------------------------------------
        if lang == "python":
            sdk_req: dict[str, str] | None = {k: "?" for k in bind["sent"]}
            sends_something = bool(bind["sent"])
        else:
            sdk_req = {}
            for name in bind["req"]:
                sdk_req.update(declared.get(name, {}))
            sends_something = bool(bind["req"])
            if not sends_something:
                sdk_req = None

        if sdk_req is not None and declares_request:
            for name, kind in sdk_req.items():
                match = next(
                    (w for w, (_, sp) in expected_req.items() if name in sp), None
                )
                if match is None:
                    if (label, lang, name) not in ALLOWED:
                        rep.finding(lang, "sdk-only", label, "request", name)
                elif match in body_shapes and not kinds_agree(
                    expected_req[match][0], kind
                ):
                    rep.finding(
                        lang,
                        "shape",
                        label,
                        "request",
                        f"{match}: edge {expected_req[match][0]} / sdk {kind}",
                    )
                rep.fields[lang] = rep.fields.get(lang, 0) + 1
            for wire, (_, spellings) in expected_req.items():
                if not (spellings & set(sdk_req)) and (label, lang, wire) not in ALLOWED:
                    rep.finding(lang, "edge-only", label, "request", wire)
        elif sends_something and not declares_request:
            # The manifest is generated; a handler taking its body through an
            # extractor the generator does not model would look exactly like
            # this. Too close to call from here, so it is said out loud and
            # left to a human rather than failing the build.
            rep.advisory.append(
                f"{label:40} {lang:11} sends a request body; the manifest "
                "declares no request DTO for this route"
            )

        # --- response ------------------------------------------------------
        resp_type = bind["resp"]
        if resp_type not in declared:
            if expected_resp:
                rep.advisory.append(
                    f"{label:40} {lang:11} returns {resp_type}, which is not a "
                    "declared type — fields not compared"
                )
            continue
        sdk_resp = declared[resp_type]
        for wire, (kind, spellings) in expected_resp.items():
            hit = sorted(spellings & set(sdk_resp))
            if not hit:
                if (label, lang, wire) not in ALLOWED:
                    rep.finding(lang, "edge-only", label, "response", wire)
            elif not kinds_agree(kind, sdk_resp[hit[0]]):
                rep.finding(
                    lang,
                    "shape",
                    label,
                    "response",
                    f"{wire}: edge {kind} / sdk {sdk_resp[hit[0]]}",
                )
            rep.fields[lang] = rep.fields.get(lang, 0) + 1
        if expected_resp:
            every_spelling = {s for _, sp in expected_resp.values() for s in sp}
            for name in sdk_resp:
                if name not in every_spelling and (label, lang, name) not in ALLOWED:
                    rep.finding(lang, "sdk-only", label, "response", name)


def check_fields(manifest: dict, root: Path, expected: set) -> tuple[Report, bool]:
    dtos = manifest["dtos"]
    sdks: dict[str, dict] = {}
    for lang in CLIENTS:
        client = strip_comments(
            (root / CLIENTS[lang]).read_text(), backtick=(lang == "typescript")
        )
        types_src = (root / TYPES[lang]).read_text()
        if lang == "rust":
            declared = rust_types(strip_comments(types_src))
            bindings = rust_bindings(client, declared)
        elif lang == "typescript":
            declared = ts_types(strip_comments(types_src, backtick=True))
            bindings = ts_bindings(client, declared)
        else:
            declared = py_types(types_src)
            bindings = py_bindings((root / CLIENTS[lang]).read_text())
        sdks[lang] = {"types": declared, "bindings": bindings}

    rep = Report()
    for route in manifest["routes"]:
        if route.get("plane") == "broker":
            continue
        compare_route(rep, route, dtos, sdks)

    # Say how much of the manifest never came under the comparison at all, so
    # the number of findings is read against the size of the blind spot rather
    # than against 123 DTOs. A nested DTO is only reached when it is also some
    # route's top-level shape; the rest are described in the module docstring.
    top_level = {
        route[part]
        for route in manifest["routes"]
        for part in ("query", "request_body", "response")
        if route.get(part)
    }
    nested_only = sorted(set(dtos) - top_level)
    if nested_only:
        rep.advisory.append(
            f"{len(nested_only)} DTO(s) appear only nested inside another and are "
            f"compared as a shape, not field by field: {', '.join(nested_only[:6])}"
            + (" …" if len(nested_only) > 6 else "")
        )

    floor = int(len(expected) * MIN_BOUND_FRACTION)
    broken = False
    print(f"field comparison, against {len(dtos)} edge DTOs\n")
    for lang in CLIENTS:
        bound, fields = rep.bound.get(lang, 0), rep.fields.get(lang, 0)
        rows = rep.findings.get(lang, [])
        status = "ok" if not rows else "FAIL"
        if bound < floor:
            status = "UNUSABLE"
            broken = True
        print(
            f"{lang:11} {bound:2}/{len(expected)} routes   "
            f"{fields:4} fields   [{status}]"
        )
        for row in sorted(rows):
            print(f"              {row}")
        if bound < floor:
            print(
                f"              only {bound} of {len(expected)} routes bound to a "
                f"client method (floor {floor}) — the parser has lost touch with "
                "the source; this result means nothing",
                file=sys.stderr,
            )
    return rep, broken


# --------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    root = ROOT
    args = []
    for i, arg in enumerate(argv):
        if arg == "--root":
            if i + 1 >= len(argv):
                print("--root needs a directory", file=sys.stderr)
                return 2
            root = Path(argv[i + 1])
        elif i and argv[i - 1] == "--root":
            continue
        else:
            args.append(arg)

    manifest_path = Path(args[0]) if args else root / "contract" / "http-routes.json"
    manifest = json.loads(manifest_path.read_text())

    if manifest.get("unparsed"):
        print(f"contract manifest has {len(manifest['unparsed'])} unparsed items — not trustworthy:")
        for u in manifest["unparsed"][:10]:
            print(f"  ! {u}")
        return 1

    # The broker plane is excluded: Brain calls those routes with a
    # deployment-wide token, not a tenant credential, so they are not the
    # SDK's to implement. Without this they report missing from all three
    # clients forever — and `ROUTE_CALL` only matches `/v1/` paths anyway, so
    # the alarm could not be silenced even by implementing them.
    #
    # Read from the manifest's own `plane` rather than from a path prefix
    # here, so the line moves when brain-edge's routers move.
    broker = sorted(
        (r["method"], r["path"]) for r in manifest["routes"] if r.get("plane") == "broker"
    )
    expected = {
        (r["method"], normalize(r["path"]))
        for r in manifest["routes"]
        if r.get("plane") != "broker"
    }
    print(f"brain-edge exposes {len(expected)} tenant method+path combos "
          f"across {len({p for _, p in expected})} paths "
          f"({len(broker)} broker routes excluded)\n")

    failed = False
    for lang, rel in CLIENTS.items():
        path = root / rel
        if not path.exists():
            print(f"{lang:11} SOURCE NOT FOUND: {path}")
            failed = True
            continue
        have = routes_in(path.read_text())
        missing = sorted(expected - have)
        # A client route the edge does not serve is a 404 waiting to happen.
        extra = sorted({r for r in have if r[1].startswith("/v1/")} - expected)

        status = "ok" if not missing and not extra else "FAIL"
        print(f"{lang:11} {len(expected) - len(missing):2}/{len(expected)} routes   [{status}]")
        for meth, p in missing:
            print(f"              missing  {meth:6} {p}")
        for meth, p in extra:
            print(f"              not on the edge  {meth:6} {p}")
        if missing or extra:
            failed = True

    print()
    if failed:
        # The field check reads the same client methods this one just failed to
        # recognise, so running it now would report nonsense on top of a real
        # finding. Fix the routes first.
        print("HTTP contract drift. Either the SDK is missing a route the edge serves,", file=sys.stderr)
        print("or the vendored manifest is stale — refresh it per contract/SOURCE.txt.", file=sys.stderr)
        return 1

    rep, broken = check_fields(manifest, root, expected)
    drift = any(rep.findings.values())

    if rep.advisory:
        print(f"\nadvisory — {len(rep.advisory)} thing(s) this gate will not decide:")
        for row in sorted(set(rep.advisory)):
            print(f"  {row}")

    print()
    if broken:
        return 1
    if drift:
        total = sum(len(v) for v in rep.findings.values())
        print(f"{total} field(s) adrift between the SDKs and the edge:", file=sys.stderr)
        print("  sdk-only   the SDK sends or reads it and no edge DTO declares it —", file=sys.stderr)
        print("             it does nothing. Drop it, or add it to the edge.", file=sys.stderr)
        print("  edge-only  the edge declares it and no SDK user can reach it.", file=sys.stderr)
        print("  shape      both sides have it and disagree on the type.", file=sys.stderr)
        print("Or the vendored manifest is stale — refresh it per contract/SOURCE.txt.", file=sys.stderr)
        return 1
    print("All three SDKs cover the edge's HTTP surface, field for field.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
