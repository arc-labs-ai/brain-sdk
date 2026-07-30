"""The HTTP tier: routing, auth, error mapping, and retry.

`BrainHttpClient` is what talks to `brain-edge`, and it had no tests in any of
the three SDKs. The wire client's mock-server suites do not cover it — it is a
separate transport with its own error taxonomy and its own retry policy.

Driven against an in-process HTTP server rather than a live edge, because the
interesting behaviour here is what happens when things go *wrong*: a 503 mid
retry, a `Retry-After` hint, a body that is not JSON, a socket that dies. None
of those are reachable on demand from a healthy server. `tests/http/` covers the
happy path against a real edge.
"""

from __future__ import annotations

import contextlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from brain_db_sdk.http import (
    BrainHttpClient,
    BrainHttpError,
    StatementObject,
    StatementValue,
)
from brain_db_sdk.http.retry import HttpRetryPolicy

API_KEY = "brain_test-key"


class _Recorder:
    """What the server saw, and what it should answer with."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        # Each entry: (status, body_dict_or_text, extra_headers)
        self.responses: list[tuple] = []

    def next_response(self) -> tuple:
        return self.responses.pop(0) if self.responses else (200, {}, {})


def _serve(rec: _Recorder):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:  # keep the test output clean
            pass

        def _handle(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b""
            rec.requests.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "auth": self.headers.get("authorization"),
                    "content_type": self.headers.get("content-type"),
                    "body": json.loads(raw) if raw else None,
                }
            )
            status, body, extra = rec.next_response()
            payload = (body if isinstance(body, str) else json.dumps(body)).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)

        # PUT is here for `replace_schema` — the one destructive route on the
        # HTTP surface.
        do_GET = do_POST = do_PUT = do_DELETE = _handle

    return Handler


@pytest.fixture
def edge():
    """An in-process stand-in for `brain-edge`. Yields (client, recorder)."""
    rec = _Recorder()
    server = HTTPServer(("127.0.0.1", 0), _serve(rec))
    # poll_interval defaults to 0.5s, which is how long shutdown() blocks --
    # 7s of pure waiting across this suite.
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    host, port = server.server_address
    client = BrainHttpClient(
        API_KEY,
        f"http://{host}:{port}",
        # No sleeping in tests: the schedule is asserted separately from the
        # decision to retry.
        retry=HttpRetryPolicy(max_attempts=3, base_delay=0.0, max_delay=0.0),
    )
    try:
        yield client, rec
    finally:
        server.shutdown()
        server.server_close()


# --- routing and auth ------------------------------------------------------


def test_encode_posts_to_the_right_route_with_auth(edge) -> None:
    client, rec = edge
    rec.responses = [
        (
            200,
            {
                "memory_id": "42",
                "was_deduplicated": False,
                "salience": 0.5,
                "kind": 0,
                "created_at_unix_nanos": 7,
                "auto_edges_added": 1,
            },
            {},
        )
    ]
    out = client.encode("the sky is teal")

    assert len(rec.requests) == 1
    req = rec.requests[0]
    assert (req["method"], req["path"]) == ("POST", "/v1/memories")
    assert req["auth"] == f"Bearer {API_KEY}", "the API key must ride every request"
    assert req["content_type"] == "application/json"
    assert req["body"] == {"text": "the sky is teal"}
    assert out.memory_id == "42"
    assert out.auto_edges_added == 1


@pytest.mark.parametrize(
    ("call", "method", "path"),
    [
        (lambda c: c.recall("what colour"), "POST", "/v1/recall"),
        (lambda c: c.forget("42"), "DELETE", "/v1/memories"),
        (lambda c: c.link("1", "2", "caused"), "POST", "/v1/links"),
        (lambda c: c.unlink("1", "2", "caused"), "DELETE", "/v1/links"),
        (lambda c: c.whoami(), "GET", "/v1/whoami"),
        (lambda c: c.capabilities(), "GET", "/v1/capabilities"),
    ],
)
def test_every_verb_hits_its_documented_route(edge, call, method, path) -> None:
    """A wrong path is a 404 against a real edge and silence against a mock, so
    the route each verb uses is asserted directly."""
    client, rec = edge
    rec.responses = [(200, _minimal_body_for(path), {})]
    # A minimal body may not populate every field of the result type; the
    # assertion here is about the request, not the response shape.
    with contextlib.suppress(KeyError, TypeError):
        call(client)
    assert rec.requests, f"{method} {path}: no request reached the server"
    assert (rec.requests[0]["method"], rec.requests[0]["path"]) == (method, path)


# The 16 routes the client did not reach before: entities, relations,
# statements, graph, schema, and the paginated memory list. Each entry is the
# call, the method and path it must produce, and the query string it must build
# when every optional filter is supplied.
#
# The query strings are asserted literally rather than parsed back into a dict,
# because the two things most likely to be wrong are invisible to a dict
# comparison: a Python `True` reaching the wire as `True` (serde reads `true`),
# and a field whose wire name differs from the keyword argument
# (`relation_type` -> `type`).
READ_SIDE_ROUTES = [
    (
        lambda c: c.memory_list(limit=2, cursor="c1", dir="desc", include_tombstoned=False),
        "GET",
        "/v1/memories",
        "limit=2&cursor=c1&dir=desc&include_tombstoned=false",
    ),
    (
        lambda c: c.memory_inspect("mem-1"),
        "GET",
        "/v1/memories/mem-1/inspect",
        "",
    ),
    (
        lambda c: c.list_entities(
            type_id=3,
            prefix="Ada",
            mention_count_min=2,
            include_tombstoned=False,
            include_merged=True,
            limit=10,
        ),
        "GET",
        "/v1/entities",
        "type_id=3&prefix=Ada&mention_count_min=2&include_tombstoned=false"
        + "&include_merged=true&limit=10",
    ),
    (
        lambda c: c.get_entity("ent-1"),
        "GET",
        "/v1/entities/ent-1",
        "",
    ),
    (
        lambda c: c.create_entity(3, "Ada Lovelace", aliases=["Ada"]),
        "POST",
        "/v1/entities",
        "",
    ),
    (
        lambda c: c.resolve_entity("Ada", resolution_context="maths", allow_create=True),
        "POST",
        "/v1/entities/resolve",
        "",
    ),
    (
        lambda c: c.traverse_relations("ent-1", direction="out", max_depth=2),
        "POST",
        "/v1/entities/ent-1/traverse",
        "",
    ),
    (
        lambda c: c.list_relations(
            "ent-1",
            direction="out",
            relation_type="knows",
            include_superseded=False,
            include_tombstoned=False,
            limit=5,
        ),
        "GET",
        "/v1/entities/ent-1/relations",
        "direction=out&type=knows&include_superseded=false" + "&include_tombstoned=false&limit=5",
    ),
    (
        lambda c: c.get_relation("rel-1", follow_supersession=True),
        "GET",
        "/v1/relations/rel-1",
        "follow_supersession=true",
    ),
    (
        lambda c: c.list_statements(
            subject="ent-1",
            predicate="knows",
            kind="fact",
            min_confidence=0.5,
            only_current=True,
            include_tombstoned=False,
            limit=7,
        ),
        "GET",
        "/v1/statements",
        "subject=ent-1&predicate=knows&kind=fact&min_confidence=0.5"
        + "&only_current=true&include_tombstoned=false&limit=7",
    ),
    (
        lambda c: c.get_statement("stmt-1", follow_supersession=False),
        "GET",
        "/v1/statements/stmt-1",
        "follow_supersession=false",
    ),
    (
        lambda c: c.graph_fetch(
            limit=50,
            cursor="c1",
            include_statements=True,
            include_memories=False,
            include_memory_edges=False,
            include_tombstoned=False,
        ),
        "GET",
        "/v1/graph",
        "limit=50&cursor=c1&include_statements=true&include_memories=false"
        + "&include_memory_edges=false&include_tombstoned=false",
    ),
    (
        lambda c: c.get_schema(namespace="app", version=2),
        "GET",
        "/v1/schema",
        "namespace=app&version=2",
    ),
    (
        lambda c: c.upload_schema("entity Person {}", dry_run=True),
        "POST",
        "/v1/schema",
        "",
    ),
    (
        lambda c: c.validate_schema("entity Person {}"),
        "POST",
        "/v1/schema/validate",
        "",
    ),
    (
        lambda c: c.replace_schema("entity Person {}", force_drop_existing=True),
        "PUT",
        "/v1/schema",
        "",
    ),
]


@pytest.mark.parametrize(
    ("call", "method", "path", "query"),
    READ_SIDE_ROUTES,
    ids=[f"{m} {p}" for _c, m, p, _q in READ_SIDE_ROUTES],
)
def test_read_side_routes_match_the_edge_contract(edge, call, method, path, query) -> None:
    """Every route in `contract/http-routes.json` that the client gained, driven
    end to end. The client and the edge were independent hand transcriptions of
    the same JSON, so the request line is what is asserted."""
    client, rec = edge
    rec.responses = [(200, {}, {})]
    # An empty body will not populate the result type; the assertion here is
    # about the request, not the response shape.
    with contextlib.suppress(KeyError, TypeError):
        call(client)

    assert rec.requests, f"{method} {path}: no request reached the server"
    sent = rec.requests[0]["path"]
    sent_path, _, sent_query = sent.partition("?")
    assert (rec.requests[0]["method"], sent_path) == (method, path)
    assert sent_query == query, f"{method} {path}: wrong query string"


def test_unset_query_filters_are_omitted_entirely(edge) -> None:
    """Every optional field on the edge's query structs is `#[serde(default)]`.
    Sending `limit=None` would be a parse failure, not a default — so an unset
    filter must not appear at all."""
    client, rec = edge
    rec.responses = [(200, {"entities": [], "count": 0}, {})]
    client.list_entities(prefix="Ada")
    assert rec.requests[0]["path"] == "/v1/entities?prefix=Ada"


def test_a_query_with_no_filters_at_all_sends_no_question_mark(edge) -> None:
    client, rec = edge
    rec.responses = [(200, {"nodes": [], "edges": []}, {})]
    client.graph_fetch()
    assert rec.requests[0]["path"] == "/v1/graph", "a bare `?` is not a valid default"


def test_query_values_are_percent_encoded(edge) -> None:
    client, rec = edge
    rec.responses = [(200, {"entities": [], "count": 0}, {})]
    client.list_entities(prefix="Ada L&C=1")
    assert rec.requests[0]["path"] == "/v1/entities?prefix=Ada+L%26C%3D1", (
        "an unescaped & would split one filter into two"
    )


def test_a_path_id_cannot_escape_its_segment(edge) -> None:
    """A slash in an id must not re-route the request. `/v1/entities/a/b` is a
    different route (`/v1/entities/{id}/relations` lives at that depth)."""
    client, rec = edge
    rec.responses = [(200, {}, {})]
    with contextlib.suppress(KeyError, TypeError):
        client.get_entity("a/b")
    assert rec.requests[0]["path"] == "/v1/entities/a%2Fb"


# --- request bodies --------------------------------------------------------


def test_create_entity_sends_the_contract_body(edge) -> None:
    client, rec = edge
    rec.responses = [(200, {"entity_id": "ent-9"}, {})]
    out = client.create_entity(3, "Ada Lovelace", aliases=["Ada"])
    assert rec.requests[0]["body"] == {
        "entity_type_id": 3,
        "canonical_name": "Ada Lovelace",
        "aliases": ["Ada"],
    }
    assert out.entity_id == "ent-9"


def test_optional_body_fields_are_dropped_not_nulled(edge) -> None:
    """`aliases` is `#[serde(default)]` on the edge. Omitting it takes the
    default; sending `null` for a `Vec<String>` is a 422."""
    client, rec = edge
    rec.responses = [(200, {"entity_id": "ent-9"}, {})]
    client.create_entity(3, "Ada Lovelace")
    assert rec.requests[0]["body"] == {"entity_type_id": 3, "canonical_name": "Ada Lovelace"}


def test_replace_schema_always_states_force_drop_existing(edge) -> None:
    """`force_drop_existing` has no serde default on the edge — it is a required
    bool, so it rides every request rather than being compacted away."""
    client, rec = edge
    rec.responses = [(200, {}, {})]
    with contextlib.suppress(KeyError, TypeError):
        client.replace_schema("entity Person {}")
    assert rec.requests[0]["body"] == {
        "schema_document": "entity Person {}",
        "force_drop_existing": False,
    }


# --- idempotency of the new routes -----------------------------------------


def test_schema_validate_is_retried_despite_being_a_post(edge) -> None:
    """A dry run changes nothing on the edge, so a 503 mid-validate is safe to
    replay. It is the only POST on the surface that is."""
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (200, {"namespace": "app", "would_be_version": 4, "validation_errors": []}, {}),
    ]
    out = client.validate_schema("entity Person {}")
    assert len(rec.requests) == 2
    assert out.would_be_version == 4


def test_replace_schema_is_never_retried(edge) -> None:
    """The destructive route. A replace that looks like it failed may have
    landed, and replaying it drops data a second time against a graph that has
    already moved."""
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (200, {}, {}),
    ]
    with pytest.raises(BrainHttpError):
        client.replace_schema("entity Person {}", force_drop_existing=True)
    assert len(rec.requests) == 1, "PUT /v1/schema must run exactly once"


def test_schema_upload_is_never_retried(edge) -> None:
    """A retried upload mints a second schema version."""
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (200, {}, {}),
    ]
    with pytest.raises(BrainHttpError):
        client.upload_schema("entity Person {}")
    assert len(rec.requests) == 1


def test_a_read_side_get_is_retried(edge) -> None:
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (200, {"entities": [], "count": 0}, {}),
    ]
    client.list_entities()
    assert len(rec.requests) == 2


# --- response shapes -------------------------------------------------------


def test_traversal_step_carries_the_reserved_from_key(edge) -> None:
    """`from` is a Python keyword, so `TraversalStep.from_` is the one field on
    the HTTP contract not spelled literally. The mapping has to be right or the
    hop's origin is silently lost."""
    client, rec = edge
    rec.responses = [
        (
            200,
            {
                "paths": [
                    {
                        "steps": [
                            {
                                "relation_id": "rel-1",
                                "from": "ent-1",
                                "to": "ent-2",
                                "relation_type": "knows",
                                "depth": 1,
                            }
                        ]
                    }
                ],
                "total_paths": 1,
                "truncated": False,
            },
            {},
        )
    ]
    out = client.traverse_relations("ent-1")
    step = out.paths[0].steps[0]
    assert (step.from_, step.to) == ("ent-1", "ent-2")
    assert out.total_paths == 1 and out.truncated is False


