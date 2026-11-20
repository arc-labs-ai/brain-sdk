//! Live wire round-trip for namespace BYOK credential provisioning.
//!
//! This suite is gated on `BRAIN_SDK_IT_DATA` and
//! `BRAIN_SDK_IT_LOOPBACK=1`. It uses a throwaway namespace so revocation
//! cannot remove the credential required by other integration tests.

#[path = "../common/mod.rs"]
mod common;

use brain_db_sdk::new_id;
use brain_db_sdk::wire::types::{
    LlmCredentialDeleteRequest, LlmCredentialGetRequest, LlmCredentialPutRequest,
    LlmCredentialVerifyRequest, VerifyOutcome,
};

const FAKE_KEY: &str = "sk-fake-DO-NOT-USE";
const PROVIDER: &str = "openai";
const MODEL: &str = "gpt-4o-mini";

fn assert_full_key_is_absent<T: serde::Serialize>(response: &T) {
    let encoded = serde_json::to_string(response).expect("credential response serializes");
    assert!(
        !encoded.contains(FAKE_KEY),
        "credential responses must never contain the full provider key"
    );
}

#[tokio::test]
async fn credential_wire_round_trip_is_sealed_and_reversible() {
    let Some(it) = common::It::from_env() else {
        return common::skip("credential_wire_round_trip_is_sealed_and_reversible");
    };
    if !common::loopback_opted_in("credential_wire_round_trip_is_sealed_and_reversible") {
        return;
    }

    let namespace = format!("sdk-it-byok-{}", common::hex16(&new_id()));
    let (client, _space) = {
        // PUT carries a plaintext key, so the runner must share the server's
        // network namespace for the server to recognize the connection as
        // loopback.
        let space = new_id();
        (it.connect_as_in_namespace(space, &namespace).await, space)
    };

    let absent = client
        .get_llm_credential(&LlmCredentialGetRequest { act_as: None })
        .await
        .expect("get absent credential");
    assert_full_key_is_absent(&absent);
    assert!(
        absent.credential.is_none(),
        "new namespace has no credential"
    );

    let put = client
        .put_llm_credential(&LlmCredentialPutRequest {
            provider: PROVIDER.to_string(),
            model: MODEL.to_string(),
            api_key: FAKE_KEY.to_string(),
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("put credential");
    assert_full_key_is_absent(&put);
    assert_eq!(put.provider, PROVIDER);
    assert_eq!(put.model, MODEL);
    assert_eq!(
        put.fingerprint,
        format!("…{}", &FAKE_KEY[FAKE_KEY.len() - 4..]),
        "put returns the provider key's last-four display suffix"
    );
    assert_ne!(put.fingerprint, FAKE_KEY, "fingerprint is not the full key");
    assert!(
        put.fingerprint.len() < FAKE_KEY.len(),
        "fingerprint is shorter than the full key"
    );

    let got = client
        .get_llm_credential(&LlmCredentialGetRequest { act_as: None })
        .await
        .expect("get installed credential");
    assert_full_key_is_absent(&got);
    let view = got.credential.expect("credential is installed");
    assert_eq!(view.provider, PROVIDER);
    assert_eq!(view.model, MODEL);
    assert_eq!(view.fingerprint, put.fingerprint);
    assert_eq!(
        view.fingerprint,
        format!("…{}", &FAKE_KEY[FAKE_KEY.len() - 4..]),
        "get returns the provider key's last-four display suffix"
    );
    assert_ne!(
        view.fingerprint, FAKE_KEY,
        "fingerprint is not the full key"
    );
    assert!(
        view.fingerprint.len() < FAKE_KEY.len(),
        "fingerprint is shorter than the full key"
    );

    let verified = client
        .verify_llm_credential(&LlmCredentialVerifyRequest {
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("verify returns an outcome");
    assert_full_key_is_absent(&verified);
    assert_ne!(
        verified.outcome,
        VerifyOutcome::Ok,
        "the deliberately fake key must not verify successfully"
    );

    let deleted = client
        .delete_llm_credential(&LlmCredentialDeleteRequest {
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete installed credential");
    assert_full_key_is_absent(&deleted);
    assert!(deleted.existed, "first delete reports a credential existed");

    let deleted_again = client
        .delete_llm_credential(&LlmCredentialDeleteRequest {
            request_id: new_id(),
            act_as: None,
        })
        .await
        .expect("delete absent credential");
    assert_full_key_is_absent(&deleted_again);
    assert!(
        !deleted_again.existed,
        "second delete reports nothing existed"
    );

    let absent_again = client
        .get_llm_credential(&LlmCredentialGetRequest { act_as: None })
        .await
        .expect("get deleted credential");
    assert_full_key_is_absent(&absent_again);
    assert!(
        absent_again.credential.is_none(),
        "deleted credential is absent"
    );

    client.close().await.expect("close");
}
