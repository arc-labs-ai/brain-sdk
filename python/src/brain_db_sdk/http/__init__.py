"""The HTTP tier of the Brain SDK — :class:`BrainHttpClient` + contract types.

Talks JSON to the Brain HTTP edge (``brain-edge`` self-hosted, or the Arc cloud
gateway). The native wire client is :class:`brain_db_sdk.BrainClient`.
"""

from __future__ import annotations

from .client import DEFAULT_BASE_URL, BrainHttpClient
from .errors import BrainHttpError
from .retry import HttpRetryPolicy
from .types import (
    Capabilities,
    EncodeResult,
    ForgetResult,
    InferenceStep,
    LinkResult,
    MemoryHit,
    Permissions,
    PlanResult,
    PlanStep,
    ReasonResult,
    RecallResult,
    UnlinkResult,
    Whoami,
)

__all__ = [
    "BrainHttpClient",
    "BrainHttpError",
    "HttpRetryPolicy",
    "DEFAULT_BASE_URL",
    "Capabilities",
    "EncodeResult",
    "ForgetResult",
    "InferenceStep",
    "LinkResult",
    "MemoryHit",
    "Permissions",
    "PlanResult",
    "PlanStep",
    "ReasonResult",
    "RecallResult",
    "UnlinkResult",
    "Whoami",
]
