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
from dataclasses import dataclass
from typing import Callable, Optional, TypeVar

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
    return random.uniform(floor, delay)


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
    def none() -> "RetryPolicy":
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
        except Exception as exc:  # noqa: BLE001 — re-raised below if not retryable
            if attempt < policy.max_attempts and is_retryable(exc):
                server_floor = _server_retry_after_seconds(exc)
                delay = policy.backoff(attempt, server_floor)
                if delay:
                    # The server hint is the floor; jitter spreads the actual
                    # sleep across [floor, delay] so a herd doesn't retry in
                    # lockstep. `backoff` already capped the hint at max_delay.
                    floor = min(server_floor, policy.max_delay) if server_floor is not None else 0.0
                    time.sleep(_jittered(delay, floor))
                attempt += 1
                continue
            raise


__all__ = ["RetryPolicy", "with_retry"]
