"""brain-db-sdk — Python client for the Brain memory database.

Brain ships no client library; its contract is the wire protocol (a
32-byte ``BRN0`` frame header + CBOR payloads over TCP). This package
re-implements that protocol independently — the spec, not a shared
library, is the source of truth — and is verified byte-for-byte against
Brain's conformance corpus.

Status: the wire codec (L1 frame + L2 CBOR payload + typed payloads) is
corpus-verified, and on top of it a synchronous connection layer — transport,
handshake, a multiplexed :class:`MuxConnection`, a high-level
:class:`BrainClient` serving the full v1 + typed-graph verb surface
(encode, recall, forget, link, the entity / statement / relation / schema
graph ops, transactions, and subscriptions), a connection
:class:`Pool`, and a retry helper.

"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _metadata_version

# Read from the installed distribution rather than written here, because the
# two had silently diverged: the package shipped as 0.3.1 while this attribute
# still said 0.1.0, so anything branching on it — a user's compatibility check,
# a bug report, a telemetry tag — read a version that had not existed for two
# releases. `pyproject.toml` is the single place release-please bumps, and this
# now cannot disagree with it.
#
# The fallback covers running straight from a source tree with nothing
# installed (the repo's own `pytest` does this), where there is no distribution
# metadata to read. `tests/version/` pins both branches.
try:
    __version__ = _metadata_version("brain-db-sdk")
except PackageNotFoundError:  # pragma: no cover — only when run uninstalled
    __version__ = "0.0.0+unknown"

# HTTP tier — the hosted-edge client (talks to `brain-edge` / the Arc gateway).
from . import (
    http,
    wire,
)
from .client import (
    Auth,
    BrainClient,
    ClientConfig,
    ConnectionInfo,
    derive_space_id,
    new_id,
)
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
from .http import BrainHttpClient, BrainHttpError
from .mux import HandshakeOutcome, MuxConnection, Subscription
from .pool import Pool
from .retry import RetryPolicy, with_retry
from .verbs import EncodeBuilder, ForgetBuilder, RecallBuilder
from .wire.types import AnswerKind, RecallAnswer, RecallScope, WaitMode

__all__ = [
    "wire",
    # The HTTP tier was imported here for re-export but never listed, so
    # `from brain_db_sdk import *` did not carry it and strict type checkers
    # treated it as a private re-export for downstream users.
    "http",
    "BrainHttpClient",
    "BrainHttpError",
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
    "RecallScope",
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
