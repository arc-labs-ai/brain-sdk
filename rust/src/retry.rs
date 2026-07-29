//! Retry policy and a combinator that applies it to any client operation.
//!
//! Retrying is opt-in and composable rather than baked into every verb: wrap a
//! call in [`with_retry`] and it re-runs the operation while the error is
//! retryable ([`BrainError::is_retryable`]) and attempts remain, sleeping a
//! backoff between tries. The backoff honors a server-supplied `retry_after_ms`
//! when present, else grows exponentially from `base_delay`, capped at
//! `max_delay`; the actual sleep then gets full jitter (a random point in
//! `[floor, delay]`, with the server hint as the floor) so clients that failed
//! together don't retry in lockstep.
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

/// Apply full jitter to a computed backoff: return a uniformly random delay in
/// `[floor, delay]`. `floor` honors a server-supplied `retry_after` (we never
/// retry sooner than the server asked); when there is no server floor it is
/// zero, so the sleep is anywhere in `[0, delay]`. Full jitter spreads a herd
/// of clients that failed together so they don't re-hit the server in lockstep.
///
/// The randomness needs no cryptographic quality — it only has to decorrelate
/// clients — so we draw from a SplitMix64 seeded from the wall clock rather than
/// pull in a `rand` dependency.
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
    // SplitMix64: one mix is plenty to pick a point in the span.
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    let extra = z % span_nanos;
    floor + Duration::from_nanos(extra)
}

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
            let server_floor = err.retry_after();
            // `backoff` already folds the server hint in and caps at max_delay;
            // jitter then spreads the actual sleep across [floor, delay] so a
            // herd that failed together doesn't retry in lockstep. The server
            // hint is the floor — we never wake earlier than it asked.
            let delay = self.backoff(attempt, server_floor).map(|delay| {
                jittered(
                    delay,
                    server_floor.unwrap_or(Duration::ZERO).min(self.max_delay),
                )
            });
            RetryStep::Retry(delay)
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
    fn jitter_stays_within_bounds_and_honors_the_floor() {
        let delay = Duration::from_millis(800);
        // No floor: result lands in [0, delay].
        for _ in 0..1000 {
            let j = jittered(delay, Duration::ZERO);
            assert!(j <= delay, "jitter must not exceed the base delay");
        }
        // With a floor: result lands in [floor, delay] and never below the floor.
        let floor = Duration::from_millis(200);
        for _ in 0..1000 {
            let j = jittered(delay, floor);
            assert!(j >= floor, "jitter must never wake before the server floor");
            assert!(j <= delay, "jitter must not exceed the base delay");
        }
    }

    #[test]
    fn jitter_with_zero_span_returns_the_floor() {
        // floor == delay leaves no room to jitter.
        let d = Duration::from_millis(500);
        assert_eq!(jittered(d, d), d);
        // floor clamped to delay when it would exceed it.
        assert_eq!(jittered(d, Duration::from_secs(99)), d);
    }

    #[test]
    fn step_jitters_within_the_scheduled_delay() {
        let p = RetryPolicy::new(5, Duration::from_millis(100), Duration::from_secs(1));
        // attempt 4 schedules 800ms; jittered sleep stays within [0, 800ms].
        for _ in 0..1000 {
            match p.step(4, &BrainError::Closed) {
                RetryStep::Retry(Some(d)) => assert!(d <= Duration::from_millis(800)),
                other => panic!("expected a jittered retry, got {other:?}"),
            }
        }
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
