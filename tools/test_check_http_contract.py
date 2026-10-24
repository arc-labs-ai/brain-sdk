#!/usr/bin/env python3
"""Unit tests for the HTTP contract gate's FIELD comparator.

Every fixture here is synthetic. The live tree cannot be the test subject: it
is green on the day it is written and the test then proves nothing, and the
one thing this gate must do — report `include_trace` as a parameter no edge DTO
declares — is only observable on a tree where that drift exists. So a small
fake contract and three small fake SDKs are built in a temp dir, each carrying
one planted instance of every case, alongside the legitimate differences the
comparator must stay quiet about.

The quiet cases carry as much weight as the loud ones. A gate that reports a
serde alias, a camelCase spelling or a client-side retry knob as drift gets
switched off within a week, and then the loud cases go unseen too.

    python3 tools/test_check_http_contract.py
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_http_contract as gate  # noqa: E402


# --------------------------------------------------------------------------
# the fake contract
# --------------------------------------------------------------------------
def dto(*fields):
    return {
        "fields": [
            {"name": n, "shape": s, "serde": (sd or {})} for n, s, sd in fields
        ]
    }


CONTRACT = {
    "dtos": {
        # `query` is accepted as `cue` too — an SDK spelling either one is right.
        "RecallBody": dto(
            ("query", "string", {"alias": "cue"}),
            ("max_results", "opt(int)", {"default": True}),
            ("scope", "opt(string)", {"default": True}),
        ),
        "RecallResponseDto": dto(
            ("answer_kind", "string", None),
            ("trace", "opt(string)", {"skip_serializing_if": "Option::is_none"}),
        ),
        # `type` on the wire, `widget_type` in Rust — the ListRelationsQuery shape.
        "ListWidgetsQuery": dto(
            ("widget_type", "string", {"rename": "type", "default": True}),
            ("limit", "opt(int)", None),
        ),
        "ListWidgetsResponseDto": dto(
            ("widgets", "list(WidgetDto)", None),
            ("next_cursor", "opt(string)", {"skip_serializing_if": "Option::is_none"}),
        ),
        "WidgetDto": dto(("widget_id", "string", None)),
        # `from` is a Python keyword; `count` is the planted shape disagreement.
        "ThingDto": dto(("from", "string", None), ("count", "int", None)),
        # Nothing but a flattened CreateThingBody — no `thing` key on the wire.
        "SupersedeThingBody": dto(("thing", "CreateThingBody", {"flatten": True})),
        "CreateThingBody": dto(("label", "string", None)),
    },
    "enums": {},
    "routes": [
        {
            "handler": "memory::recall",
            "method": "POST",
            "path": "/v1/recall",
            "plane": "tenant",
            "query": None,
            "request_body": "RecallBody",
            "response": "RecallResponseDto",
        },
        {
            "handler": "widget::list",
            "method": "GET",
            "path": "/v1/widgets",
            "plane": "tenant",
            "query": "ListWidgetsQuery",
            "request_body": None,
            "response": "ListWidgetsResponseDto",
        },
        {
            "handler": "thing::get",
            "method": "GET",
            "path": "/v1/things/{id}",
            "plane": "tenant",
            "query": None,
            "request_body": None,
            "response": "ThingDto",
        },
        {
            "handler": "thing::supersede",
            "method": "POST",
            "path": "/v1/things/{id}/supersede",
            "plane": "tenant",
            "query": None,
            "request_body": "SupersedeThingBody",
            "response": "ThingDto",
        },
        # Brain's own credential reaches this one, not a tenant's — excluded,
        # and no SDK implements it.
        {
            "handler": "llm_proxy::messages",
            "method": "POST",
            "path": "/llm/ns/{namespace}/messages",
            "plane": "broker",
            "query": None,
            "request_body": None,
            "response": None,
        },
    ],
    "unparsed": [],
}


# --------------------------------------------------------------------------
# the fake SDKs
#
# Planted in all three, identically, so a finding that appears for one language
# and not the others is a parser bug rather than drift:
#   sdk-only  request  include_trace   — the flag the edge never declared
#   sdk-only  response latency_ms      — a field invented client-side
#   edge-only request  scope           — a filter no SDK caller can pass
#   shape     response count           — edge int, SDK string
#
# Planted as legitimate, and expected to stay silent:
#   the `cue` alias, the `type` rename, TypeScript camelCase, Python's `from_`,
#   a flattened request body, a `#[serde(skip)]` field, and a retry-policy type
#   no route signature mentions.
# --------------------------------------------------------------------------
RUST_TYPES = """
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct RecallInput {
    pub query: String,
    pub max_results: Option<u32>,
    /// Client-side only: never serialized, so the edge cannot declare it.
    #[serde(skip)]
    pub local_only: bool,
    pub include_trace: Option<bool>,
}

