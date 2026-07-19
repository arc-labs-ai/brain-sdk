//! Retry policy for the HTTP tier.
//!
//! Self-contained (it does not reach into the wire [`crate::retry`] module) so
//! the `http` module stays a standalone client. The policy is applied only to
//! idempotent verbs — `encode` (stable server-side request id), `whoami`, and
//! `capabilities` (GET) — while `recall`/`forget`/`link`/`unlink`/`plan`/`reason`
//! stay single-shot.
//!
//! Retryable failures are HTTP `503` responses and transport/timeout errors
//! (which surface as [`BrainHttpError`] with `status == 0`). Nothing else — a
//! `4xx` (401/400/404/409) is a client verdict and never retried. The backoff
//! grows exponentially from `base_delay` (100ms, 200ms, …), capped at
//! `max_delay`; a server `Retry-After` hint overrides the computed schedule.

use std::time::Duration;

use super::error::BrainHttpError;

/// How many times to retry and how long to wait between tries.
#[derive(Clone, Debug)]
pub struct HttpRetryPolicy {
    /// Total attempts including the first. `1` disables retry.
    pub max_attempts: u32,
    /// First backoff; doubles each subsequent attempt.
    pub base_delay: Duration,
    /// Upper bound on any single backoff (also caps a server `Retry-After`).
    pub max_delay: Duration,
}

impl Default for HttpRetryPolicy {
    /// 3 attempts, 100ms base backoff, 2s cap.
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(2),
        }
    }
}

impl HttpRetryPolicy {
    /// No retry: a single attempt.
    #[must_use]
    pub fn none() -> Self {
        Self {
            max_attempts: 1,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        }
    }

    /// An explicit policy. `max_attempts` is floored at `1`.
    #[must_use]
    pub fn new(max_attempts: u32, base_delay: Duration, max_delay: Duration) -> Self {
        Self {
            max_attempts: max_attempts.max(1),
            base_delay,
            max_delay,
        }
    }

    /// Whether a failure with this `status` is transient: transport/timeout
    /// (`0`) or a server `503`. Every other status — including all `4xx` — is a
    /// terminal verdict.
    #[must_use]
    pub(crate) fn is_retryable_status(status: u16) -> bool {
        status == 0 || status == 503
    }

    /// Whether to retry after `attempt` (1-based) produced `err`.
    #[must_use]
    pub(crate) fn should_retry(&self, attempt: u32, err: &BrainHttpError) -> bool {
        attempt < self.max_attempts && Self::is_retryable_status(err.status)
    }

    /// The backoff to wait *after* `attempt` (1-based) failed and *before* the
    /// next try. A server-sent `retry_after` overrides the exponential schedule
    /// (still capped at `max_delay`).
    #[must_use]
    pub(crate) fn backoff(&self, attempt: u32, retry_after: Option<Duration>) -> Duration {
        if let Some(ra) = retry_after {
            return ra.min(self.max_delay);
        }
        if self.base_delay.is_zero() {
            return Duration::ZERO;
        }
        // base * 2^(attempt-1), saturating at max_delay.
        let shift = attempt.saturating_sub(1).min(31);
        let mult = 1u32 << shift;
        self.base_delay
            .checked_mul(mult)
            .unwrap_or(self.max_delay)
            .min(self.max_delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_503_and_transport_are_retryable() {
        assert!(HttpRetryPolicy::is_retryable_status(0));
        assert!(HttpRetryPolicy::is_retryable_status(503));
        for s in [400, 401, 404, 409, 429, 500, 502, 504] {
            assert!(!HttpRetryPolicy::is_retryable_status(s), "{s} must not retry");
        }
    }

    #[test]
    fn exponential_backoff_doubles_and_caps() {
        let p = HttpRetryPolicy::new(4, Duration::from_millis(100), Duration::from_secs(2));
        assert_eq!(p.backoff(1, None), Duration::from_millis(100));
        assert_eq!(p.backoff(2, None), Duration::from_millis(200));
        assert_eq!(p.backoff(3, None), Duration::from_millis(400));
        // 100 * 2^30 would exceed the 2s cap.
        assert_eq!(p.backoff(31, None), Duration::from_secs(2));
    }

    #[test]
    fn retry_after_overrides_and_is_capped() {
        let p = HttpRetryPolicy::default();
        assert_eq!(
            p.backoff(1, Some(Duration::from_millis(500))),
            Duration::from_millis(500)
        );
        assert_eq!(
            p.backoff(1, Some(Duration::from_secs(99))),
            Duration::from_secs(2),
            "server hint is capped at max_delay"
        );
    }

    #[test]
    fn should_retry_respects_attempts_and_status() {
        let p = HttpRetryPolicy::default(); // 3 attempts
        let transient = BrainHttpError {
            status: 503,
            code: "unavailable".into(),
            message: String::new(),
        };
        let client_err = BrainHttpError {
            status: 401,
            code: "unauthorized".into(),
            message: String::new(),
        };
        assert!(p.should_retry(1, &transient));
        assert!(p.should_retry(2, &transient));
        assert!(!p.should_retry(3, &transient), "exhausted at max_attempts");
        assert!(!p.should_retry(1, &client_err), "4xx never retries");
    }
}
