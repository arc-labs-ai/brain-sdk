"""Constructor validation and the failure taxonomy, at the edges.

Two things are pinned here.

**base_url / api_key acceptance.** The exact table the Rust SDK's `try_new`
suite asserts, so a change on either side that moves one verdict shows up as a
failing test rather than as three SDKs quietly disagreeing. Rust had no
validation at all until it grew `try_new`, and matching Python was the point;
the cases that actually differed were leading whitespace (``urlparse`` strips
it) and the message for a malformed scheme.

**Every failure is a BrainHttpError.** ``_request_once``'s own comment claimed
"never a native raise", and one path broke it: ``http.client`` raises a bare
``ValueError`` for a header value containing CR or LF, which is not an
``OSError`` and so slipped past every arm. An api_key read from an env file
with a trailing newline is the ordinary way in, and a caller doing
``except BrainHttpError`` got an unhandled crash instead.
"""

import socket
import threading

import pytest

from brain_db_sdk.http.client import BrainHttpClient
from brain_db_sdk.http.errors import BrainHttpError

ACCEPTED_BASE_URLS = [
    "https://edge.example",
    "http://127.0.0.1:8080",
    "HTTPS://edge.example",  # scheme compare is case-insensitive
    "HtTpS://edge.example",
    "https://edge.example/",  # trailing slash trimmed, not rejected
    "https://edge.example///",
    "https://",  # scheme present, host absent: useless but well-formed
    "https:///",
    "https://edge.example/path://x",  # only the FIRST :// delimits the scheme
    " https://edge.example",  # urlparse strips surrounding whitespace
]

REJECTED_BASE_URLS = [
    "",
    "   ",
    "://foo",  # empty scheme -> reported as "no scheme"
    "//edge.example",  # scheme-relative is not a base_url
    "edge.example",
    "httpx://edge.example",
    "file:///etc/passwd",  # the reason this check exists in Python at all
    "ftp://edge.example",
    "ws://edge.example",
    "https ://edge.example",  # a space cannot appear in a scheme -> no scheme
]


@pytest.mark.parametrize("base", ACCEPTED_BASE_URLS)
def test_these_base_urls_are_accepted(base):
    assert BrainHttpClient("brain_key", base_url=base) is not None


@pytest.mark.parametrize("base", REJECTED_BASE_URLS)
def test_these_base_urls_are_rejected_as_config(base):
    with pytest.raises(BrainHttpError) as got:
        BrainHttpClient("brain_key", base_url=base)
    assert got.value.status == 0
    assert got.value.code == "config"


def test_an_empty_api_key_is_rejected():
    # Otherwise sent as `Authorization: Bearer ` and returned as an opaque 401,
    # which reads as wrong credentials rather than absent ones.
    with pytest.raises(BrainHttpError) as got:
        BrainHttpClient("", base_url="https://edge.example")
    assert got.value.status == 0
    assert got.value.code == "config"
    assert "api_key" in got.value.message


@pytest.mark.parametrize("key", [" ", "\t", "brain_ékey", "x" * 8192])
def test_any_api_key_an_http_header_can_carry_is_accepted(key):
    # Deliberate, and matched by the other two: the check is header-legality,
    # not plausibility. A whitespace key is a server-side authentication
    # failure, not a client-side configuration one, and guessing at credential
    # formats would reject keys a future server issues. HTAB is in this list on
    # purpose - RFC 7230 permits it in a field value and all three transports
    # send it, so rejecting it would make the constructor stricter than the
    # request path it guards.
    assert BrainHttpClient(key, base_url="https://edge.example") is not None


@pytest.mark.parametrize(
    "key",
    ["evil\0key", "evil\rX: 1", "evil\nX: 1", "evil\x7fkey", "evil\x0bkey"],
)
def test_a_control_character_in_the_api_key_is_rejected(key):
    # This was the last place the three SDKs disagreed, and Python was the
    # outlier: reqwest and `fetch` refuse to build the request, so Rust and
    # TypeScript failed late but safely, while `urllib` sent a NUL straight
    # into the Authorization header where a proxy may truncate the value. CR
    # and LF were refused by `http.client`, but only at request time.
    with pytest.raises(BrainHttpError) as got:
        BrainHttpClient(key, base_url="https://edge.example")
    assert got.value.status == 0
    assert got.value.code == "config"
    assert got.value.message == "api_key must not contain control characters"
    # The message must not echo the credential, even in part.
    assert "evil" not in got.value.message


class _Server:
    """Accepts a connection, records the raw request, answers 200 {}."""

    def __init__(self):
        self.seen: list[str] = []
        self._sock = socket.socket()
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            data = conn.recv(8192)
            self.seen.append(data.decode("utf8", "replace"))
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            conn.close()

    def close(self):
        self._sock.close()


@pytest.fixture
def server():
    s = _Server()
    yield s
    s.close()


@pytest.mark.parametrize("key", ["evil\r\nX-Injected: 1", "evil\nX-Injected: 1"])
def test_a_crlf_api_key_never_reaches_the_socket(server, key):
    # Two layers, and this asserts the outer one now does the work. The
    # constructor rejects the key, so no client exists to make the request --
    # which is why this no longer goes through `whoami`.
    with pytest.raises(BrainHttpError) as got:
        BrainHttpClient(key, base_url=f"http://127.0.0.1:{server.port}")
    assert got.value.code == "config"
    # The inner layer is still there underneath: `http.client` refuses a CR/LF
    # header value, and the `ValueError` it raises is now wrapped as a
    # BrainHttpError rather than escaping (see `_request_once`). Neither layer
    # is load-bearing alone, and nothing was ever injected.
    assert server.seen == []


def test_a_bad_header_value_surfaces_as_brain_http_error_not_value_error(server):
    # Guards the inner layer directly, reaching past the constructor by
    # mutating the stored credential -- the only way to exercise the request
    # path now that construction rejects these keys. The regression this pins:
    # `http.client` raises a bare `ValueError`, which is not an `OSError` and
    # so slipped past every arm in `_request_once`, reaching the caller as a
    # stdlib exception despite the SDK's documented contract.
    client = BrainHttpClient("brain_key", base_url=f"http://127.0.0.1:{server.port}")
    client._api_key = "evil\r\nX-Injected: 1"
    with pytest.raises(BrainHttpError) as got:
        client.whoami()
    assert got.value.status == 0
    assert got.value.code == "transport"
    assert all("x-injected" not in r.lower() for r in server.seen)
