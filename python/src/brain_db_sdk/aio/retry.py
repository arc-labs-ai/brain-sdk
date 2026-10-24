"""Retry for coroutine operations.

The asyncio twin of :mod:`brain_db_sdk.retry`, and deliberately thin: the
policy type and the whole backoff decision are imported from there, so the two
tiers cannot drift into different curves. All that differs is ``await
asyncio.sleep`` instead of ``time.sleep`` — which is the point, because a
blocking sleep inside a coroutine stalls every other task on the loop, not just
the one retrying.

Because every request builder mints a stable ``request_id``, re-sending the
*same* request is idempotent on the server (24h idempotency window), so a
retried verb does not double-apply.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Optional, TypeVar

from brain_db_sdk.errors import is_retryable
from brain_db_sdk.retry import RetryPolicy, sleep_before_retry

T = TypeVar("T")


async def with_retry(
    op: Callable[[], Awaitable[T]],
    policy: Optional[RetryPolicy] = None,
) -> T:
    """Await ``op()``, retrying per ``policy`` while the error is retryable and
    attempts remain.

    ``op`` is a *factory*, not a coroutine: it is called afresh each try, so
    pass ``lambda: client.forget(req)`` rather than ``client.forget(req)``. A
    coroutine object can only be awaited once, so handing one in directly would
    raise ``RuntimeError`` the moment a retry actually happened — the path
    least likely to be exercised in testing. Reusing the same ``req`` across
    tries keeps a stable ``request_id``, which is what makes the resend
    idempotent server-side.

    Cancellation is not a failure to retry: :class:`asyncio.CancelledError`
    derives from :class:`BaseException`, so it propagates out of the ``except
    Exception`` below untouched and a cancelled scope stops immediately instead
    of sleeping out the rest of its attempts.
    """
    policy = policy or RetryPolicy()
    attempt = 1
    while True:
        try:
            return await op()
        except Exception as exc:
            if attempt < policy.max_attempts and is_retryable(exc):
                delay = sleep_before_retry(policy, attempt, exc)
                if delay:
                    await asyncio.sleep(delay)
                attempt += 1
                continue
            raise


__all__ = ["RetryPolicy", "with_retry"]
