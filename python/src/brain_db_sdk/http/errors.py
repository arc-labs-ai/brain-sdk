"""The one error type the HTTP client raises."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class FieldError:
    """One per-field problem from a validation failure.

    The cloud gateway reports these in the ``errors[]`` array of its RFC 9457
    ``application/problem+json`` body.
    """

    field: str
    message: str
    #: A stable per-field code, when the server sends one.
    code: Optional[str] = None


class BrainHttpError(Exception):
    """A Brain HTTP edge failure.

    Mirrors the Rust ``BrainHttpError`` and TypeScript ``BrainHttpError``:
    ``status`` (int, ``0`` for transport failures), ``code`` (str), ``message``.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field_errors: Sequence[FieldError] = (),
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        #: Per-field problems on a validation failure, when the server reports
        #: them. Empty otherwise — including against an edge, which answers with
        #: the ``{"error": {code, message}}`` envelope and no field detail.
        self.field_errors: tuple[FieldError, ...] = tuple(field_errors)
        # A server `Retry-After` hint in SECONDS, when the response carried one
        # and it was in the integer form. Declared here rather than attached
        # dynamically at the raise site: the retry scheduler read it back with
        # `getattr(err, "retry_after", None)`, so a rename or a typo on either
        # side would silently fall back to the computed backoff and nothing
        # would fail. Rust and TypeScript spell the same hint `retry_after_ms`
        # in milliseconds; seconds is what `time.sleep` takes.
        self.retry_after: float | None = None
