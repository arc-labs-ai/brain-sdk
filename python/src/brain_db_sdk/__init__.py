"""brain-db-sdk — Python client for the Brain memory database.

Brain ships no client library; its contract is the wire protocol (a
32-byte ``BRN0`` frame header + CBOR payloads over TCP). This package
re-implements that protocol independently — the spec, not a shared
library, is the source of truth — and is verified byte-for-byte against
Brain's conformance corpus.

Status: the wire codec (L1 frame + L2 CBOR payload + typed payloads) is
corpus-verified, and on top of it a synchronous connection layer —
transport, handshake, a multiplexed :class:`MuxConnection`, a high-level
:class:`BrainClient` serving the full v1 + typed-graph verb surface
(encode, recall, forget, link, the entity / statement / relation / schema
graph ops, transactions, and subscriptions), a connection
:class:`Pool`, and a retry helper.
"""

from __future__ import annotations

__version__ = "0.1.0"

from . import wire  # noqa: F401
from .client import (
    Auth,
    BrainClient,
    ClientConfig,
    ConnectionInfo,
    derive_space_id,
    new_id,
)
from .mux import HandshakeOutcome, MuxConnection, Subscription
from .pool import Pool
from .retry import RetryPolicy, with_retry
from .verbs import EncodeBuilder, ForgetBuilder, RecallBuilder
from .wire.types import AnswerKind, RecallAnswer, WaitMode
from .errors import (
    ActAsDenied,
    BrainError,
    BrainTimeout,
    ConnectionClosed,
    ProtocolError,
    ServerError,
    VersionMismatch,
    is_retryable,
)

# HTTP tier — the hosted-edge client (talks to `brain-edge` / the Arc gateway).
from . import http  # noqa: F401
from .http import BrainHttpClient, BrainHttpError

__all__ = [
    "wire",
    "BrainClient",
    "ClientConfig",
    "ConnectionInfo",
    "Auth",
    "new_id",
    "derive_space_id",
    "HandshakeOutcome",
    "MuxConnection",
    "Subscription",
    "Pool",
    "EncodeBuilder",
    "RecallBuilder",
    "ForgetBuilder",
    "RecallAnswer",
    "AnswerKind",
    "WaitMode",
    "RetryPolicy",
    "with_retry",
    "BrainError",
    "ProtocolError",
    "ConnectionClosed",
    "BrainTimeout",
    "VersionMismatch",
    "ServerError",
    "ActAsDenied",
    "is_retryable",
]