#[derive(Deserialize)]
pub struct RecallResult {
    pub answer_kind: String,
    pub trace: Option<String>,
    pub latency_ms: u64,
}

#[derive(Serialize)]
pub struct ListWidgetsQuery {
    #[serde(rename = "type")]
    pub widget_type: String,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
pub struct ListWidgetsResult {
    pub widgets: Vec<Widget>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
pub struct Widget {
    pub widget_id: String,
}

#[derive(Deserialize)]
pub struct Thing {
    pub from: String,
    pub count: String,
}

#[derive(Serialize)]
pub struct SupersedeThingInput {
    pub label: String,
}

/// Never named by a route method, so never compared.
pub struct HttpRetryPolicy {
    pub max_attempts: u32,
    pub base_url: String,
}
"""

RUST_CLIENT = """
impl BrainHttpClient {
    /// Recall. Supersedes the old POST "/v1/recall-v0" endpoint.
    pub async fn recall(&self, input: &RecallInput) -> Result<RecallResult, BrainHttpError> {
        self.send(reqwest::Method::POST, "/v1/recall", Some(input), true).await
    }

    pub async fn list_widgets(&self, query: &ListWidgetsQuery) -> Result<ListWidgetsResult, BrainHttpError> {
        // Was POST "/v1/widgets/bulk" before the split.
        let base = "https://api.example.invalid"; self.send(reqwest::Method::GET, "/v1/widgets", None::<&()>, true).await
    }

    pub async fn get_thing(&self, thing_id: &str) -> Result<Thing, BrainHttpError> {
        self.send(reqwest::Method::GET, &format!("/v1/things/{}", thing_id), None::<&()>, true).await
    }

    pub async fn supersede_thing(
        &self,
        thing_id: &str,
        input: &SupersedeThingInput,
    ) -> Result<Thing, BrainHttpError> {
        self.send(reqwest::Method::POST, &format!("/v1/things/{}/supersede", thing_id), Some(input), false).await
    }
}
"""

TS_TYPES = """
export interface RecallInput {
  query: string;
  maxResults?: number;
  includeTrace?: boolean;
}
export interface RecallResult {
  answerKind: string;
  trace?: string;
  latencyMs: number;
}
export interface ListWidgetsQuery {
  /** `>= 1` — `0` is not a type and is rejected (`422`). */
  type: string;
  limit?: number;
}
export interface ListWidgetsResult {
  widgets: Widget[];
  nextCursor?: string;
}
export interface Widget {
  widgetId: string;
}
export interface Thing {
  from: string;
  count: string;
}
export interface SupersedeThingInput {
  label: string;
}
/** Never named by a route method, so never compared. */
export interface HttpRetryPolicy {
  maxAttempts: number;
  baseUrl: string;
}
"""

TS_CLIENT = """
export class BrainHttpClient {
  recall(input: RecallInput): Promise<RecallResult> {
    return this.request("POST", "/v1/recall", input);
  }

  listWidgets(query?: ListWidgetsQuery): Promise<ListWidgetsResult> {
    // Was POST "/v1/widgets/bulk" before the split.
    return this.request("GET", "/v1/widgets", undefined, query);
  }

  getThing(thingId: string): Promise<Thing> {
    return this.request("GET", `/v1/things/${thingId}`);
  }

