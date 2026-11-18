//! Retry policy for the HTTP tier.
//!
//! Self-contained (it does not reach into the wire [`crate::retry`] module) so
//! the `http` module stays a standalone client. The policy is applied only to
//! idempotent verbs — `encode` (stable server-side request id), `whoami`, and
//! `capabilities` (GET) — while `recall`/`forget`/`link`/`unlink`/`plan`/`reason`
//! stay single-shot.
//!
//! Retryable failures are transport/timeout errors (`status == 0`), HTTP `503`,
//! and HTTP `429` responses carrying a `Retry-After` hint. A `429` without the
//! hint is a terminal verdict, as are all other statuses. The backoff grows
//! exponentially from `base_delay` (100ms, 200ms, …), capped at `max_delay`; a
//! server hint overrides the computed schedule; the actual sleep is
//! full-jittered within `[hint, delay]` so a herd of clients does not retry in
//! lockstep. `max_attempts` bounds total attempts, `backoff` caps the hint at
//! `max_delay`, and a 429 without a cool-off hint never spends retry budget.

use std::time::Duration;

use super::error::BrainHttpError;

/// Apply full jitter to a computed backoff: return a uniformly random delay in
/// `[floor, delay]`. `floor` honors a server-supplied `Retry-After` (we never
/// wake sooner than the server asked); with no server floor it is zero, so the
/// sleep is anywhere in `[0, delay]`. Full jitter spreads a herd of clients
/// that failed together so they do not re-hit the server in lockstep.
///
/// The randomness needs no cryptographic quality — it only has to decorrelate
/// clients — so a SplitMix64 seeded from the wall clock avoids a `rand`
/// dependency.
fn jittered(delay: Duration, floor: Duration) -> Duration {
    let floor = floor.min(delay);
    let span = delay.saturating_sub(floor);
    let span_nanos = u64::try_from(span.as_nanos()).unwrap_or(u64::MAX);
    if span_nanos == 0 {
        return floor;
    }
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        // Keeping only the low 64 bits is the intent: these nanos seed a PRNG
        // and never represent a duration, so the high bits are noise. The mask
        // makes the `try_from` infallible rather than leaving a silent `as`.
        .map_or(0x9E37_79B9_7F4A_7C15, |d| {
            u64::try_from(d.as_nanos() & u128::from(u64::MAX)).unwrap_or(0)
        });
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    floor + Duration::from_nanos(z % span_nanos)
}

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

    /// Whether a failure has a server-approved path to recovery.
    #[must_use]
    pub(crate) fn is_retryable(status: u16, retry_after: Option<Duration>) -> bool {
        // max_attempts bounds total attempts, backoff caps Retry-After at
        // max_delay, and a 429 without a cool-off hint never spends budget.
        status == 0 || status == 503 || (status == 429 && retry_after.is_some())
    }

    /// Whether to retry after `attempt` (1-based) produced `err`.
    #[must_use]
    pub(crate) fn should_retry(
        &self,
        attempt: u32,
        err: &BrainHttpError,
        retry_after: Option<Duration>,
    ) -> bool {
        attempt < self.max_attempts && Self::is_retryable(err.status, retry_after)
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

    /// Choose the actual sleep after a failed attempt. `backoff` has already
    /// folded the server hint in and capped it; keeping jitter here makes this
    /// the single place where the sleep is decided so those two steps cannot
    /// drift apart.
    #[must_use]
    pub(crate) fn sleep_delay(&self, attempt: u32, retry_after: Option<Duration>) -> Duration {
        let delay = self.backoff(attempt, retry_after);
        jittered(
            delay,
            retry_after.unwrap_or(Duration::ZERO).min(self.max_delay),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byok_missing_credential_status_is_not_retryable() {
        // The BYOK contract maps "this namespace has no provider key" to HTTP
        // 409. That choice is load-bearing: a tenant without a key cannot
        // acquire one by retrying, so if it were mapped to 503 every client
        // would hammer the endpoint forever. The transient counterpart
        // (credential broker unreachable) is 503 and SHOULD retry.
        assert!(
            !HttpRetryPolicy::is_retryable(429, None),
            "a verdict 429 has no server-approved recovery wait"
        );
        assert!(
            !HttpRetryPolicy::is_retryable(400, None),
            "retrying a malformed request cannot change the answer"
        );
        assert!(
            !HttpRetryPolicy::is_retryable(409, None),
            "llm_credential.missing (409) is terminal — retrying cannot create a key"
        );
        assert!(
            HttpRetryPolicy::is_retryable(503, None),
            "llm_credential.unavailable (503) is transient — it must retry"
        );
    }

    #[test]
    fn only_429_with_a_hint_is_retryable_alongside_transport_and_503() {
        assert!(HttpRetryPolicy::is_retryable(0, None));
        assert!(HttpRetryPolicy::is_retryable(0, Some(Duration::ZERO)));
        assert!(HttpRetryPolicy::is_retryable(503, None));
        assert!(HttpRetryPolicy::is_retryable(503, Some(Duration::ZERO)));
        assert!(HttpRetryPolicy::is_retryable(429, Some(Duration::ZERO)));
        // 500/502/504 stay terminal on purpose: unlike 503 they carry no
        // "try again" contract, and a blind repeat of a write-adjacent fault
        // is how one failure becomes several.
        for s in [400, 401, 404, 409, 500, 502, 504] {
            assert!(
                !HttpRetryPolicy::is_retryable(s, None),
                "{s} must not retry"
            );
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
    fn sleep_delay_spreads_clients_with_no_server_hint() {
        let p = HttpRetryPolicy::default();
        let delay = p.backoff(1, None);
        let samples: std::collections::HashSet<_> =
            (0..200).map(|_| p.sleep_delay(1, None)).collect();
        // A deterministic backoff synchronises every client that one 503
        // knocked down, making them retry in the same burst.
        assert!(samples.len() > 1);
        assert!(samples
            .iter()
            .all(|sample| Duration::ZERO <= *sample && *sample <= delay));
    }

    #[test]
    fn sleep_delay_honors_server_hint_as_an_exact_floor_when_it_is_the_delay() {
        let p = HttpRetryPolicy::default();
        let hint = Duration::from_millis(500);
        // When the server hint is the scheduled delay, no client can wake
        // before that floor even though the usual schedule is randomized.
        for _ in 0..200 {
            assert_eq!(p.sleep_delay(1, Some(hint)), hint);
        }
    }

    #[test]
    fn should_retry_respects_attempts_and_status() {
        let p = HttpRetryPolicy::default(); // 3 attempts
        let transient = BrainHttpError {
            status: 503,
            code: "unavailable".into(),
            message: String::new(),
            field_errors: Vec::new(),
            engine_code: None,
        };
        let client_err = BrainHttpError {
            status: 401,
            code: "unauthorized".into(),
            message: String::new(),
            field_errors: Vec::new(),
            engine_code: None,
        };
        assert!(p.should_retry(1, &transient, None));
        assert!(p.should_retry(2, &transient, None));
        assert!(
            !p.should_retry(3, &transient, None),
            "exhausted at max_attempts"
        );
        assert!(!p.should_retry(1, &client_err, None), "4xx never retries");
    }
}