def test_an_absent_next_cursor_is_none_not_a_key_error(edge) -> None:
    """`next_cursor` is `skip_serializing_if = Option::is_none`, so the last page
    omits the key rather than sending null."""
    client, rec = edge
    rec.responses = [(200, {"nodes": [], "edges": []}, {})]
    assert client.graph_fetch().next_cursor is None


def test_memory_inspect_tolerates_a_stage_artifact_with_no_record_or_graph(edge) -> None:
    """`record` and `graph` are `Option` on the edge — an artifact captured
    before those stages ran has neither."""
    client, rec = edge
    rec.responses = [
        (
            200,
            {
                "found": True,
                "memory_id": "mem-1",
                "text": "the sky is teal",
                "artifact": {
                    "vector": [0.5, 0.25],
                    "record": None,
                    "hype_questions": ["what colour?"],
                    "keyword_fields": [{"field": "body", "terms": ["sky", "teal"]}],
                    "graph": None,
                },
            },
            {},
        )
    ]
    out = client.memory_inspect("mem-1")
    assert out.found is True
    assert out.artifact.record is None and out.artifact.graph is None
    assert out.artifact.keyword_fields[0].terms == ["sky", "teal"]


def _statement_with(obj: dict) -> dict:
    return {
        "statement_id": "stmt-1",
        "kind": "fact",
        "subject": "ent-1",
        "predicate": "born_in",
        "object": obj,
        "confidence": 0.9,
        "event_at_unix_nanos": 1,
        "valid_from_unix_nanos": 2,
        "valid_to_unix_nanos": 3,
        "tombstoned": False,
    }


