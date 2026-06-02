//! Retry policy and a combinator that applies it to any client operation.
//!
//! Retrying is opt-in and composable rather than baked into every verb: wrap a
//! call in [`with_retry`] and it re-runs the operation while the error is
//! retryable ([`BrainError::is_retryable`]) and attempts remain, sleeping a
//! backoff between tries. The backoff honors a server-supplied `retry_after_ms`
//! when present, else grows exponentially from `base_delay`, capped at
//! `max_delay`.
//!
//! Because every request builder mints a stable `request_id`, re-sending the
//! *same* request is idempotent on the server (24h idempotency window), so a
//! retried verb does not double-apply. A server `ResourceExhausted` /
//! `Unavailable` verdict arrives as a normal ERROR frame, leaving the
//! connection usable — so those retry in place. A transport drop is reported
//! retryable too, but on a single non-reconnecting connection it will simply
//! re-fail fast; transparent reconnect is a later phase.

use std::future::Future;
use std::time::Duration;

use crate::error::{BrainError, Result};

/// What to do after an attempt failed: wait the given backoff then retry, or
/// give up and surface the error. Produced by [`RetryPolicy::step`] and driven
/// by both the free [`with_retry`] combinator and the client's per-verb
/// `*_with_retry` methods.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryStep {
    /// Retry after an optional sleep.
    Retry(Option<Duration>),
    /// Stop and return the error.
    GiveUp,
}

/// How many times to retry and how long to wait between tries.
#[derive(Clone, Debug)]
pub struct RetryPolicy {
    /// Total attempts including the first. `1` disables retry.
    pub max_attempts: u32,
    /// First backoff; doubles each subsequent attempt.
    pub base_delay: Duration,
    /// Upper bound on any single backoff (also caps a server `retry_after`).
    pub max_delay: Duration,
}

impl RetryPolicy {
    /// No retry: a single attempt.
    #[must_use]
    pub fn none() -> Self {
        Self {
            max_attempts: 1,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        }
    }

    /// An explicit policy.
    #[must_use]
    pub fn new(max_attempts: u32, base_delay: Duration, max_delay: Duration) -> Self {
        Self {
            max_attempts: max_attempts.max(1),
            base_delay,
            max_delay,
        }
    }

    /// The backoff to wait *after* `attempt` failed and *before* the next try,
    /// or `None` when no wait is needed. `attempt` is 1-based. A server-sent
    /// `retry_after` overrides the exponential schedule (still capped).
    #[must_use]
    pub fn backoff(&self, attempt: u32, server_retry_after: Option<Duration>) -> Option<Duration> {
        if let Some(ra) = server_retry_after {
            return Some(ra.min(self.max_delay));
        }
        if self.base_delay.is_zero() {
            return None;
        }
        // base * 2^(attempt-1), saturating at max_delay.
        let shift = attempt.saturating_sub(1).min(31);
        let mult = 1u32 << shift;
        let delay = self
            .base_delay
            .checked_mul(mult)
            .unwrap_or(self.max_delay)
            .min(self.max_delay);
        Some(delay)
    }

    /// Decide what to do after `attempt` (1-based) produced `err`: retry while
    /// the error is retryable and attempts remain, else give up. The shared
    /// decision behind every retry path so they agree.
    #[must_use]
    pub fn step(&self, attempt: u32, err: &BrainError) -> RetryStep {
        if attempt < self.max_attempts && err.is_retryable() {
            RetryStep::Retry(self.backoff(attempt, err.retry_after()))
        } else {
            RetryStep::GiveUp
        }
    }
}

impl Default for RetryPolicy {
    /// 3 attempts, 100ms base backoff, 5s cap.
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(5),
        }
    }
}

/// Run `op`, retrying per `policy` while the error is retryable and attempts
/// remain. `op` is re-invoked from scratch each try, so pass a closure that
/// rebuilds the future (e.g. `|| client.forget(&req)`); the same `req` keeps a
/// stable `request_id`, making the retry idempotent server-side.
pub async fn with_retry<T, F, Fut>(policy: &RetryPolicy, mut op: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt: u32 = 1;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(err) => match policy.step(attempt, &err) {
                RetryStep::Retry(delay) => {
                    if let Some(delay) = delay {
                        tokio::time::sleep(delay).await;
                    }
                    attempt += 1;
                }
                RetryStep::GiveUp => return Err(err),
            },
        }
    }
}

/// Convenience: [`with_retry`] with the [`RetryPolicy::default`] schedule.
pub async fn with_default_retry<T, F, Fut>(op: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    with_retry(&RetryPolicy::default(), op).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn exponential_backoff_doubles_and_caps() {
        let p = RetryPolicy::new(5, Duration::from_millis(100), Duration::from_secs(1));
        assert_eq!(p.backoff(1, None), Some(Duration::from_millis(100)));
        assert_eq!(p.backoff(2, None), Some(Duration::from_millis(200)));
        assert_eq!(p.backoff(3, None), Some(Duration::from_millis(400)));
        assert_eq!(p.backoff(4, None), Some(Duration::from_millis(800)));
        // 1600ms would exceed the 1s cap.
        assert_eq!(p.backoff(5, None), Some(Duration::from_secs(1)));
    }

    #[test]
    fn server_retry_after_overrides_and_is_capped() {
        let p = RetryPolicy::new(3, Duration::from_millis(100), Duration::from_secs(2));
        assert_eq!(
            p.backoff(1, Some(Duration::from_millis(500))),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            p.backoff(1, Some(Duration::from_secs(99))),
            Some(Duration::from_secs(2)),
            "server hint is capped at max_delay"
        );
    }

    #[test]
    fn none_policy_means_no_backoff() {
        let p = RetryPolicy::none();
        assert_eq!(p.max_attempts, 1);
        assert_eq!(p.backoff(1, None), None);
    }

    #[tokio::test]
    async fn retries_until_success_then_stops() {
        let calls = Cell::new(0u32);
        // Fail twice (retryable), succeed on the third attempt.
        let policy = RetryPolicy::new(5, Duration::ZERO, Duration::ZERO);
        let out: Result<u32> = with_retry(&policy, || {
            let n = calls.get() + 1;
            calls.set(n);
            async move {
                if n < 3 {
                    Err(BrainError::Closed)
                } else {
                    Ok(n)
                }
            }
        })
        .await;
        assert_eq!(out.unwrap(), 3);
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn does_not_retry_a_non_retryable_error() {
        let calls = Cell::new(0u32);
        let policy = RetryPolicy::new(5, Duration::ZERO, Duration::ZERO);
        let out: Result<u32> = with_retry(&policy, || {
            calls.set(calls.get() + 1);
            async move { Err(BrainError::Protocol("nope".into())) }
        })
        .await;
        assert!(matches!(out, Err(BrainError::Protocol(_))));
        assert_eq!(calls.get(), 1, "a non-retryable error must not retry");
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let calls = Cell::new(0u32);
        let policy = RetryPolicy::new(3, Duration::ZERO, Duration::ZERO);
        let out: Result<u32> = with_retry(&policy, || {
            calls.set(calls.get() + 1);
            async move { Err(BrainError::Closed) }
        })
        .await;
        assert!(matches!(out, Err(BrainError::Closed)));
        assert_eq!(calls.get(), 3, "exactly max_attempts tries");
    }
}