  supersedeThing(thingId: string, input: SupersedeThingInput = {}): Promise<Thing> {
    return this.request("POST", `/v1/things/${thingId}/supersede`, input);
  }
}
"""

PY_TYPES = '''
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class RecallResult:
    answer_kind: str
    trace: Optional[str] = None
    latency_ms: int = 0


@dataclass
class Widget:
    widget_id: str


@dataclass
class ListWidgetsResult:
    widgets: list[Widget]
    next_cursor: Optional[str] = None


@dataclass
class Thing:
    from_: str
    count: str


@dataclass
class HttpRetryPolicy:
    """Never named by a route method, so never compared."""

    max_attempts: int = 3
    base_url: str = ""
'''

PY_CLIENT = '''
from typing import Any, Mapping, Optional


def _compact(d):
    return {k: v for k, v in d.items() if v is not None}


class BrainHttpClient:
    def _request(self, method, path, body=None, query=None, idempotent=False):
        headers = {"authorization": self._api_key, "accept": "application/json"}
        return self._send(method, path, body, query, headers)

    def _thing_body(self, label):
        return _compact({"label": label})

    def recall(
        self,
        query: str,
        max_results: Optional[int] = None,
        include_trace: Optional[bool] = None,
    ) -> RecallResult:
        """Recall memories for a cue.

        Supersedes the old POST /v1/recall-v0 endpoint.
        """
        body = _compact(
            {"query": query, "max_results": max_results, "include_trace": include_trace}
        )
        return RecallResult.from_dict(self._request("POST", "/v1/recall", body, idempotent=True))

    def list_widgets(
        self,
        widget_type: str,
        limit: Optional[int] = None,
    ) -> ListWidgetsResult:
        """Widgets of a type."""
        query = _compact({"type": widget_type, "limit": limit})
        return ListWidgetsResult.from_dict(
            self._request("GET", "/v1/widgets", query=query, idempotent=True)
        )

    def get_thing(self, thing_id: str) -> Thing:
        """One thing by id."""
        return Thing.from_dict(self._request("GET", f"/v1/things/{thing_id}", idempotent=True))

    def supersede_thing(self, thing_id: str, label: str) -> Thing:
        """Replace a thing."""
        return Thing.from_dict(
            self._request(
                "POST",
                f"/v1/things/{thing_id}/supersede",
                self._thing_body(label),
            )
        )
'''


def build_tree(
    directory: Path,
    contract: dict | None = None,
    rust_client: str = RUST_CLIENT,
    py_client: str = PY_CLIENT,
    ts_client: str = TS_CLIENT,
) -> Path:
    files = {
        "contract/http-routes.json": json.dumps(contract or CONTRACT, indent=2),
        "rust/src/http/types.rs": RUST_TYPES,
        "rust/src/http/client.rs": rust_client,
        "typescript/src/http/types.ts": TS_TYPES,
        "typescript/src/http/client.ts": ts_client,
        "python/src/brain_db_sdk/http/types.py": PY_TYPES,
        "python/src/brain_db_sdk/http/client.py": py_client,
    }
    for rel, body in files.items():
        path = directory / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return directory


def run_gate(root: Path) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "check_http_contract.py"),
         "--root", str(root)],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


HEADER = re.compile(r"^(rust|python|typescript)\s+\d+/\d+ routes")
FINDING = re.compile(r"^ {14}(\S+)\s+(\S+ \S+)\s+(request|response)\s+(.*?)\s*$")


def findings(out: str) -> set[tuple[str, str, str, str, str]]:
    """`(language, kind, route, where, detail)` for every reported finding.

    Parsed rather than grepped because the same finding appears once per SDK,
    word for word. Collapsing the three into one set — which is what a plain
    substring search over the output does — hides the single most useful
    signal in the report: whether one SDK is adrift or all three are, which is
    the difference between a client bug and a stale contract.
    """
    out_rows = set()
    lang = ""
    for line in out.splitlines():
        head = HEADER.match(line)
        if head:
            lang = head.group(1)
            continue
        row = FINDING.match(line)
        if row and lang:
            out_rows.add((lang, row.group(1), row.group(2), row.group(3), row.group(4)))
    return out_rows


class FixtureCase(unittest.TestCase):
    """One run of the gate over the synthetic tree, shared by the assertions."""

    LANGS = ("rust", "python", "typescript")

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        root = build_tree(Path(cls._tmp.name))
        cls.code, cls.out = run_gate(root)
        cls.found = findings(cls.out)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def assert_every_sdk(self, kind: str, route: str, where: str, detail: str) -> None:
        for lang in self.LANGS:
            self.assertIn(
                (lang, kind, route, where, detail),
                self.found,
                f"{lang} did not report {kind} {route} {where} {detail}\n{self.out}",
            )

    def fields_named(self, name: str) -> set:
        """Findings ABOUT a field called `name` — not rows merely containing it.