def test_a_literal_statement_object_is_decoded_through_both_tags(edge) -> None:
    """`StatementObjectDto` and `StatementValueDto` are internally tagged, and on
    different keys — `kind` for the outer, `type` for the inner. Reading either
    tag off the wrong key collapses every literal to the same value."""
    client, rec = edge
    rec.responses = [
        (
            200,
            {
                "statements": [
                    _statement_with({"kind": "value", "value": {"type": "integer", "value": 1815}})
                ],
                "count": 1,
            },
            {},
        )
    ]
    out = client.list_statements()
    assert out.count == 1
    obj = out.statements[0].object
    assert obj.kind == "value"
    assert obj.id is None, "the literal variant carries no id"
    assert (obj.value.type, obj.value.value) == ("integer", 1815)


@pytest.mark.parametrize("kind", ["entity", "memory", "statement"])
def test_a_reference_statement_object_carries_an_id_and_no_value(edge, kind) -> None:
    """The three reference variants are flat: the tag and the id sit in one
    object, with no nested `value` key at all."""
    client, rec = edge
    rec.responses = [
        (200, {"statements": [_statement_with({"kind": kind, "id": "ent-7"})], "count": 1}, {})
    ]
    obj = client.list_statements().statements[0].object
    assert (obj.kind, obj.id) == (kind, "ent-7")
    assert obj.value is None


