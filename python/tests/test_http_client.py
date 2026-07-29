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

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from brain_db_sdk.http import BrainHttpClient, BrainHttpError
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

        do_GET = do_POST = do_DELETE = _handle

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
    try:
        call(client)
    except (KeyError, TypeError):
        # A minimal body may not populate every field of the result type; the
        # assertion here is about the request, not the response shape.
        pass
    assert rec.requests, f"{method} {path}: no request reached the server"
    assert (rec.requests[0]["method"], rec.requests[0]["path"]) == (method, path)


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
        return {"namespace": "ns", "space_id": "s", "permissions": {"can_encode": True, "can_recall": True, "can_plan": True, "can_reason": True, "can_forget": True, "can_admin": False}}
    return {}


# --- error mapping ---------------------------------------------------------


def test_error_body_becomes_a_structured_error(edge) -> None:
    client, rec = edge
    rec.responses = [
        (404, {"error": {"code": "not_found", "message": "no such memory"}}, {})
    ]
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
    client, _rec = edge
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
        (200, {"namespace": "ns", "space_id": "s", "permissions": {"can_encode": True, "can_recall": True, "can_plan": True, "can_reason": True, "can_forget": True, "can_admin": False}}, {}),
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
