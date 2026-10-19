"""Opt-in integration tests against a running Brain HTTP edge.

Set ``BRAIN_SDK_IT_HTTP`` and ``BRAIN_SDK_IT_HTTP_KEY`` to run these tests.
Use ``BRAIN_SDK_IT_REQUIRED=1`` in CI so missing configuration is a failure.
"""

from __future__ import annotations

import os
from uuid import uuid4

import pytest

from brain_db_sdk.http import BrainHttpClient, HttpRetryPolicy


def _client() -> BrainHttpClient:
    base_url = os.environ.get("BRAIN_SDK_IT_HTTP")
    api_key = os.environ.get("BRAIN_SDK_IT_HTTP_KEY") or os.environ.get("BRAIN_SDK_IT_API_KEY")
    if not base_url or not api_key:
        message = (
            "live edge tests require BRAIN_SDK_IT_HTTP and "
            "BRAIN_SDK_IT_HTTP_KEY (or BRAIN_SDK_IT_API_KEY)"
        )
        if os.environ.get("BRAIN_SDK_IT_REQUIRED") == "1":
            pytest.fail(message)
        pytest.skip(message)
    # Live suites run against a rate-limited plan, so the client is patient:
    # the Free ceiling is 60 requests/minute and the server answers 429 with
    # ``Retry-After``, which the default policy clamps to 2s — far short of a
    # 60s window. Raising the cap past the window turns throttling into a
    # pause instead of a failure.
    return BrainHttpClient(
        api_key,
        base_url,
        retry=HttpRetryPolicy(max_attempts=4, base_delay=0.5, max_delay=70.0),
    )


def test_edge_identity_and_capabilities() -> None:
    client = _client()
    identity = client.whoami()
    capabilities = client.capabilities()

    assert identity.namespace
    assert identity.space_id
    assert capabilities.vector_dim > 0
    assert isinstance(capabilities.schema_namespaces, list)


def test_edge_memory_lifecycle() -> None:
    client = _client()
    text = f"brain-sdk live edge integration {uuid4()}"
    encoded = client.encode(text)

    assert encoded.memory_id
    try:
        recalled = client.recall(text, max_results=5)
        assert isinstance(recalled.memories, list)

        page = client.memory_list(limit=100)
        assert any(item.memory_id == encoded.memory_id for item in page.items)
    finally:
        forgotten = client.forget(encoded.memory_id)
        assert forgotten.memory_id == encoded.memory_id
