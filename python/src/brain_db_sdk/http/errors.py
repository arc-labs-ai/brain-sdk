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
