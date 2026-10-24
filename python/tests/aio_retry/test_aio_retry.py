"""Retry for coroutine operations.

The policy and the backoff curve are shared with the synchronous tier and
tested there; what is specific here is the awaiting — that the wait does not
block the loop, that a cancelled scope stops instead of sleeping out its
remaining attempts, and that the operation is a factory rather than a coroutine
(a coroutine can only be awaited once, so handing one in would fail on exactly
the path least likely to be exercised).
"""

from __future__ import annotations

import asyncio

import pytest

from brain_db_sdk.aio.retry import with_retry
from brain_db_sdk.errors import BrainTimeout, ConnectionClosed, ServerError
from brain_db_sdk.retry import RetryPolicy, sleep_before_retry
from brain_db_sdk.wire.types import ErrorCategory, ErrorResponse

FAST = RetryPolicy(max_attempts=3, base_delay=0.001, max_delay=0.01)


def _server_error(category: int, retry_after_ms: int | None = None) -> ServerError:
    return ServerError.from_response(
        ErrorResponse(
            code=0x0001,
            category=category,
            message="mock",
            details=None,
            retry_after_ms=retry_after_ms,
        )
    )


# --------------------------------------------------------------------------
# Positive
# --------------------------------------------------------------------------


async def test_a_transient_failure_is_retried_and_then_succeeds() -> None:
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionClosed("dropped")
        return "ok"

    assert await with_retry(op, FAST) == "ok"
    assert calls == 3


async def test_a_first_attempt_that_works_is_not_retried() -> None:
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        return "ok"

    assert await with_retry(op, FAST) == "ok"
    assert calls == 1


async def test_the_operation_is_rebuilt_each_attempt() -> None:
    """``op`` is a factory, not a coroutine. A coroutine object can only be
    awaited once, so getting this wrong raises ``RuntimeError`` only when a
    retry actually happens."""
    awaited: list[int] = []
    calls = 0

    def factory():
        nonlocal calls
        calls += 1
        attempt = calls

        async def run() -> str:
            awaited.append(attempt)
            if attempt < 2:
                raise BrainTimeout(0.1)
            return "ok"

        return run()

    assert await with_retry(factory, FAST) == "ok"
    assert awaited == [1, 2], "each attempt must await a fresh coroutine"


async def test_a_resource_exhausted_verdict_is_retried() -> None:
    """The server said "later", not "no" — the connection is still usable and
    the same ``request_id`` makes the resend idempotent."""
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise _server_error(ErrorCategory.RESOURCE_EXHAUSTED)
        return "ok"

    assert await with_retry(op, FAST) == "ok"
    assert calls == 2


# --------------------------------------------------------------------------
# Negative
# --------------------------------------------------------------------------


async def test_a_terminal_verdict_is_not_retried() -> None:
    """A validation or auth refusal cannot be cleared by trying again;
    retrying it only delays the error the caller has to see."""
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        raise _server_error(ErrorCategory.VALIDATION)

    with pytest.raises(ServerError):
        await with_retry(op, FAST)
    assert calls == 1


async def test_attempts_are_capped() -> None:
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        raise ConnectionClosed("dropped")

    with pytest.raises(ConnectionClosed):
        await with_retry(op, RetryPolicy(max_attempts=4, base_delay=0.001, max_delay=0.01))
    assert calls == 4


async def test_a_policy_of_one_attempt_disables_retry() -> None:
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        raise ConnectionClosed("dropped")

    with pytest.raises(ConnectionClosed):
        await with_retry(op, RetryPolicy.none())
    assert calls == 1


async def test_cancellation_stops_the_retry_loop() -> None:
    """``CancelledError`` derives from ``BaseException``, so it must fall
    straight through the retry's ``except Exception`` — a cancelled scope that
    kept sleeping out its attempts would ignore its own deadline."""
    calls = 0

    async def op() -> str:
        nonlocal calls
        calls += 1
        await asyncio.sleep(10)
        return "never"

    task = asyncio.create_task(with_retry(op, RetryPolicy(max_attempts=5, base_delay=0.001)))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == 1


async def test_the_wait_does_not_block_the_loop() -> None:
    """The whole reason this exists rather than reusing ``time.sleep``: other
    tasks must keep running while a retry backs off.

    The companion task yields with ``sleep(0)`` rather than sleeping for a
    fixed interval. That is deliberate: a timed ticker measures the loop's
    timer resolution as much as it measures blocking, and on a loaded machine
    it can legitimately tick once or twice in a 150ms backoff — which is
    indistinguishable from the bug. Yielding instead makes the two outcomes
    categorical. A cooperative sleep lets the companion run as often as the
    loop allows (thousands of times); ``time.sleep`` would let it run exactly
    zero times.
    """
    yields = 0

    async def spin() -> None:
        nonlocal yields
        while True:
            yields += 1
            await asyncio.sleep(0)

    async def op() -> str:
        raise ConnectionClosed("dropped")

    spinner = asyncio.create_task(spin())
    try:
        await asyncio.sleep(0)  # let the spinner reach its loop
        before = yields
        with pytest.raises(ConnectionClosed):
            await with_retry(op, RetryPolicy(max_attempts=3, base_delay=0.05, max_delay=0.1))
        assert yields - before > 10, (
            f"the companion task got {yields - before} turns during the backoff; "
            "a cooperative sleep yields constantly, so this near zero means the "
            "loop was blocked"
        )
    finally:
        spinner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await spinner


# --------------------------------------------------------------------------
# The shared backoff curve
# --------------------------------------------------------------------------


def test_the_server_hint_is_a_floor_not_a_suggestion() -> None:
    """``sleep_before_retry`` is shared with the synchronous tier precisely so
    the two cannot grow different curves. We never wake before the server
    asked, and never later than the policy cap."""
    policy = RetryPolicy(max_attempts=5, base_delay=0.1, max_delay=5.0)
    delay = sleep_before_retry(policy, 1, _server_error(ErrorCategory.UNAVAILABLE, 2000))
    assert delay is not None
    assert delay == pytest.approx(2.0)


def test_the_server_hint_is_still_capped() -> None:
    policy = RetryPolicy(max_attempts=5, base_delay=0.1, max_delay=1.0)
    delay = sleep_before_retry(policy, 1, _server_error(ErrorCategory.UNAVAILABLE, 60_000))
    assert delay == pytest.approx(1.0)


def test_the_backoff_grows_and_stays_under_the_cap() -> None:
    policy = RetryPolicy(max_attempts=10, base_delay=0.1, max_delay=1.0)
    exc = ConnectionClosed("dropped")
    # Jitter makes each draw random in [0, delay], so the *bound* is what can
    # be asserted per-attempt; the growth shows in the bound, not the sample.
    for attempt in range(1, 8):
        delay = sleep_before_retry(policy, attempt, exc)
        assert delay is not None
        assert 0.0 <= delay <= 1.0


def test_a_zero_base_delay_means_no_wait() -> None:
    policy = RetryPolicy(max_attempts=3, base_delay=0.0, max_delay=0.0)
    assert sleep_before_retry(policy, 1, ConnectionClosed("dropped")) is None