        `_assert_silent("thing")` matched the path `/v1/things/{id}` and turned
        a passing comparator into a failing test; the field name lives in the
        detail column alone.
        """
        return {f for f in self.found if f[4] == name or f[4].startswith(name + ":")}


class TestRoutesStillChecked(FixtureCase):
    def test_route_coverage_survives_and_excludes_the_broker_plane(self):
        self.assertIn("exposes 4 tenant method+path combos", self.out)
        self.assertIn("(1 broker routes excluded)", self.out)
        for lang in ("rust", "python", "typescript"):
            self.assertRegex(self.out, rf"{lang}\s+4/4 routes\s+\[ok\]")


class TestCatchesDrift(FixtureCase):
    def test_1_request_field_no_edge_dto_declares(self):
        """The include_trace case: a parameter the client sends into the void."""
        self.assert_every_sdk(
            "sdk-only", "POST /v1/recall", "request", "include_trace"
        )

    def test_1b_response_field_no_edge_dto_declares(self):
        self.assert_every_sdk("sdk-only", "POST /v1/recall", "response", "latency_ms")

    def test_2_edge_field_no_sdk_surfaces(self):
        """The subject_name/cursor case: a capability no SDK user can reach."""
        self.assert_every_sdk("edge-only", "POST /v1/recall", "request", "scope")

    def test_3_shape_disagreement(self):
        detail = "count: edge int / sdk string"
        self.assert_every_sdk("shape", "GET /v1/things/{id}", "response", detail)
        # ThingDto answers two routes, so it is compared on both — the report
        # names the route a caller would hit, not the DTO they cannot see.
        self.assert_every_sdk(
            "shape", "POST /v1/things/{id}/supersede", "response", detail
        )

    def test_exit_code_is_non_zero(self):
        self.assertEqual(1, self.code, self.out)


class TestStaysQuiet(FixtureCase):
    """The false positives that would get this gate switched off."""

    def _assert_silent(self, *names: str) -> None:
        for name in names:
            self.assertEqual(
                set(),
                self.fields_named(name),
                f"`{name}` must not be reported\n{self.out}",
            )

    def test_serde_alias_is_not_drift(self):
        # `query` is also accepted as `cue`; every SDK spells it `query`.
        self._assert_silent("query", "cue")

    def test_serde_rename_is_not_drift(self):
        # `widget_type` goes out as `type`; TypeScript declares `type`.
        self._assert_silent("widget_type", "type", "limit")
        self.assertEqual(
            set(), {f for f in self.found if f[2] == "GET /v1/widgets"}, self.out
        )

    def test_typescript_camel_case_is_not_drift(self):
        self._assert_silent("max_results", "next_cursor", "answer_kind", "widgets")

    def test_python_keyword_dodge_is_not_drift(self):
        # `from_` is `from` on the wire; it is a keyword, not a rename.
        self._assert_silent("from", "from_")

    def test_flattened_request_body_is_not_drift(self):
        # SupersedeThingBody has no `thing` key on the wire — only `label`.
        self._assert_silent("thing", "label")

    def test_client_side_only_type_is_not_drift(self):
        # The retry policy is never named by a route method, so it is never
        # reached — no allowlist entry keeps it out, the binding does.
        self._assert_silent("max_attempts", "base_url", "local_only")

    def test_transport_headers_are_not_request_fields(self):
        # Following `_request` would add `authorization` to every Python route.
        self._assert_silent("authorization", "accept", "headers")

    def test_path_segments_are_not_request_fields(self):
        # Python names the id as a keyword argument; it is a path segment, not
        # a body key, and reading the signature instead of the body says
        # otherwise on every parameterized route.
        self._assert_silent("thing_id", "id")

    def test_findings_are_only_the_planted_ones(self):
        planted = {"include_trace", "latency_ms", "scope", "count"}
        for found in self.found:
            self.assertIn(
                found[4].split(":")[0],
                planted,
                f"unplanted finding — a false positive: {found}\n{self.out}",
            )

    def test_each_planted_finding_appears_in_every_sdk(self):
        """A finding in one SDK and not the others means a parser, not drift."""
        by_detail: dict[tuple[str, str, str], set[str]] = {}
        for lang, kind, route, where, detail in self.found:
            by_detail.setdefault((kind, route, detail), set()).add(lang)
        for key, langs in by_detail.items():
            self.assertEqual(set(self.LANGS), langs, f"{key} seen only in {langs}")


class TestBindingHazards(unittest.TestCase):
    def test_a_route_quoted_in_a_comment_does_not_bind_the_method(self):
        """Both clients mention a dead route in a comment above the live call."""
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp))
            code, out = run_gate(root)
        # Had the comment bound, /v1/widgets would be unbound and the three
        # `type`/`limit`/`next_cursor` fields would read as edge-only.
        self.assertNotIn("no client method takes this route", out)
        self.assertNotIn("next_cursor", out)

    def test_a_route_quoted_in_a_docstring_does_not_bind_the_method(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp))
            code, out = run_gate(root)
        self.assertNotIn("/v1/recall-v0", out)

    def test_a_url_scheme_on_the_call_line_does_not_eat_the_route(self):
        """`https://` is not a comment; the Rust fixture puts one on the call line."""
        stripped = gate.strip_comments(RUST_CLIENT)
        self.assertIn('"/v1/widgets"', stripped)
        self.assertNotIn("api.example.invalid before", stripped)

    def test_two_methods_on_one_route_are_advisory_not_a_finding(self):
        doubled = RUST_CLIENT.replace(
            "    pub async fn get_thing",
            '    pub async fn peek_thing(&self, thing_id: &str) -> Result<Thing, BrainHttpError> {\n'
            '        self.send(reqwest::Method::GET, &format!("/v1/things/{}", thing_id), None::<&()>, true).await\n'
            "    }\n\n    pub async fn get_thing",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp), rust_client=doubled)
            code, out = run_gate(root)
        self.assertIn("bound to 2 methods", out)
        self.assertIn("rust         3/4 routes", out)

    def test_a_client_the_parser_cannot_read_is_unusable_not_clean(self):
        """A binder that recognises nothing finds nothing, which reads as green."""
        macro_client = """
impl BrainHttpClient {
    route!(recall, POST, "/v1/recall");
    route!(list_widgets, GET, "/v1/widgets");
    route!(get_thing, GET, "/v1/things/{}");
    route!(supersede_thing, POST, "/v1/things/{}/supersede");
}
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp), rust_client=macro_client)
            code, out = run_gate(root)
        self.assertEqual(1, code)
        self.assertIn("UNUSABLE", out)
        self.assertIn("this result means nothing", out)


