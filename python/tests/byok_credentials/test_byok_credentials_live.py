"""Live BYOK credential round-trips over the sync and asyncio wire clients.

 Gated on ``BRAIN_SDK_IT_DATA`` and ``BRAIN_SDK_IT_LOOPBACK=1`` via the
 ``byok_it`` fixture; skips unless the runner shares the engine's network
 namespace. Each
cycle uses a throwaway namespace because deleting a sealed credential from the
shared integration namespace cannot be undone.
"""

from __future__ import annotations

from uuid import uuid4

from brain_db_sdk import new_id
from brain_db_sdk.wire.types import (
    LlmCredentialDeleteRequest,
    LlmCredentialGetRequest,
    LlmCredentialPutRequest,
    LlmCredentialVerifyRequest,
    VerifyOutcome,
)

FAKE_KEY = "sk-fake-DO-NOT-USE"
PROVIDER = "openai"
MODEL = "gpt-4o-mini"


def _assert_response_does_not_contain_key(response: object) -> None:
    # The sealed store's security property is that no credential operation
    # response can reconstruct or leak the plaintext provider key.
    assert FAKE_KEY not in repr(response)


def _namespace() -> str:
    return f"sdk-it-byok-{uuid4().hex}"


def test_sync_llm_credential_round_trip(byok_it) -> None:
    # PUT carries plaintext, so this integration target must remain loopback:
    # the server permits that path only over TLS, mTLS, or loopback.
    client = byok_it.connect_as(new_id(), namespace=_namespace())
    try:
        absent = client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(absent)
        assert absent.credential is None

        put = client.put_llm_credential(
            LlmCredentialPutRequest(PROVIDER, MODEL, FAKE_KEY, new_id())
        )
        _assert_response_does_not_contain_key(put)
        assert put.provider == PROVIDER
        assert put.model == MODEL
        assert put.fingerprint == f"…{FAKE_KEY[-4:]}"
        assert put.fingerprint != FAKE_KEY
        assert len(put.fingerprint) < len(FAKE_KEY)

        installed = client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(installed)
        assert installed.credential is not None
        assert installed.credential.provider == PROVIDER
        assert installed.credential.model == MODEL
        assert installed.credential.fingerprint == put.fingerprint
        assert installed.credential.fingerprint == f"…{FAKE_KEY[-4:]}"
        assert installed.credential.fingerprint != FAKE_KEY
        assert len(installed.credential.fingerprint) < len(FAKE_KEY)

        verified = client.verify_llm_credential(LlmCredentialVerifyRequest(new_id()))
        _assert_response_does_not_contain_key(verified)
        assert verified.outcome
        assert verified.outcome != VerifyOutcome.OK

        deleted = client.delete_llm_credential(LlmCredentialDeleteRequest(new_id()))
        _assert_response_does_not_contain_key(deleted)
        assert deleted.existed is True

        deleted_again = client.delete_llm_credential(LlmCredentialDeleteRequest(new_id()))
        _assert_response_does_not_contain_key(deleted_again)
        assert deleted_again.existed is False

        absent_again = client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(absent_again)
        assert absent_again.credential is None
    finally:
        client.close()


async def test_async_llm_credential_round_trip(byok_it) -> None:
    # PUT carries plaintext, so this integration target must remain loopback:
    # the server permits that path only over TLS, mTLS, or loopback.
    client = await byok_it.connect_as_async(new_id(), namespace=_namespace())
    async with client:
        absent = await client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(absent)
        assert absent.credential is None

        put = await client.put_llm_credential(
            LlmCredentialPutRequest(PROVIDER, MODEL, FAKE_KEY, new_id())
        )
        _assert_response_does_not_contain_key(put)
        assert put.provider == PROVIDER
        assert put.model == MODEL
        assert put.fingerprint == f"…{FAKE_KEY[-4:]}"
        assert put.fingerprint != FAKE_KEY
        assert len(put.fingerprint) < len(FAKE_KEY)

        installed = await client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(installed)
        assert installed.credential is not None
        assert installed.credential.provider == PROVIDER
        assert installed.credential.model == MODEL
        assert installed.credential.fingerprint == put.fingerprint
        assert installed.credential.fingerprint == f"…{FAKE_KEY[-4:]}"
        assert installed.credential.fingerprint != FAKE_KEY
        assert len(installed.credential.fingerprint) < len(FAKE_KEY)

        verified = await client.verify_llm_credential(LlmCredentialVerifyRequest(new_id()))
        _assert_response_does_not_contain_key(verified)
        assert verified.outcome
        assert verified.outcome != VerifyOutcome.OK

        deleted = await client.delete_llm_credential(LlmCredentialDeleteRequest(new_id()))
        _assert_response_does_not_contain_key(deleted)
        assert deleted.existed is True

        deleted_again = await client.delete_llm_credential(LlmCredentialDeleteRequest(new_id()))
        _assert_response_does_not_contain_key(deleted_again)
        assert deleted_again.existed is False

        absent_again = await client.get_llm_credential(LlmCredentialGetRequest())
        _assert_response_does_not_contain_key(absent_again)
        assert absent_again.credential is None
