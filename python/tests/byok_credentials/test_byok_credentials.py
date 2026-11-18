"""BYOK credential error contract.

The wire codes and their retry classification are a cross-SDK contract: all
three SDKs must agree, and the classification is what decides whether a client
hammers an endpoint that can never succeed. These tests pin it on the Python
side; `rust/src/wire/types.rs` and `typescript/test/byok-credentials.test.ts`
pin the same facts.
"""

from brain_db_sdk.client import Auth, ClientConfig
from brain_db_sdk.errors import (
    LlmCredentialMissing,
    LlmCredentialUnavailable,
    ServerError,
    is_retryable,
)
from brain_db_sdk.http.retry import HttpRetryPolicy
from brain_db_sdk.wire.types import (
    AuthCredentials,
    ErrorCategory,
    ErrorCode,
    ErrorResponse,
    HelloCapabilities,
    HelloPayload,
    LlmCredentialPutRequest,
    MtlsClaim,
)


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
    assert not HttpRetryPolicy.is_retryable(409, None)
    assert HttpRetryPolicy.is_retryable(503, None)


_SECRET_TOKEN = b"live-token-DO-NOT-LOG"


def test_credential_repr_does_not_carry_the_token() -> None:
    # `repr` reaches an error tracker on its own: pytest's --showlocals,
    # Sentry's with_locals and rich tracebacks all print every frame's locals,
    # so one exception raised while connecting would ship the token.
    creds = AuthCredentials.token(_SECRET_TOKEN)
    shown = repr(creds)
    assert str(list(_SECRET_TOKEN)) not in shown
    assert "[redacted]" in shown
    assert "Token" in shown
    # Dataclasses render through `__repr__` for `str` too, so one method
    # covers both.
    assert str(creds) == shown


def test_mtls_claim_repr_keeps_the_subject() -> None:
    claim = MtlsClaim(b"\xab" * 32, "svc/ingest")
    shown = repr(claim)
    assert repr(b"\xab" * 32) not in shown
    assert "svc/ingest" in shown


def test_auth_and_config_repr_redact_through_the_credential() -> None:
    config = ClientConfig(auth=Auth.token(_SECRET_TOKEN))
    shown = repr(config)
    assert str(list(_SECRET_TOKEN)) not in shown
    assert "[redacted]" in shown
    assert "client_id" in shown
    assert str(config) == shown


def test_hello_payload_repr_hides_the_resumption_token() -> None:
    hello = HelloPayload(
        "ingest-worker",
        [1],
        HelloCapabilities(streaming=True, compression_zstd=False, server_push=False),
        b"\xcd" * 32,
    )
    shown = repr(hello)
    assert repr(b"\xcd" * 32) not in shown
    assert "ingest-worker" in shown


def test_put_request_repr_hides_the_provider_key() -> None:
    req = LlmCredentialPutRequest("openai", "gpt-4o", "sk-live-DO-NOT-LOG", b"\x00" * 16)
    shown = repr(req)
    assert "sk-live-DO-NOT-LOG" not in shown
    assert "openai" in shown
