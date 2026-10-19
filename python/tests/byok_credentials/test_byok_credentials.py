"""BYOK credential error contract.

The wire codes and their retry classification are a cross-SDK contract: all
three SDKs must agree, and the classification is what decides whether a client
hammers an endpoint that can never succeed. These tests pin it on the Python
side; `rust/src/wire/types.rs` and `typescript/test/byok-credentials.test.ts`
pin the same facts.
"""

from brain_db_sdk.errors import (
    LlmCredentialMissing,
    LlmCredentialUnavailable,
    ServerError,
    is_retryable,
)
from brain_db_sdk.http.retry import HttpRetryPolicy
from brain_db_sdk.wire.types import ErrorCategory, ErrorCode, ErrorResponse


def _err(code: int, category: int) -> ServerError:
    return ServerError.from_response(
        ErrorResponse(
            code=code,
            category=category,
            message="test",
            details=None,
            retry_after_ms=None,
        )
    )


def test_wire_codes_match_the_contract() -> None:
    # The numeric block assigns the category, so moving one silently changes
    # whether clients retry it.
    assert ErrorCode.LLM_CREDENTIAL_MISSING == 0x0066
    assert ErrorCode.LLM_CREDENTIAL_UNAVAILABLE == 0x0095


def test_missing_credential_maps_to_its_own_exception() -> None:
    exc = _err(ErrorCode.LLM_CREDENTIAL_MISSING, ErrorCategory.CONFLICT)
    assert isinstance(exc, LlmCredentialMissing)


def test_unavailable_credential_maps_to_its_own_exception() -> None:
    exc = _err(ErrorCode.LLM_CREDENTIAL_UNAVAILABLE, ErrorCategory.UNAVAILABLE)
    assert isinstance(exc, LlmCredentialUnavailable)


def test_missing_is_terminal_and_unavailable_is_retryable() -> None:
    # The whole reason the two codes exist separately. Collapsing them either
    # retries a condition that cannot self-heal, or permanently fails a write
    # whose tenant has a perfectly good key.
    missing = _err(ErrorCode.LLM_CREDENTIAL_MISSING, ErrorCategory.CONFLICT)
    unavailable = _err(ErrorCode.LLM_CREDENTIAL_UNAVAILABLE, ErrorCategory.UNAVAILABLE)
    assert not is_retryable(missing), "a missing provider key will not appear on retry"
    assert is_retryable(unavailable), "a broker blip must be retried"


def test_http_status_choice_is_not_retryable() -> None:
    # `llm_credential.missing` maps to HTTP 409 at the edge, deliberately NOT
    # 503: the retry list is (0, 503), so a 503 would make every client retry
    # forever against a tenant that has not registered a key.
    assert not HttpRetryPolicy.is_retryable_status(409)
    assert HttpRetryPolicy.is_retryable_status(503)
