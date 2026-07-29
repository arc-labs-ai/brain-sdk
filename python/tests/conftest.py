"""Shared integration-test harness: attach to a real ``brain-server`` and mint
per-test data-plane keys.

These fixtures back the feature-folder integration suites (``tests/encode/``,
``tests/recall/`` …). They are **gated on the environment** so the default
offline ``pytest`` run (no server) still passes: when ``BRAIN_SDK_IT_DATA`` is
unset, the ``it`` fixture skips the test. Boot a server and export the vars
with ``scripts/it-server.sh up`` (see that script's header), then re-run.

Auth is mandatory and the credential is the whole identity: every test mints a
fresh ``brain_`` token bound to ``(namespace, space_id)`` via the admin plane
(``POST /v1/api-keys``) and connects with it, so isolation is real — two tests
never share an agent unless they mint the same id on purpose.
"""

from __future__ import annotations

import http.client
import json
import os
import time
from dataclasses import dataclass
from typing import Callable, Optional

import pytest

from brain_db_sdk import Auth, BrainClient, RecallAnswer, new_id
from brain_db_sdk.wire.types import RecallRequest

# How long ``recall_until`` polls before giving up. ENCODE is durable on ack,
# but the semantic index becomes searchable a beat later.
VISIBILITY_TIMEOUT_S = 5.0


@dataclass
class It:
    """A configured integration target: the data plane to speak the wire to,
    plus the admin plane used to mint keys."""

    data_host: str
    data_port: int
    admin_host: str
    admin_port: int
    admin_secret: str
    namespace: str

    @staticmethod
    def from_env() -> Optional["It"]:
        data = os.environ.get("BRAIN_SDK_IT_DATA")
        if not data:
            return None
        data_host, data_port = _split_hostport(data)
        admin = os.environ.get("BRAIN_SDK_IT_ADMIN", "127.0.0.1:19092")
        admin_host, admin_port = _split_hostport(admin)
        return It(
            data_host=data_host,
            data_port=data_port,
            admin_host=admin_host,
            admin_port=admin_port,
            admin_secret=os.environ.get("BRAIN_SDK_IT_ADMIN_SECRET", "sdk-it-admin-secret"),
            namespace=os.environ.get("BRAIN_SDK_IT_NAMESPACE", "sdk-it"),
        )

    def mint(self, space_id: bytes) -> str:
        """Mint a FULL data-plane token bound to ``(namespace, space_id)`` and
        return its secret string."""
        body = json.dumps(
            {
                "space_id_hex": space_id.hex(),
                "namespace": self.namespace,
                "permissions": ["FULL"],
            }
        )
        conn = http.client.HTTPConnection(self.admin_host, self.admin_port, timeout=10)
        try:
            conn.request(
                "POST",
                "/v1/api-keys",
                body,
                {
                    "Authorization": f"Bearer {self.admin_secret}",
                    "Content-Type": "application/json",
                },
            )
            resp = conn.getresponse()
            text = resp.read().decode()
            assert resp.status == 201, f"admin mint failed ({resp.status}): {text}"
            secret = json.loads(text).get("secret")
            assert secret, f"mint response carries no secret: {text}"
            return secret
        finally:
            conn.close()

    def connect_as(self, space_id: bytes) -> BrainClient:
        token = self.mint(space_id)
        return BrainClient.connect(self.data_host, self.data_port, Auth.token(token.encode()))

    def connect_fresh(self) -> tuple[BrainClient, bytes]:
        """Mint + connect as a brand-new random agent; returns ``(client, space_id)``."""
        agent = new_id()
        return self.connect_as(agent), agent


def _split_hostport(s: str) -> tuple[str, int]:
    host, _, port = s.rpartition(":")
    return host, int(port)


def _poll_recall(
    client: BrainClient,
    req: RecallRequest,
    pred: Callable[[RecallAnswer], bool],
    timeout_s: float = VISIBILITY_TIMEOUT_S,
) -> RecallAnswer:
    """Poll RECALL until ``pred`` holds or ``timeout_s`` elapses.

    ENCODE is durable the instant it acks, but the semantic index becomes
    *searchable* a beat later, so read-your-writes against the retrieval path
    needs a short poll — this centralizes it so a visibility lag never shows up
    as a flaky assertion.
    """
    deadline = time.monotonic() + timeout_s
    while True:
        answer = client.recall(req)
        if pred(answer) or time.monotonic() >= deadline:
            return answer
        time.sleep(0.15)


@pytest.fixture
def it() -> It:
    """The integration target, or ``pytest.skip`` when it is not configured.

    ``BRAIN_SDK_IT_REQUIRED=1`` turns the skip into a failure. A skipped
    integration suite and a passing one look nearly identical in CI output, so
    a misconfigured server would otherwise read as green; CI sets the flag
    wherever a server is supposed to be reachable, while the default keeps
    ``pytest`` working offline.
    """
    target = It.from_env()
    if target is None:
        if os.environ.get("BRAIN_SDK_IT_REQUIRED") == "1":
            pytest.fail(
                "BRAIN_SDK_IT_REQUIRED=1 but BRAIN_SDK_IT_DATA is unset — the "
                "integration server was expected to be reachable. Unset the flag to "
                "allow skipping, or boot one with scripts/it-server.sh.",
                pytrace=False,
            )
        pytest.skip("integration server not configured (set BRAIN_SDK_IT_DATA; see scripts/it-server.sh)")
    return target


@pytest.fixture
def recall_until():
    """The RECALL visibility-poll helper, injected so feature suites don't need
    a fragile cross-package import of a conftest module function."""
    return _poll_recall
