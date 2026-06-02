"""brain-db-sdk — Python client for the Brain memory database.

Brain ships no client library; its contract is the wire protocol (a
32-byte ``BRN0`` frame header + CBOR payloads over TCP). This package
re-implements that protocol independently — the spec, not a shared
library, is the source of truth — and is verified byte-for-byte against
Brain's conformance corpus.

Status: the wire codec (L1 frame + L2 CBOR payload + typed payloads) is
corpus-verified, and on top of it a synchronous connection layer —
transport, handshake, a multiplexed :class:`MuxConnection`, a high-level
:class:`BrainClient` (connect / handshake / encode / recall / forget), a
connection :class:`Pool`, and a retry helper.
"""

from __future__ import annotations

__version__ = "0.1.0"

from . import wire  # noqa: F401
from .client import Auth, BrainClient, ClientConfig, SessionInfo, new_id
from .connection import Connection, HandshakeOutcome
from .mux import MuxConnection
from .pool import Pool
from .retry import RetryPolicy, with_retry
from .verbs import EncodeBuilder, ForgetBuilder, RecallBuilder
from .errors import (
    BrainError,
    BrainTimeout,
    ConnectionClosed,
    ProtocolError,
    ServerError,
    VersionMismatch,
    is_retryable,
)

__all__ = [
    "wire",
    "BrainClient",
    "ClientConfig",
    "SessionInfo",
    "Auth",
    "new_id",
    "Connection",
    "HandshakeOutcome",
    "MuxConnection",
    "Pool",
    "EncodeBuilder",
    "RecallBuilder",
    "ForgetBuilder",
    "RetryPolicy",
    "with_retry",
    "BrainError",
    "ProtocolError",
    "ConnectionClosed",
    "BrainTimeout",
    "VersionMismatch",
    "ServerError",
    "is_retryable",
]
