//! Branching on the three server codes a caller has to treat differently.
//!
//! All three SDKs decode these codes; until now only two let a caller act on
//! them. Python raises a `ServerError` subclass per code (`ActAsDenied`,
//! `LlmCredentialMissing`, `LlmCredentialUnavailable`) and TypeScript ships
//! `isActAsDenied` / `isLlmCredentialMissing` / `isLlmCredentialUnavailable`.
//! A Rust caller had to match `BrainError::Server` and compare a raw
//! `ErrorCodeWire` by hand — the information was there, the ergonomics were
//! not, and the asymmetry was invisible to every parity gate because none of
//! them looks at the error taxonomy.
//!
//! The pair that matters most is missing-vs-unavailable. Collapsing them
//! either hammers an endpoint that can never succeed, or permanently fails a
//! write whose tenant has a perfectly good key — so these assert that each
//! predicate answers for exactly one code, and that retryability splits the
//! way the two cases demand.

use brain_db_sdk::wire::types::{ErrorCategoryWire, ErrorCodeWire, ErrorResponse};
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
fn each_predicate_answers_for_exactly_one_code() {
    let cases = [
        (ErrorCodeWire::ActAsDenied, [true, false, false]),
        (ErrorCodeWire::LlmCredentialMissing, [false, true, false]),
        (
            ErrorCodeWire::LlmCredentialUnavailable,
            [false, false, true],
        ),
        // A code none of the three claims.
        (ErrorCodeWire::Internal, [false, false, false]),
    ];
    for (code, want) in cases {
        let err = server_error(code, ErrorCategoryWire::Internal);
        let got = [
            err.is_act_as_denied(),
            err.is_llm_credential_missing(),
            err.is_llm_credential_unavailable(),
        ];
        assert_eq!(got, want, "predicates disagree for {code:?}");
    }
}

#[test]
fn a_non_server_failure_claims_none_of_them() {
    // The predicates must not fire on a local failure. `Closed` carries no
    // code at all, so a naive implementation that unwrapped one would panic
    // here rather than answer false.
    let err = BrainError::Closed;
    assert!(!err.is_act_as_denied());
    assert!(!err.is_llm_credential_missing());
    assert!(!err.is_llm_credential_unavailable());
}

#[test]
fn missing_is_terminal_and_unavailable_is_retryable() {
    // The whole reason the two codes are separate. The category drives
    // `is_retryable`, so this pins that the server's categorisation and these
    // predicates tell the same story.
    let missing = server_error(
        ErrorCodeWire::LlmCredentialMissing,
        ErrorCategoryWire::Conflict,
    );
    assert!(missing.is_llm_credential_missing());
    assert!(
        !missing.is_retryable(),
        "a namespace with no key cannot be fixed by retrying"
    );

    let unavailable = server_error(
        ErrorCodeWire::LlmCredentialUnavailable,
        ErrorCategoryWire::Unavailable,
    );
    assert!(unavailable.is_llm_credential_unavailable());
    assert!(
        unavailable.is_retryable(),
        "a broker blip must not permanently fail a tenant that has a key"
    );
}

#[test]
fn act_as_denial_is_never_retryable() {
    // The fix is a differently-scoped credential, not a repeat.
    let err = server_error(ErrorCodeWire::ActAsDenied, ErrorCategoryWire::Authorization);
    assert!(err.is_act_as_denied());
    assert!(!err.is_retryable());
}
