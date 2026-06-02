"""Client error taxonomy.

Every connection operation raises a [`BrainError`] (or a subclass) on
failure. The subclasses separate the layers a caller reacts to
differently: a protocol-sequence violation, a structured error the server
returned, version negotiation failure, a clean peer close, and a timeout.
Frame-codec failures keep raising :class:`~brain_db_sdk.wire.frame.FrameError`
(a corrupt frame is fatal for the connection); CBOR failures raise from
``cbor2``. :func:`is_retryable` reads the server category so a future retry
policy can branch on it.
"""

from __future__ import annotations

from .wire.types import ErrorResponse

# Error categories that a retry could plausibly clear (mirrors the wire
# ``ErrorCategory`` discriminants: ResourceExhausted = 6, Unavailable = 8).
_CATEGORY_RESOURCE_EXHAUSTED = 6
_CATEGORY_UNAVAILABLE = 8


class BrainError(Exception):
    """Base class for every client-side failure."""


class ProtocolError(BrainError):
    """The peer broke the protocol sequence — e.g. an unexpected opcode
    where the handshake expects WELCOME, or a response on an unknown
    stream."""


class ConnectionClosed(BrainError):
    """The peer closed the connection (a read returned zero bytes)."""


class BrainTimeout(BrainError):
    """An operation did not complete within its deadline."""

    def __init__(self, timeout: float | None) -> None:
        super().__init__(f"operation timed out after {timeout}s")
        self.timeout = timeout


class VersionMismatch(BrainError):
    """The server chose a wire version the client did not offer."""

    def __init__(self, chosen: int, supported: list[int]) -> None:
        super().__init__(
            f"version mismatch: server chose {chosen}, client supports {supported}"
        )
        self.chosen = chosen
        self.supported = supported


class ServerError(BrainError):
    """The server returned a structured ERROR frame. The full payload is
    preserved for code/category branching and ``retry_after_ms``."""

    def __init__(self, response: ErrorResponse) -> None:
        super().__init__(
            f"server error [code={response.code:#06x} category={response.category}]: "
            f"{response.message}"
        )
        self.code = response.code
        self.category = response.category
        self.message = response.message
        self.retry_after_ms = response.retry_after_ms
        self.response = response


def is_retryable(exc: BaseException) -> bool:
    """Whether retrying the operation could plausibly succeed. A transient
    transport drop or timeout, or a resource-exhaustion / unavailable
    server verdict, is retryable; a malformed-input or auth verdict is
    not. The full retry policy is a later phase; this is its category
    signal."""
    if isinstance(exc, (ConnectionClosed, BrainTimeout, OSError)):
        return True
    if isinstance(exc, ServerError):
        return exc.category in (_CATEGORY_RESOURCE_EXHAUSTED, _CATEGORY_UNAVAILABLE)
    return False


__all__ = [
    "BrainError",
    "ProtocolError",
    "ConnectionClosed",
    "BrainTimeout",
    "VersionMismatch",
    "ServerError",
    "is_retryable",
]
