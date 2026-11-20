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
#
# This is an ALLOWLIST on purpose. Every other category -- including one this
# build has never heard of -- is non-retryable. Do not turn it into a denylist
# of terminal categories: the server adds categories over time, and a denylist
# would make each new one retryable by default, which is the worst possible
# default because a category that is new *and* terminal would be retried
# forever. ``OperatorIntervention = 9`` is exactly that case, and it is
# correctly non-retryable here without needing an entry.
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


class LlmCredentialMissing(ServerError):
    """The write's namespace has no usable LLM provider credential — BYOK is
    configured but this tenant has not registered a key (wire code ``0x0066``).

    **Terminal.** Retrying cannot create a key; the fix is to register one.
    Brain refuses the write rather than storing a memory it cannot ground:
    HyPE and extraction are mandatory, so an admitted write would land as text
    with no questions, entities or statements and recall would quietly degrade.

    Carries category ``Conflict``, so :func:`is_retryable` returns ``False``.
    """


class ShardStorageFaulted(ServerError):
    """The shard's write-ahead log latched into a terminal faulted state
    (wire code ``0x00A0``, category ``OPERATOR_INTERVENTION``).

    **Terminal, and not transient.** The shard keeps answering this way until
    its process is restarted, so retrying cannot make progress -- only
    operator action clears it. :func:`is_retryable` returns ``False``.

    Deliberately distinct from the ``Unavailable``-category shard errors
    (``ShardUnavailable`` / ``Restarting`` / ``Maintenance``), which *do* clear
    on their own. Surface this one to a human as an outage needing attention
    rather than as a blip, and do not fold it into a generic "server busy"
    path.
    """


class LlmCredentialUnavailable(ServerError):
    """The namespace's LLM credential could not be resolved right now — the
    credential broker is unreachable, timed out, or returned a transient error
    (wire code ``0x0095``).

    **Retryable**, and deliberately distinct from :class:`LlmCredentialMissing`:
    collapsing the two would make a broker blip look like a permanently
    unconfigured tenant and fail writes that should have succeeded on retry.
    """


# Wire error code -> ServerError subclass. Codes not listed here surface as the
# base ``ServerError``.
_CODE_TO_ERROR: dict[int, type[ServerError]] = {
    ErrorCode.ACT_AS_DENIED: ActAsDenied,
    ErrorCode.LLM_CREDENTIAL_MISSING: LlmCredentialMissing,
    ErrorCode.LLM_CREDENTIAL_UNAVAILABLE: LlmCredentialUnavailable,
    ErrorCode.SHARD_STORAGE_FAULTED: ShardStorageFaulted,
}


def invalid_field(exc: BaseException) -> str | None:
    """For a validation refusal, the name of the request field the server
    rejected -- ``"text"``, ``"vector"``, and so on -- or ``None`` when this is
    not an ``InvalidArgument`` or the server named no field.

    ``InvalidArgument`` (``0x0040``) is now the *only* code for a field-level
    refusal. Nine narrower codes used to carry that information in the code
    itself and were removed; the conditions they named now arrive as
    ``InvalidArgument`` with the field in ``ErrorDetails.field``:

    ==========================================================  ===================
    condition                                                   field
    ==========================================================  ===================
    ``text`` empty or over the size cap                         ``"text"``
    a client tried to set a memory ``kind``                     ``"kind"``
    vector wrong dimension, non-finite, or wrong L2 norm        ``"vector"``
    ``model_fingerprint`` mismatch                              ``"model_fingerprint"``
    plan or reason budget out of range                          that budget's name
    ==========================================================  ===================

    So code that read ``if exc.code == TEXT_TOO_LARGE`` becomes
    ``if invalid_field(exc) == "text"``. Treat the set of field names as open:
    match the ones you handle and fall back to ``exc.message`` for the rest,
    rather than assuming the table above is exhaustive forever.
    """
    if not isinstance(exc, ServerError):
        return None
    if exc.code != ErrorCode.INVALID_ARGUMENT:
        return None
    details = exc.response.details
    return None if details is None else details.field


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
    "LlmCredentialMissing",
    "LlmCredentialUnavailable",
    "ProtocolError",
    "ServerError",
    "ShardStorageFaulted",
    "VersionMismatch",
    "invalid_field",
    "is_retryable",
]