@pytest.mark.parametrize(
    ("type_tag", "raw"),
    [
        ("text", "Ada"),
        ("integer", 1815),
        ("float", 0.5),
        ("bool", True),
        ("unix_nanos", 1_700_000_000_000_000_000),
        ("blob", [1, 2, 3]),
    ],
)
def test_every_statement_value_tag_round_trips(edge, type_tag, raw) -> None:
    """All six literal types the edge can emit. `unix_nanos` is the one whose
    snake_case spelling does not fall out of lowercasing the Rust variant
    (`UnixNanos`), so it is the one most likely to be transcribed wrong."""
    client, rec = edge
    assert type_tag in StatementValue.TYPES, "tag must be one the contract declares"
    rec.responses = [
        (
            200,
            {
                "statements": [
                    _statement_with({"kind": "value", "value": {"type": type_tag, "value": raw}})
                ],
                "count": 1,
            },
            {},
        )
    ]
    value = client.list_statements().statements[0].object.value
    assert (value.type, value.value) == (type_tag, raw)


def test_the_declared_tag_sets_match_the_contract() -> None:
    """The closed sets are transcribed from the manifest's enum variants; if the
    edge adds one, this is where the SDK notices."""
    assert StatementObject.KINDS == ("entity", "value", "memory", "statement")
    assert StatementValue.TYPES == (
        "text",
        "integer",
        "float",
        "bool",
        "unix_nanos",
        "blob",
    )


