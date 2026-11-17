//! BYOK credential contract.
//!
//! The wire codes, retry classification and secret redaction are a
//! cross-SDK contract. These tests keep the Rust surface aligned with the
//! Python and TypeScript SDKs, where a missing key must stop immediately while
//! a transient credential-resolution failure may be retried.

use brain_db_sdk::wire::types::{
    ErrorCategoryWire, ErrorCodeWire, ErrorResponse, LlmCredentialPutRequest,
};
use brain_db_sdk::BrainError;

fn server_error(code: ErrorCodeWire, category: ErrorCategoryWire) -> BrainError {
    BrainError::from_server(ErrorResponse {
        code,
        category,
        message: "test".into(),
        details: None,
        retry_after_ms: None,
    })
}

#[test]
fn wire_codes_match_the_contract() {
    // The numeric block assigns the category, so moving one silently changes
    // whether clients retry it.
    assert_eq!(ErrorCodeWire::LlmCredentialMissing as u16, 0x0066);
    assert_eq!(ErrorCodeWire::LlmCredentialUnavailable as u16, 0x0095);
}

#[test]
fn missing_is_terminal_and_unavailable_is_retryable() {
    let missing = server_error(
        ErrorCodeWire::LlmCredentialMissing,
        ErrorCategoryWire::Conflict,
    );
    assert!(missing.is_llm_credential_missing());
    assert!(!missing.is_llm_credential_unavailable());
    assert!(!missing.is_retryable());

    let unavailable = server_error(
        ErrorCodeWire::LlmCredentialUnavailable,
        ErrorCategoryWire::Unavailable,
    );
    assert!(unavailable.is_llm_credential_unavailable());
    assert!(!unavailable.is_llm_credential_missing());
    assert!(unavailable.is_retryable());
}

#[test]
fn unrelated_errors_do_not_match_credential_predicates() {
    let err = server_error(ErrorCodeWire::ActAsDenied, ErrorCategoryWire::Authorization);
    assert!(!err.is_llm_credential_missing());
    assert!(!err.is_llm_credential_unavailable());
}

#[test]
fn wire_put_request_debug_redacts_the_provider_key() {
    let key = "sk-live-DO-NOT-LOG";
    let request = LlmCredentialPutRequest {
        provider: "openai".into(),
        model: "gpt-4o".into(),
        api_key: key.into(),
        request_id: [0; 16],
        act_as: None,
    };

    let shown = format!("{request:?}");
    assert!(!shown.contains(key));
    assert!(shown.contains("openai"));
}