class TestAdvisoryNotFailure(unittest.TestCase):
    def test_a_body_the_manifest_declares_no_dto_for_is_advisory(self):
        """The manifest is generated; an unmodelled extractor looks like this."""
        contract = json.loads(json.dumps(CONTRACT))
        for route in contract["routes"]:
            if route["path"] == "/v1/recall":
                route["request_body"] = None
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp), contract=contract)
            code, out = run_gate(root)
        self.assertIn("declares no request DTO for this route", out)
        self.assertNotIn("include_trace", out)

    def test_a_response_type_that_is_not_a_declared_struct_is_advisory(self):
        """The SSE feed shape: `subscribe` returns a stream, not a DTO."""
        contract = json.loads(json.dumps(CONTRACT))
        for route in contract["routes"]:
            if route["path"] == "/v1/things/{id}":
                route["response"] = "ListWidgetsResponseDto"
        rust = RUST_CLIENT.replace(
            "pub async fn get_thing(&self, thing_id: &str) -> Result<Thing, BrainHttpError>",
            "pub async fn get_thing(&self, thing_id: &str) -> Result<ThingStream, BrainHttpError>",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp), contract=contract, rust_client=rust)
            code, out = run_gate(root)
        self.assertIn("returns ThingStream, which is not a declared type", out)

    def test_a_clean_tree_exits_zero(self):
        """Without this the suite only ever proves the gate can say no."""
        rust = (
            RUST_TYPES.replace("    pub include_trace: Option<bool>,\n", "")
            .replace("    pub latency_ms: u64,\n", "")
            .replace("    pub count: String,", "    pub count: u32,")
        )
        contract = json.loads(json.dumps(CONTRACT))
        contract["dtos"]["RecallBody"]["fields"] = [
            f for f in contract["dtos"]["RecallBody"]["fields"] if f["name"] != "scope"
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = build_tree(Path(tmp), contract=contract)
            (root / "rust/src/http/types.rs").write_text(rust)
            # Only Rust is made clean, so the run is narrowed to it.
            saved = dict(gate.CLIENTS)
            gate.CLIENTS.clear()
            gate.CLIENTS["rust"] = saved["rust"]
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    code = gate.main(["--root", str(root)])
            finally:
                gate.CLIENTS.clear()
                gate.CLIENTS.update(saved)
        self.assertEqual(0, code)


class TestPieces(unittest.TestCase):
    """The small decisions, where a regression is cheapest to catch."""

    def test_flatten_expands_rather_than_comparing_a_name(self):
        fields = gate.contract_fields(CONTRACT["dtos"], "SupersedeThingBody")
        self.assertEqual({"label"}, set(fields))

    def test_alias_and_rename_both_count_as_spellings(self):
        fields = gate.contract_fields(CONTRACT["dtos"], "RecallBody")
        self.assertIn("cue", fields["query"][1])
        widgets = gate.contract_fields(CONTRACT["dtos"], "ListWidgetsQuery")
        self.assertIn("type", widgets)
        self.assertIn("widget_type", widgets["type"][1])

    def test_shapes_reduce_to_something_comparable(self):
        self.assertEqual("string", gate.contract_kind("opt(string)"))
        self.assertEqual("list", gate.contract_kind("list(WidgetDto)"))
        self.assertEqual("?", gate.contract_kind("opt(TimeRangeDto)"))
        self.assertEqual("int", gate.rust_kind("Option<u64>"))
        self.assertEqual("list", gate.rust_kind("Vec<String>"))
        self.assertEqual("string", gate.py_kind("Optional[str]"))
        self.assertEqual("list", gate.ts_kind("string[]"))
        self.assertEqual("bigint", gate.ts_kind("bigint"))
        self.assertEqual("bigint", gate.ts_kind("bigint | null"))
        self.assertEqual("list", gate.ts_kind("bigint[]"))

    def test_an_unmodelled_type_is_never_a_shape_finding(self):
        # One side being a nested DTO or a map is not evidence of anything.
        self.assertTrue(gate.kinds_agree("?", "string"))
        self.assertTrue(gate.kinds_agree("int", "?"))
        # TypeScript cannot tell the two numeric kinds apart, so it satisfies both.
        self.assertTrue(gate.kinds_agree("int", "number"))
        self.assertTrue(gate.kinds_agree("float", "number"))
        self.assertFalse(gate.kinds_agree("string", "number"))
        # `bigint` is the TypeScript SDK's 64-bit integer, so it satisfies an
        # `int` and nothing else — it must not land in the undecidable bucket,
        # where a `bigint` declared against a `float` would go unreported.
        self.assertTrue(gate.kinds_agree("int", "bigint"))
        self.assertFalse(gate.kinds_agree("float", "bigint"))
        self.assertFalse(gate.kinds_agree("string", "bigint"))

    def test_python_keyword_dodge_maps_back_to_the_wire_name(self):
        self.assertEqual("from", gate.py_wire_name("from_"))
        self.assertEqual("_private", gate.py_wire_name("_private"))
        self.assertEqual("subject", gate.py_wire_name("subject"))

    def test_rust_skip_fields_never_reach_the_wire(self):
        parsed = gate.rust_types(gate.strip_comments(RUST_TYPES))
        self.assertNotIn("local_only", parsed["RecallInput"])
        self.assertEqual("type", next(k for k in parsed["ListWidgetsQuery"] if k != "limit"))

    def test_typescript_comments_do_not_swallow_interface_members(self):
        # A doc comment reading `>= 1` once took the parser's depth negative and
        # dropped every member after it, silently.
        parsed = gate.ts_types(gate.strip_comments(TS_TYPES, backtick=True))
        self.assertEqual({"type", "limit"}, set(parsed["ListWidgetsQuery"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