def _minimal_body_for(path: str) -> dict:
    if path == "/v1/recall":
        return {"answer_kind": "none", "memories": []}
    if path == "/v1/memories":
        return {"memory_id": "1", "was_already_forgotten": False, "edges_removed": 0}
    if path == "/v1/links":
        return {
            "source": "1",
            "target": "2",
            "kind": "caused",
            "weight": 1.0,
            "created_at_unix_nanos": 0,
            "already_existed": False,
            "removed": True,
        }
    if path == "/v1/whoami":
        return {
            "namespace": "ns",
            "space_id": "s",
            "permissions": {
                "can_encode": True,
                "can_recall": True,
                "can_plan": True,
                "can_reason": True,
                "can_forget": True,
                "can_admin": False,
            },
        }
    return {}


# --- error mapping ---------------------------------------------------------


def test_error_body_becomes_a_structured_error(edge) -> None:
    client, rec = edge
    rec.responses = [(404, {"error": {"code": "not_found", "message": "no such memory"}}, {})]
    with pytest.raises(BrainHttpError) as excinfo:
        client.forget("999")

    err = excinfo.value
    assert err.status == 404
    assert err.code == "not_found"
    assert err.message == "no such memory"


def test_a_non_json_error_body_still_yields_an_error(edge) -> None:
    """An edge behind a proxy can return HTML; the client must not die parsing it."""
    client, rec = edge
    rec.responses = [(502, "<html>Bad Gateway</html>", {})]
    with pytest.raises(BrainHttpError) as excinfo:
        client.whoami()
    assert excinfo.value.status == 502
    assert excinfo.value.code == "http_error", "falls back rather than raising a parse error"


