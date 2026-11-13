//! What the crate root actually hands a consumer.
//!
//! Everything here is reached through `brain_db_sdk::` and never through the
//! module that defines it. That distinction is the whole point: a unit test
//! imports from the defining module, so it still passes when the item is
//! missing from the root and a consumer cannot reach it.
//!
//! The omission this guards against is real and was found in the sibling SDK.
//! `LlmCredentialMissing` / `LlmCredentialUnavailable` were defined, raised by
//! the client, and absent from Python's package entry, so the one error a
//! caller must handle to react to "this tenant has no provider key" could not
//! be imported. Rust reaches the same capability through predicates on
//! `BrainError`, which is why the checks below exercise those from the root
//! rather than naming error types.
//!
//! In Rust most of this is a compile-time assertion: if a `pub use` is
//! dropped, this file stops building. The runtime cases cover what compiling
//! cannot — that a re-exported binding points at the thing it claims to.
//!
//! Mirrors `typescript/test/entry-surface` and
//! `python/tests/entry_surface`.

use std::time::Duration;

// Named one by one rather than glob-imported: a glob would keep compiling
// after an item was dropped from the root, which is the failure being
// guarded. A list is a decision, and removing a line from it is a reviewable
// act.
use brain_db_sdk::{
    derive_space_id, new_id, with_default_retry, with_retry, Auth, BrainClient, BrainError,
    BrainHttpClient, BrainHttpError, ClientConfig, ConnectionInfo, EncodeBuilder, ForgetBuilder,
    HandshakeOutcome, HttpRetryPolicy, MuxConnection, Pool, RecallAnswer, RecallBuilder,
    RetryPolicy, Subscription, DEFAULT_DERIVED_WRITE_TIMEOUT,
};

/// Every root item is nameable as a type or value. Dropping a `pub use` makes
/// this fail to compile, which is the strongest form this check can take.
#[allow(dead_code)]
fn the_root_surface_is_nameable() {
    fn takes_type<T>() {}
    takes_type::<BrainClient>();
    takes_type::<ClientConfig>();
    takes_type::<Auth>();
    takes_type::<ConnectionInfo>();
    takes_type::<RecallAnswer>();
    takes_type::<MuxConnection<tokio::net::TcpStream>>();
    takes_type::<HandshakeOutcome>();
    takes_type::<Subscription<tokio::net::TcpStream>>();
    takes_type::<Pool>();
    takes_type::<EncodeBuilder>();
    takes_type::<RecallBuilder>();
    takes_type::<ForgetBuilder>();
    takes_type::<BrainError>();
    takes_type::<RetryPolicy>();
    takes_type::<BrainHttpClient>();
    takes_type::<BrainHttpError>();
    takes_type::<HttpRetryPolicy>();

    let _: fn() -> [u8; 16] = new_id;
    let _: Duration = DEFAULT_DERIVED_WRITE_TIMEOUT;
    let _ = derive_space_id;
    let _: brain_db_sdk::Result<()> = Ok(());
}

#[test]
fn the_credential_verdicts_are_reachable_from_the_root() {
    // The capability Python exposes as two exported error classes and
    // TypeScript as two exported predicates. Here it is two predicates on the
    // root-exported error, so a caller never has to reach into `error::`.
    let other = BrainError::Protocol("unrelated".into());
    assert!(!other.is_llm_credential_missing());
    assert!(!other.is_llm_credential_unavailable());
    assert!(!other.is_act_as_denied());
}

#[test]
fn the_retry_policy_is_constructible_from_the_root() {
    let none = RetryPolicy::none();
    assert_eq!(none.max_attempts, 1, "none() must be a single attempt");
    let default = RetryPolicy::default();
    assert!(default.max_attempts >= 1);
    assert!(default.base_delay <= default.max_delay);
}

#[tokio::test]
async fn it_retries_through_the_exported_combinator() {
    // Proves the binding is wired, not merely present: a re-export pointing
    // at the wrong module would still compile and still be callable.
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::ZERO,
        max_delay: Duration::ZERO,
    };
    let calls = std::cell::Cell::new(0u32);
    let out: String = with_retry(&policy, || async {
        calls.set(calls.get() + 1);
        if calls.get() < 3 {
            // A socket-level failure, which the shared retry contract in
            // `tests/retry` classifies as retryable in all three SDKs.
            Err(BrainError::Io(std::io::Error::from(
                std::io::ErrorKind::ConnectionReset,
            )))
        } else {
            Ok("ok".to_string())
        }
    })
    .await
    .expect("the third attempt succeeds");
    assert_eq!(out, "ok");
    assert_eq!(calls.get(), 3, "it must have retried twice");
}

#[tokio::test]
async fn it_gives_up_on_a_non_retryable_error_without_rerunning() {
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::ZERO,
        max_delay: Duration::ZERO,
    };
    let calls = std::cell::Cell::new(0u32);
    let err = with_retry(&policy, || async {
        calls.set(calls.get() + 1);
        Err::<(), _>(BrainError::Protocol("a bug, not a blip".into()))
    })
    .await
    .expect_err("a protocol fault is not retryable");
    assert!(matches!(err, BrainError::Protocol(_)));
    assert_eq!(calls.get(), 1, "a non-retryable error must not be re-run");
}

#[tokio::test]
async fn the_default_retry_entry_point_is_wired_too() {
    let calls = std::cell::Cell::new(0u32);
    let out: u8 = with_default_retry(|| async {
        calls.set(calls.get() + 1);
        Ok(7u8)
    })
    .await
    .expect("one clean attempt");
    assert_eq!((out, calls.get()), (7, 1));
}
