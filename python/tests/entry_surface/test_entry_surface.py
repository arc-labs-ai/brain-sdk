"""What the package entry actually hands a consumer.

`LlmCredentialMissing` and `LlmCredentialUnavailable` were defined in
`brain_db_sdk.errors`, raised by the client on a `0x0066` admission refusal,
and absent from `__init__.py` — so the one error a caller must catch to handle
"this tenant has not registered a provider key" could not be imported from the
package. Their sibling `ActAsDenied` was exported, so it was an omission
rather than a policy, and the only way to catch the thing was to reach into
`brain_db_sdk.errors` directly. Rust reaches the same capability through
`BrainError::is_llm_credential_missing`, and TypeScript exports
`isLlmCredentialMissing`; Python was the odd one out.

A unit test cannot catch that, because a unit test imports from the module
that defines the thing. This one imports from the entry a consumer imports
from, which is the only place the omission is visible.

Mirrors `typescript/test/entry-surface`.
"""

from __future__ import annotations

import pytest

import brain_db_sdk as entry
from brain_db_sdk import http as http_entry

# Spelled out rather than derived from `__all__`: deriving it would assert the
# surface equals itself, and a snapshot records whatever happened to be there.
# A list is a decision, and removing a line from it is a reviewable act.
EXPECTED_CALLABLES = [
    # Connection and client.
    "BrainClient",
    "ClientConfig",
    "Auth",
    "MuxConnection",
    "Pool",
    "Subscription",
    # Async mirror.
    "AsyncBrainClient",
    "AsyncMuxConnection",
    "AsyncPool",
    "AsyncSubscription",
    # Builders.
    "EncodeBuilder",
    "RecallBuilder",
    "ForgetBuilder",
    # Errors a caller is expected to catch.
    "BrainError",
    "BrainTimeout",
    "ConnectionClosed",
    "ProtocolError",
    "ServerError",
    "VersionMismatch",
    "ActAsDenied",
    "LlmCredentialMissing",
    "LlmCredentialUnavailable",
    # Retry.
    "RetryPolicy",
    "with_retry",
    "is_retryable",
    # Ids.
    "new_id",
    "derive_space_id",
    # HTTP tier.
    "BrainHttpClient",
    "BrainHttpError",
]


@pytest.mark.parametrize("name", EXPECTED_CALLABLES)
def test_the_entry_exports_it(name: str) -> None:
    assert hasattr(entry, name), f"{name} is not reachable from the package entry"
    assert callable(getattr(entry, name)), f"{name} is exported but not callable"


@pytest.mark.parametrize("name", EXPECTED_CALLABLES)
def test_the_entry_advertises_it(name: str) -> None:
    # Reachable as an attribute is not the same as advertised: `__all__` is
    # what `from brain_db_sdk import *` and most tooling read.
    assert name in entry.__all__, f"{name} is reachable but missing from __all__"


def test_the_credential_errors_are_the_ones_the_client_raises() -> None:
    # Exported and wired, not merely present: a name re-bound to something
    # else would still pass the checks above.
    from brain_db_sdk import errors

    assert entry.LlmCredentialMissing is errors.LlmCredentialMissing
    assert entry.LlmCredentialUnavailable is errors.LlmCredentialUnavailable
    # Both are catchable as the base error, which is how a caller that does
    # not care about the distinction writes the handler.
    assert issubclass(entry.LlmCredentialMissing, entry.ServerError)
    assert issubclass(entry.LlmCredentialUnavailable, entry.ServerError)


def test_the_retry_combinator_is_exported_not_just_its_parts() -> None:
    # The TypeScript regression this mirrors: `is_retryable` was reachable and
    # `with_retry`, the thing that composes it, was not.
    assert callable(entry.with_retry)
    assert callable(entry.is_retryable)
    assert entry.RetryPolicy().max_attempts >= 1


def test_it_retries_through_the_exported_combinator() -> None:
    # Proves the binding is wired, not merely present: a re-export pointing at
    # the wrong module would still be callable.
    calls = {"n": 0}

    def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("socket died")
        return "ok"

    policy = entry.RetryPolicy(max_attempts=3, base_delay=0.0, max_delay=0.0)
    assert entry.with_retry(flaky, policy) == "ok"
    assert calls["n"] == 3


def test_it_gives_up_on_a_non_retryable_error_without_rerunning() -> None:
    calls = {"n": 0}

    def broken() -> str:
        calls["n"] += 1
        raise TypeError("a bug, not a blip")

    with pytest.raises(TypeError):
        entry.with_retry(broken, entry.RetryPolicy(max_attempts=3, base_delay=0.0))
    assert calls["n"] == 1


def test_both_entries_serve_the_same_http_client() -> None:
    assert entry.BrainHttpClient is http_entry.BrainHttpClient
    assert entry.BrainHttpError is http_entry.BrainHttpError
