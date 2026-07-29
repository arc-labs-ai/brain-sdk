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

from .wire.types import ErrorCode, ErrorResponse

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
        super().__init__(f"version mismatch: server chose {chosen}, client supports {supported}")
        self.chosen = chosen
        self.supported = supported


class ServerError(BrainError):
    """The server returned a structured ERROR frame. The full payload is
    preserved for code/category branching and ``retry_after_ms``.

    Construct via :meth:`from_response` to get the most specific subclass for
    the wire ``code`` (e.g. :class:`ActAsDenied`); calling ``ServerError(...)``
    directly always yields the base class.
    """

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

    @staticmethod
    def from_response(response: ErrorResponse) -> ServerError:
        """Build the most specific :class:`ServerError` subclass for the wire
        ``code``, falling back to the base class for unmapped codes."""
        subclass = _CODE_TO_ERROR.get(response.code, ServerError)
        return subclass(response)


class ActAsDenied(ServerError):
    """The connection principal is not entitled to run the op under the
    per-request ``act_as`` identity — it lacks ``can_act_as`` or the requested
    namespace is outside its allowlist (wire code ``0x0033``)."""


# Wire error code -> ServerError subclass. Codes not listed here surface as the
# base ``ServerError``.
_CODE_TO_ERROR: dict[int, type[ServerError]] = {
    ErrorCode.ACT_AS_DENIED: ActAsDenied,
}


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
    "ActAsDenied",
    "BrainError",
    "BrainTimeout",
    "ConnectionClosed",
    "ProtocolError",
    "ServerError",
    "VersionMismatch",
    "is_retryable",
]
