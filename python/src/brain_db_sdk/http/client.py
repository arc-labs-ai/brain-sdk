"""``BrainHttpClient`` — the synchronous HTTP tier of the Brain SDK.

Talks JSON to the Brain HTTP edge (``brain-edge`` self-hosted, or the Arc cloud
gateway). Same verb surface and field names as the Rust and TypeScript HTTP
clients. For the native wire protocol (streaming, transactions, typed-graph
management), use :class:`brain_db_sdk.BrainClient` instead.

Zero third-party dependencies — built on :mod:`urllib.request`.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Mapping, Optional

from .errors import BrainHttpError
from .retry import HttpRetryPolicy
from .types import (
    Capabilities,
    EncodeResult,
    ForgetResult,
    LinkResult,
    PlanResult,
    ReasonResult,
    RecallResult,
    UnlinkResult,
    Whoami,
)

DEFAULT_BASE_URL = "http://127.0.0.1:8080"


class BrainHttpClient:
    """A synchronous HTTP client for the Brain edge."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        retry: Optional[HttpRetryPolicy] = None,
    ) -> None:
        if not api_key:
            raise BrainHttpError(0, "config", "api_key is required")
        self._base = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._retry = retry if retry is not None else HttpRetryPolicy()

    # --- verbs ------------------------------------------------------------

    def encode(
        self,
        text: str,
        context: Optional[int] = None,
        occurred_at: Optional[int] = None,
    ) -> EncodeResult:
        """Store a memory."""
        body = _compact({"text": text, "context": context, "occurred_at": occurred_at})
        return EncodeResult.from_dict(
            self._request("POST", "/v1/memories", body, idempotent=True)
        )

    def recall(
        self,
        query: str,
        max_results: Optional[int] = None,
        subject: Optional[str] = None,
    ) -> RecallResult:
        """Recall memories for a cue."""
        body = _compact({"query": query, "max_results": max_results, "subject": subject})
        return RecallResult.from_dict(self._request("POST", "/v1/recall", body))

    def forget(self, memory_id: str, hard: bool = False) -> ForgetResult:
        """Forget a memory."""
        return ForgetResult.from_dict(
            self._request("DELETE", "/v1/memories", {"memory_id": memory_id, "hard": hard})
        )

    def link(
        self,
        source: str,
        target: str,
        kind: str,
        weight: Optional[float] = None,
    ) -> LinkResult:
        """Create/overwrite a directed edge between two memories."""
        body = _compact({"source": source, "target": target, "kind": kind, "weight": weight})
        return LinkResult.from_dict(self._request("POST", "/v1/links", body))

    def unlink(self, source: str, target: str, kind: str) -> UnlinkResult:
        """Remove a directed edge (idempotent)."""
        body = {"source": source, "target": target, "kind": kind}
        return UnlinkResult.from_dict(self._request("DELETE", "/v1/links", body))

    def plan(
        self,
        start: Mapping[str, str],
        goal: Mapping[str, str],
        max_steps: Optional[int] = None,
        max_wall_time_ms: Optional[int] = None,
        max_branches: Optional[int] = None,
        strategy: Optional[str] = None,
    ) -> PlanResult:
        """Plan a path from a start state to a goal state.

        ``start`` / ``goal`` are ``{"text": ...}`` or ``{"memory_id": ...}``.
        """
        body = _compact(
            {
                "start": dict(start),
                "goal": dict(goal),
                "max_steps": max_steps,
                "max_wall_time_ms": max_wall_time_ms,
                "max_branches": max_branches,
                "strategy": strategy,
            }
        )
        return PlanResult.from_dict(self._request("POST", "/v1/plan", body))

    def reason(
        self,
        observation: Mapping[str, str],
        depth: Optional[int] = None,
        confidence_threshold: Optional[float] = None,
        max_inferences: Optional[int] = None,
        budget_wall_time_ms: Optional[int] = None,
    ) -> ReasonResult:
        """Infer over the graph from an observation.

        ``observation`` is ``{"text": ...}`` or ``{"memory_id": ...}``.
        """
        body = _compact(
            {
                "observation": dict(observation),
                "depth": depth,
                "confidence_threshold": confidence_threshold,
                "max_inferences": max_inferences,
                "budget_wall_time_ms": budget_wall_time_ms,
            }
        )
        return ReasonResult.from_dict(self._request("POST", "/v1/reason", body))

    def whoami(self) -> Whoami:
        """The identity Brain resolves from the credential."""
        return Whoami.from_dict(self._request("GET", "/v1/whoami", idempotent=True))

    def capabilities(self) -> Capabilities:
        """What the connected shard supports."""
        return Capabilities.from_dict(
            self._request("GET", "/v1/capabilities", idempotent=True)
        )

    # --- transport --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        idempotent: bool = False,
    ) -> dict[str, Any]:
        """Send the request, retrying idempotent verbs per the policy on ``503``
        and transport/timeout failures. Non-idempotent verbs run exactly once."""
        attempt = 1
        while True:
            try:
                return self._request_once(method, path, body)
            except BrainHttpError as err:
                if idempotent and self._retry.should_retry(attempt, err):
                    delay = self._retry.backoff(attempt, getattr(err, "retry_after", None))
                    time.sleep(delay)
                    attempt += 1
                    continue
                raise

    def _request_once(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        url = self._base + path
        data = json.dumps(body).encode() if body is not None else None
        headers = {"authorization": f"Bearer {self._api_key}"}
        if data is not None:
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                text = resp.read().decode()
        except urllib.error.HTTPError as e:
            raise self._error_from(e) from None
        except urllib.error.URLError as e:
            raise BrainHttpError(0, "transport", f"request to {url} failed: {e.reason}") from None
        except (TimeoutError, OSError) as e:
            # A body-read timeout (past the connect handled by URLError above) or
            # a low-level socket error surfaces as transport, never a native raise.
            raise BrainHttpError(0, "transport", f"request to {url} failed: {e}") from None

        return json.loads(text) if text else {}

    @staticmethod
    def _error_from(e: "urllib.error.HTTPError") -> BrainHttpError:
        code, message = "http_error", f"HTTP {e.code}"
        try:
            payload = json.loads(e.read().decode())
            err = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(err, dict):
                code = err.get("code", code)
                message = err.get("message", message)
        except Exception:  # noqa: BLE001 - best-effort error body parse
            pass
        out = BrainHttpError(e.code, code, message)
        # Attach a server Retry-After hint (integer seconds) for the retry
        # scheduler. Not part of the public {status, code, message} shape.
        out.retry_after = _parse_retry_after(e)
        return out


def _compact(d: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so optional fields are omitted from the body."""
    return {k: v for k, v in d.items() if v is not None}


def _parse_retry_after(e: "urllib.error.HTTPError") -> Optional[float]:
    """A ``Retry-After`` header expressed as integer seconds, else ``None``
    (HTTP-date form is ignored, leaving the computed backoff in force)."""
    try:
        raw = e.headers.get("Retry-After") if e.headers is not None else None
        if raw is not None:
            return float(int(raw.strip()))
    except (ValueError, AttributeError):
        pass
    return None
