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

// ---------------------------------------------------------------------------
// Exhaustive sweeps. The predicates are cheap and the spaces are small, so
// there is no reason to sample.
// ---------------------------------------------------------------------------

#[test]
fn across_the_whole_16_bit_code_space_exactly_three_codes_match() {
    // `from_raw` is total by contract — an unknown code maps to `Unknown`
    // rather than failing — so every one of the 65_536 possible wire values is
    // a legal input here. Sweeping all of them is the only way to be sure a
    // predicate answers for exactly its own code and nothing else, including
    // codes a future server adds that this build maps to `Unknown`.
    let mut matched: Vec<(u16, &str)> = Vec::new();
    for raw in 0..=u16::MAX {
        let err = server_error(ErrorCodeWire::from_raw(raw), ErrorCategoryWire::Internal);
        if err.is_act_as_denied() {
            matched.push((raw, "act_as_denied"));
        }
        if err.is_llm_credential_missing() {
            matched.push((raw, "llm_credential_missing"));
        }
        if err.is_llm_credential_unavailable() {
            matched.push((raw, "llm_credential_unavailable"));
        }
    }
    // The hex values are spelled out because they are the wire contract, and
    // Python and TypeScript hard-code the same three numbers. A renumbering
    // that slipped through would make three SDKs disagree about which failure
    // a caller is looking at.
    assert_eq!(
        matched,
        vec![
            (0x0033, "act_as_denied"),
            (0x0066, "llm_credential_missing"),
            (0x0095, "llm_credential_unavailable"),
        ]
    );
}

#[test]
fn no_predicate_fires_for_any_non_server_failure() {
    // Every variant that carries no code. A predicate that reached for one
    // would panic rather than answer, and `Closed` alone would not have caught
    // an implementation that matched on, say, `Io` by accident.
    let failures = vec![
        BrainError::Io(std::io::Error::other("x")),
        BrainError::Protocol("x".into()),
        BrainError::Closed,
        BrainError::Timeout(std::time::Duration::from_secs(1)),
        BrainError::VersionMismatch {
            chosen: 9,
            supported: vec![1],
        },
    ];
    for err in failures {
        assert!(!err.is_act_as_denied(), "{err:?}");
        assert!(!err.is_llm_credential_missing(), "{err:?}");
        assert!(!err.is_llm_credential_unavailable(), "{err:?}");
    }
}

#[test]
fn a_predicate_ignores_the_category_and_answers_on_the_code_alone() {
    // The code identifies the failure; the category only says how to react. A
    // server that sends a surprising pairing must not make the predicate lie,
    // because that is exactly when a caller needs to know which failure it is.
    let every_category = [
        ErrorCategoryWire::Protocol,
        ErrorCategoryWire::Authentication,
        ErrorCategoryWire::Authorization,
        ErrorCategoryWire::Validation,
        ErrorCategoryWire::NotFound,
        ErrorCategoryWire::Conflict,
        ErrorCategoryWire::ResourceExhausted,
        ErrorCategoryWire::Internal,
        ErrorCategoryWire::Unavailable,
    ];
    for category in every_category {
        assert!(
            server_error(ErrorCodeWire::ActAsDenied, category).is_act_as_denied(),
            "{category:?}"
        );
        assert!(
            server_error(ErrorCodeWire::LlmCredentialMissing, category).is_llm_credential_missing(),
            "{category:?}"
        );
    }
}

#[test]
fn an_unknown_code_claims_nothing() {
    // A newer server's code decodes to `Unknown`. The caller must fall back to
    // the category rather than be told it is one of these three.
    let err = server_error(ErrorCodeWire::Unknown, ErrorCategoryWire::Internal);
    assert!(!err.is_act_as_denied());
    assert!(!err.is_llm_credential_missing());
    assert!(!err.is_llm_credential_unavailable());
}
