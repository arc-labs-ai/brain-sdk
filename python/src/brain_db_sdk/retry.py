"""Retry policy and a helper that applies it to any client operation.

Retrying is opt-in and composable rather than baked into every verb: wrap a
call in :func:`with_retry` and it re-runs the operation while the error is
retryable (:func:`brain_db_sdk.errors.is_retryable`) and attempts remain,
sleeping a backoff between tries. The backoff honors a server-supplied
``retry_after_ms`` when present, else grows exponentially from ``base_delay``,
capped at ``max_delay``; the actual sleep then gets full jitter (a random point
in ``[floor, delay]``, with the server hint as the floor) so clients that failed
together don't retry in lockstep.

Because every request builder mints a stable ``request_id``, re-sending the
*same* request is idempotent on the server (24h idempotency window), so a
retried verb does not double-apply. A server ``ResourceExhausted`` /
``Unavailable`` verdict arrives as a normal ERROR frame, leaving the connection
usable — so those retry in place. A transport drop is reported retryable too,
but on a single non-reconnecting connection it re-fails fast; transparent
reconnect is a later phase.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Optional, TypeVar

from .errors import ServerError, is_retryable

T = TypeVar("T")


def _jittered(delay: float, floor: float) -> float:
    """Apply full jitter to a computed backoff: a uniformly random delay in
    ``[floor, delay]``. ``floor`` honors a server-supplied ``retry_after`` (we
    never wake sooner than the server asked); with no server floor it is zero,
    so the sleep is anywhere in ``[0, delay]``. Spreads a herd of clients that
    failed together so they don't re-hit the server in lockstep."""
    floor = min(floor, delay)
    if delay <= floor:
        return floor
    # Retry jitter is scheduling, not a secret; `random` is the right tool.
    return random.uniform(floor, delay)  # noqa: S311


@dataclass
class RetryPolicy:
    """How many times to retry and how long to wait between tries.

    ``max_attempts`` is the total attempts including the first (1 disables
    retry). ``base_delay`` is the first backoff and doubles each subsequent
    attempt; ``max_delay`` caps any single backoff (and a server
    ``retry_after``). Delays are in seconds.
    """

    max_attempts: int = 3
    base_delay: float = 0.1
    max_delay: float = 5.0

    @staticmethod
    def none() -> RetryPolicy:
        """No retry: a single attempt."""
        return RetryPolicy(max_attempts=1, base_delay=0.0, max_delay=0.0)

    def backoff(self, attempt: int, server_retry_after: Optional[float]) -> Optional[float]:
        """Seconds to wait after ``attempt`` (1-based) failed and before the
        next try, or ``None`` when no wait is needed. A server-sent
        ``retry_after`` overrides the exponential schedule (still capped)."""
        if server_retry_after is not None:
            return min(server_retry_after, self.max_delay)
        if self.base_delay <= 0.0:
            return None
        delay = self.base_delay * (2 ** max(0, attempt - 1))
        return min(delay, self.max_delay)


def _server_retry_after_seconds(exc: BaseException) -> Optional[float]:
    if isinstance(exc, ServerError) and exc.retry_after_ms is not None:
        return exc.retry_after_ms / 1000.0
    return None


def sleep_before_retry(policy: RetryPolicy, attempt: int, exc: BaseException) -> Optional[float]:
    """How long to wait after ``attempt`` (1-based) failed with ``exc``, or
    ``None`` when the next try should go straight out.

    The whole decision — the server's ``retry_after`` hint, the exponential
    schedule, the cap, and the jitter that keeps a herd from retrying in
    lockstep — lives here so the synchronous :func:`with_retry` and the
    asyncio one cannot drift into two different backoff curves. They differ
    only in how they wait out the number this returns.
    """
    server_floor = _server_retry_after_seconds(exc)
    delay = policy.backoff(attempt, server_floor)
    if not delay:
        return None
    # The server hint is the floor; jitter spreads the actual sleep across
    # [floor, delay]. `backoff` already capped the hint at max_delay.
    floor = min(server_floor, policy.max_delay) if server_floor is not None else 0.0
    return _jittered(delay, floor)


def with_retry(op: Callable[[], T], policy: Optional[RetryPolicy] = None) -> T:
    """Run ``op``, retrying per ``policy`` while the error is retryable and
    attempts remain. ``op`` is re-invoked from scratch each try, so pass a
    thunk that rebuilds the call (e.g. ``lambda: client.forget(req)``); reusing
    the same ``req`` keeps a stable ``request_id``, making the retry
    idempotent server-side. With no policy, uses :class:`RetryPolicy` defaults.
    """
    policy = policy or RetryPolicy()
    attempt = 1
    while True:
        try:
            return op()
        except Exception as exc:
            if attempt < policy.max_attempts and is_retryable(exc):
                delay = sleep_before_retry(policy, attempt, exc)
                if delay:
                    time.sleep(delay)
                attempt += 1
                continue
            raise


__all__ = ["RetryPolicy", "sleep_before_retry", "with_retry"]