def test_transport_failure_is_a_brain_error_not_a_raw_socket_error(edge) -> None:
    """A caller catching BrainHttpError must not also have to catch OSError."""
    _client, _rec = edge
    dead = BrainHttpClient(API_KEY, "http://127.0.0.1:1", retry=HttpRetryPolicy(max_attempts=1))
    with pytest.raises(BrainHttpError) as excinfo:
        dead.whoami()
    assert excinfo.value.status == 0
    assert excinfo.value.code == "transport"


# --- retry -----------------------------------------------------------------


def test_an_idempotent_verb_retries_a_503_and_succeeds(edge) -> None:
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (
            200,
            {
                "namespace": "ns",
                "space_id": "s",
                "permissions": {
                    "can_encode": True,
                    "can_recall": True,
                    "can_plan": True,
                    "can_reason": True,
                    "can_forget": True,
                    "can_admin": False,
                },
            },
            {},
        ),
    ]
    client.whoami()
    assert len(rec.requests) == 2, "a 503 on an idempotent GET must be retried"


def test_a_non_idempotent_verb_is_never_retried(edge) -> None:
    """The whole point of the idempotent flag. RECALL is a POST, and retrying a
    non-idempotent verb after a 503 risks applying it twice."""
    client, rec = edge
    rec.responses = [
        (503, {"error": {"code": "unavailable", "message": "shard restarting"}}, {}),
        (200, {"answer_kind": "none", "memories": []}, {}),
    ]
    with pytest.raises(BrainHttpError):
        client.recall("anything")
    assert len(rec.requests) == 1, "a non-idempotent verb must run exactly once"


def test_retry_gives_up_after_max_attempts(edge) -> None:
    client, rec = edge
    rec.responses = [(503, {"error": {"code": "unavailable", "message": "no"}}, {})] * 5
    with pytest.raises(BrainHttpError) as excinfo:
        client.whoami()
    assert excinfo.value.status == 503
    assert len(rec.requests) == 3, "max_attempts=3 means three requests, not three retries"


def test_a_4xx_is_not_retried(edge) -> None:
    """Retrying a client error just multiplies it — the request will not become
    valid on a second attempt."""
    client, rec = edge
    rec.responses = [(401, {"error": {"code": "unauthorized", "message": "bad key"}}, {})] * 3
    with pytest.raises(BrainHttpError) as excinfo:
        client.whoami()
    assert excinfo.value.status == 401
    assert len(rec.requests) == 1


def test_a_server_retry_after_overrides_the_computed_backoff() -> None:
    """Asserted on the policy directly: driving it through a real sleep would
    make the suite slow and flaky for no extra signal."""
    policy = HttpRetryPolicy(max_attempts=5, base_delay=1.0, max_delay=30.0)
    assert policy.backoff(1, None) == 1.0
    assert policy.backoff(2, None) == 2.0, "exponential without a server hint"
    assert policy.backoff(1, 7.0) == 7.0, "a Retry-After hint wins"
    assert policy.backoff(1, 900.0) == 30.0, "but is still capped by max_delay"
