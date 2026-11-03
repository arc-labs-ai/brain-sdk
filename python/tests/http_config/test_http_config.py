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
def test_a_non_empty_api_key_is_accepted_whatever_is_in_it(key):
    # Deliberate, and matched by the other two: the check is emptiness, not
    # plausibility. A whitespace key is a server-side authentication failure,
    # not a client-side configuration one, and guessing at credential formats
    # here would reject keys a future server issues.
    assert BrainHttpClient(key, base_url="https://edge.example") is not None


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
def test_a_crlf_api_key_fails_as_brain_http_error_and_injects_nothing(server, key):
    client = BrainHttpClient(key, base_url=f"http://127.0.0.1:{server.port}")
    # The regression: this used to escape as a stdlib ValueError, so a caller
    # catching the SDK's own error type crashed instead.
    with pytest.raises(BrainHttpError) as got:
        client.whoami()
    assert got.value.status == 0
    assert got.value.code == "transport"
    # And the security half: nothing reached the socket at all.
    assert all("x-injected" not in r.lower() for r in server.seen)
