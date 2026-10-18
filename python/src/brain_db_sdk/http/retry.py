"""Retry policy for the HTTP tier.

Self-contained (it does not reach into the wire ``brain_db_sdk`` retry code) so
the ``http`` package stays a standalone client. The policy is applied only to
idempotent verbs — ``encode`` (stable server-side request id), ``whoami``, and
``capabilities`` (GET) — while ``recall``/``forget``/``link``/``unlink``/``plan``/
``reason`` stay single-shot.

Retryable failures are HTTP ``503`` responses and transport/timeout errors
(which surface as :class:`BrainHttpError` with ``status == 0``). Nothing else — a
``4xx`` (401/400/404/409) is a client verdict and never retried. The backoff
grows exponentially from ``base_delay`` (0.1s, 0.2s, …), capped at ``max_delay``;
a server ``Retry-After`` hint overrides the computed schedule.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .errors import BrainHttpError


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
    def is_retryable_status(status: int) -> bool:
        """Transport/timeout (``0``), a server ``503``, or a ``429``.

        ``429`` is a "slow down", not a refusal: an idempotent call is safe to
        repeat once the server's ``Retry-After`` has passed, and
        :meth:`backoff` already honours that hint. It was excluded here while
        the TypeScript client retried it — so the same rate-limited read was
        absorbed by one SDK and raised at the caller by this one. Every other
        ``4xx`` stays terminal: retrying a 400 or a 409 cannot change the
        answer.
        """
        return status in (0, 429, 503)

    def should_retry(self, attempt: int, err: BrainHttpError) -> bool:
        """Whether to retry after ``attempt`` (1-based) produced ``err``."""
        return attempt < self.max_attempts and self.is_retryable_status(err.status)

    def backoff(self, attempt: int, retry_after: Optional[float]) -> float:
        """Seconds to wait after ``attempt`` (1-based) failed. A server
        ``retry_after`` overrides the exponential schedule (still capped)."""
        if retry_after is not None:
            return min(retry_after, self.max_delay)
        if self.base_delay <= 0:
            return 0.0
        return min(self.base_delay * (2 ** (attempt - 1)), self.max_delay)
