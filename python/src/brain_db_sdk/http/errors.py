"""The one error type the HTTP client raises."""

from __future__ import annotations


class BrainHttpError(Exception):
    """A Brain HTTP edge failure.

    Mirrors the Rust ``BrainHttpError`` and TypeScript ``BrainHttpError``:
    ``status`` (int, ``0`` for transport failures), ``code`` (str), ``message``.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        # A server `Retry-After` hint in SECONDS, when the response carried one
        # and it was in the integer form. Declared here rather than attached
        # dynamically at the raise site: the retry scheduler read it back with
        # `getattr(err, "retry_after", None)`, so a rename or a typo on either
        # side would silently fall back to the computed backoff and nothing
        # would fail. Rust and TypeScript spell the same hint `retry_after_ms`
        # in milliseconds; seconds is what `time.sleep` takes.
        self.retry_after: float | None = None
