/**
 * Retry policy and a helper that applies it to any async client operation.
 *
 * Retrying is opt-in and composable rather than baked into every verb: wrap a
 * call in `withRetry` and it re-runs the operation while the error is retryable
 * (`isRetryable`) and attempts remain, sleeping a backoff between tries. The
 * backoff honors a server-supplied `retryAfterMs` when present, else grows
 * exponentially from `baseDelayMs`, capped at `maxDelayMs`; the actual sleep
 * then gets full jitter (a random point in `[floor, delay]`, with the server
 * hint as the floor) so clients that failed together don't retry in lockstep.
 *
 * Because every request builder mints a stable `requestId`, re-sending the
 * *same* request is idempotent on the server (24h idempotency window), so a
 * retried verb does not double-apply. A server `ResourceExhausted` /
 * `Unavailable` verdict arrives as a normal ERROR frame, leaving the connection
 * usable — so those retry in place. A transport drop is reported retryable too,
 * but on a single non-reconnecting connection it re-fails fast; transparent
 * reconnect is a later phase.
 */

import { ServerError, isRetryable } from "./errors.js";

/** How many times to retry and how long to wait between tries (milliseconds). */
export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retry. */
  maxAttempts: number;
  /** First backoff; doubles each subsequent attempt. */
  baseDelayMs: number;
  /** Upper bound on any single backoff (also caps a server `retryAfter`). */
  maxDelayMs: number;
}

/** The default policy: 3 attempts, 100ms base backoff, 5s cap. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
};

/** No retry: a single attempt. */
export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

/**
 * Milliseconds to wait after `attempt` (1-based) failed and before the next
 * try, or `null` when no wait is needed. A server-sent `serverRetryAfterMs`
 * overrides the exponential schedule (still capped at `maxDelayMs`).
 */
export function backoffMs(
  policy: RetryPolicy,
  attempt: number,
  serverRetryAfterMs: number | null,
): number | null {
  if (serverRetryAfterMs !== null) {
    return Math.min(serverRetryAfterMs, policy.maxDelayMs);
  }
  if (policy.baseDelayMs <= 0) return null;
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

function serverRetryAfterMs(err: unknown): number | null {
  if (err instanceof ServerError && err.retryAfterMs !== null) {
    return err.retryAfterMs;
  }
  return null;
}

/**
 * Apply full jitter to a computed backoff: a uniformly random delay in
 * `[floor, delay]`. `floor` honors a server-supplied `retryAfter` (we never
 * wake sooner than the server asked); with no server floor it is zero, so the
 * sleep is anywhere in `[0, delay]`. Spreads a herd of clients that failed
 * together so they don't re-hit the server in lockstep.
 */
function jittered(delayMs: number, floorMs: number): number {
  const floor = Math.min(floorMs, delayMs);
  if (delayMs <= floor) return floor;
  return floor + Math.random() * (delayMs - floor);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `op`, retrying per `policy` while the error is retryable and attempts
 * remain. `op` is re-invoked from scratch each try, so pass a thunk that
 * rebuilds the call (e.g. `() => client.forget(req)`); reusing the same `req`
 * keeps a stable `requestId`, making the retry idempotent server-side.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (attempt < policy.maxAttempts && isRetryable(err)) {
        const serverFloor = serverRetryAfterMs(err);
        const delay = backoffMs(policy, attempt, serverFloor);
        if (delay !== null) {
          // The server hint is the floor; jitter spreads the actual sleep
          // across [floor, delay] so a herd doesn't retry in lockstep.
          // `backoffMs` already capped the hint at maxDelayMs.
          const floor = serverFloor !== null ? Math.min(serverFloor, policy.maxDelayMs) : 0;
          await sleep(jittered(delay, floor));
        }
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}
