"""Retry policy for the HTTP tier.

Self-contained (it does not reach into the wire ``brain_db_sdk`` retry code) so
the ``http`` package stays a standalone client. The policy is applied only to
idempotent verbs — ``encode`` (stable server-side request id), ``whoami``, and
``capabilities`` (GET) — while ``recall``/``forget``/``link``/``unlink``/``plan``/
``reason`` stay single-shot.

Retryable failures are transport/timeout errors (``status == 0``), HTTP
``503``, and HTTP ``429`` responses carrying a ``Retry-After`` hint. A ``429``
without the hint is a terminal verdict, as are all other statuses. The backoff
grows exponentially from ``base_delay`` (0.1s, 0.2s, …), capped at
``max_delay``; a server hint overrides the computed schedule; the actual sleep
is full-jittered within ``[hint, delay]``. ``max_attempts`` bounds total
attempts, ``backoff`` caps the hint, and a 429 without a cool-off hint never
spends retry budget.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Optional

from .errors import BrainHttpError


def _jittered(delay: float, floor: float) -> float:
    """Return a full-jitter delay in ``[floor, delay]``.

    The floor honors a server-supplied ``Retry-After`` so the client never
    wakes sooner than requested; with no hint it is zero. A random point keeps
    clients that failed together from retrying in lockstep.
    """
    floor = min(floor, delay)
    if delay <= floor:
        return floor
    # Retry jitter is scheduling, not a secret; ``random`` is the right tool.
    return random.uniform(floor, delay)  # noqa: S311


@dataclass
class HttpRetryPolicy:
    """How many times to retry and how long to wait between tries (seconds)."""

    max_attempts: int = 3
    base_delay: float = 0.1
    max_delay: float = 2.0

    @staticmethod
    def none() -> HttpRetryPolicy:
        """No retry: a single attempt."""
        return HttpRetryPolicy(max_attempts=1, base_delay=0.0, max_delay=0.0)

    @staticmethod
    def is_retryable(status: int, retry_after: Optional[float]) -> bool:
        """Whether waiting can clear the failure."""
        # max_attempts bounds total attempts, backoff caps Retry-After, and a
        # 429 without a cool-off hint never spends retry budget.
        return status in (0, 503) or (status == 429 and retry_after is not None)

    def should_retry(self, attempt: int, err: BrainHttpError) -> bool:
        """Whether to retry after ``attempt`` (1-based) produced ``err``."""
        return attempt < self.max_attempts and self.is_retryable(err.status, err.retry_after)

    def backoff(self, attempt: int, retry_after: Optional[float]) -> float:
        """Seconds to wait after ``attempt`` (1-based) failed. A server
        ``retry_after`` overrides the exponential schedule (still capped)."""
        if retry_after is not None:
            return min(retry_after, self.max_delay)
        if self.base_delay <= 0:
            return 0.0
        return min(self.base_delay * (2 ** (attempt - 1)), self.max_delay)

    def sleep_delay(self, attempt: int, retry_after: Optional[float]) -> float:
        """Return the actual jittered sleep after a failed attempt.

        ``backoff`` has already folded in and capped the server hint; this is
        the single place that decides the sleep so the schedule and its floor
        cannot drift apart.
        """
        delay = self.backoff(attempt, retry_after)
        floor = min(retry_after, self.max_delay) if retry_after is not None else 0.0
        return _jittered(delay, floor)
