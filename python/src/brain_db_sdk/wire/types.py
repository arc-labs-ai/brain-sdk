"""Typed wire payloads: handshake + v1 verbs + the typed-graph ops the
conformance corpus exercises.

Each payload is a dataclass with a ``to_map`` that builds an ordered dict
in the server's field order and a ``from_map`` that rebuilds the
dataclass from a decoded CBOR map. CBOR map encoding is field-order
sensitive and id fields are byte strings, so both are controlled
explicitly here rather than relying on attribute iteration.

Encoding conventions enforced field-by-field:
  * 16-byte ids -> CBOR byte strings (Python ``bytes``). Through Option a
    present id is ``bytes`` and an absent one is ``None``; through a list
    it is a list of ``bytes``.
  * integer-discriminant enums (memory kind, forget mode, auth method,
    retriever, error code/category) -> plain ints.
  * ``StatementKind`` -> the variant-name string ("Fact"/"Preference"/
    "Event"), the one enum the server encodes by name.
  * ``f32`` fields -> rounded through 32-bit precision so the shortest
    half/single form is emitted; ``f64`` fields -> plain float.
  * blob fields (``Vec<u8>`` without a byte-string adapter on the server)
    -> CBOR arrays of ints, not byte strings.
  * embedding vectors -> excluded from the map and appended as a raw
    little-endian f32 trailer at the payload-codec seam.

The seam between a payload value and its on-wire bytes is
``encode_payload`` / ``decode_payload``: they handle the optional
trailing-vector section that only ``EncodeVectorDirectRequest`` carries.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from .cbor import (
    f32_list_to_le_bytes,
    from_cbor,
    from_cbor_prefix,
    le_bytes_to_f32_list,
    mark_f64,
    round_f32,
    to_cbor,
)


# ===========================================================================
# Shared enum discriminants (integer on the wire).
# ===========================================================================


class MemoryKind:
    """The stored kind of a memory record, as its on-wire integer discriminant."""

    EPISODIC = 0
    SEMANTIC = 1
    CONSOLIDATED = 2


class EdgeKind:
    """The relationship kind of a memory-to-memory edge, as its on-wire integer discriminant."""

    CAUSED = 0
    FOLLOWED_BY = 1
    DERIVED_FROM = 2
    SIMILAR_TO = 3
    CONTRADICTS = 4
    SUPPORTS = 5
    REFERENCES = 6
    PART_OF = 7


class ForgetMode:
    """FORGET semantics — soft tombstone vs. hard zero — as its on-wire integer discriminant."""

    SOFT = 0
    HARD = 1


class StageKind:
    """The write-pipeline background stage a subscription event reports, as its on-wire integer discriminant."""

    AUTO_EDGE = 0
    TEMPORAL_EDGE = 1
    EXTRACTOR = 2
    HYPE = 3


class WaitMode:
    """Write-completion mode — how long an ENCODE blocks before it returns,
    as its on-wire integer discriminant.

      * ``ACK`` (the default) returns as soon as the write is durable; the
        async derivation stages run in the background. Omitted from the CBOR
        map, so the common write stays byte-identical to a keyless request.
      * ``DERIVED`` blocks until async derivation completes and the response
        carries the full ``EncodeTrace``. Encoded as the bare integer ``1``.

    The API convention: writes carry ``wait`` (this enum), reads carry
    ``trace`` (a bool). They are never both on one op."""

    ACK = 0
    DERIVED = 1


class AuthMethod:
    """The credential scheme presented at AUTH, as its on-wire integer discriminant."""

    TOKEN = 0
    MTLS = 1


class RetrieverName:
    """Which of the three fused retrievers a result came from, as its on-wire integer discriminant.

    This is the *response*-side value (``MemoryResult.contributing_retrievers``),
    which the server declares with ``serde_repr`` and so encodes as an integer.
    The *request*-side selector is :class:`Retriever` and encodes as a string —
    same three families, two encodings.
    """

    SEMANTIC = 0
    LEXICAL = 1
    GRAPH = 2


class Retriever:
    """Which retriever family to run, as carried in ``RetrieverSelection.explicit``.

    A **string** on the wire. The server's ``RetrieverWire`` uses plain
    ``serde::Serialize`` with ``#[repr(u8)]``; serde ignores ``repr`` and emits
    the variant name, so this is ``"Semantic"`` and not ``0``. See
    :class:`RetrieverName` for the integer-encoded response-side counterpart.
    """

    SEMANTIC = "Semantic"
    LEXICAL = "Lexical"
    GRAPH = "Graph"


class ErrorCategory:
    """The coarse class of an ERROR frame, as its on-wire integer discriminant."""

    PROTOCOL = 0
    AUTHENTICATION = 1
    AUTHORIZATION = 2
    VALIDATION = 3
    NOT_FOUND = 4
    CONFLICT = 5
    RESOURCE_EXHAUSTED = 6
    INTERNAL = 7
    UNAVAILABLE = 8


class ErrorCode:
    """Numeric ``code`` field of an ERROR frame (the fine-grained wire error
    code). Only the codes the SDK reasons about are named here; the full set
    lives in the server's ``ErrorCodeWire``. An ``ErrorResponse.code`` is a
    plain ``int``, so these are equality constants, not an enum.
    """

    # Authorization (category 2).
    PERMISSION_DENIED = 0x0030
    ADMIN_PERMISSION_REQUIRED = 0x0031
    WRONG_SHARD = 0x0032
    # The connection principal is not entitled to run an op under a per-request
    # ``act_as`` identity (missing ``can_act_as`` or namespace outside its
    # allowlist).
    ACT_AS_DENIED = 0x0033


# ===========================================================================
# Handshake.
# ===========================================================================


@dataclass
class HelloCapabilities:
    """Optional-feature flags a peer advertises in the handshake — streaming, zstd compression, and server push."""

    streaming: bool
    compression_zstd: bool
    server_push: bool

    def to_map(self) -> dict:
        return {
            "streaming": self.streaming,
            "compression_zstd": self.compression_zstd,
            "server_push": self.server_push,
        }

    @classmethod
    def from_map(cls, m: dict) -> "HelloCapabilities":
        return cls(m["streaming"], m["compression_zstd"], m["server_push"])


@dataclass
class HelloPayload:
    """HELLO (``0x0001``). The client's opening frame: its id, the protocol versions it speaks, its capability flags, and an optional session-resumption token."""

    client_id: str
    supported_versions: list[int]
    capabilities: HelloCapabilities
    # Reserved for connection resumption; None encodes as CBOR null.
    client_connection_token: Optional[bytes]

    def to_map(self) -> dict:
        return {
            "client_id": self.client_id,
            "supported_versions": list(self.supported_versions),
            "capabilities": self.capabilities.to_map(),
            "client_connection_token": self.client_connection_token,
        }

    @classmethod
    def from_map(cls, m: dict) -> "HelloPayload":
        return cls(
            m["client_id"],
            list(m["supported_versions"]),
            HelloCapabilities.from_map(m["capabilities"]),
            m["client_connection_token"],
        )


@dataclass
class MtlsClaim:
    """An mTLS credential: the peer certificate's fingerprint and the subject it asserts."""

    cert_fingerprint: bytes  # 32-byte byte string
    asserted_subject: str

    def to_map(self) -> dict:
        return {
            "cert_fingerprint": self.cert_fingerprint,
            "asserted_subject": self.asserted_subject,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MtlsClaim":
        return cls(m["cert_fingerprint"], m["asserted_subject"])


@dataclass
class AuthCredentials:
    """Externally-tagged credential variant: ``Token(bytes)`` is a CBOR map
    ``{"Token": [bytes...]}`` (the token is a Vec<u8> array) and ``Mtls`` is
    ``{"Mtls": {claim}}``. A credential is the connection's whole identity, so
    there is no credential-less variant.
    """

    variant: str
    value: object = None

    @classmethod
    def token(cls, raw: bytes) -> "AuthCredentials":
        return cls("Token", list(raw))

    @classmethod
    def mtls(cls, claim: MtlsClaim) -> "AuthCredentials":
        return cls("Mtls", claim)

    def to_cbor_value(self) -> object:
        if self.variant == "Token":
            return {"Token": list(self.value)}
        if self.variant == "Mtls":
            return {"Mtls": self.value.to_map()}
        raise ValueError(f"unknown credential variant {self.variant!r}")

    @classmethod
    def from_cbor_value(cls, v: object) -> "AuthCredentials":
        if isinstance(v, dict) and "Token" in v:
            return cls("Token", list(v["Token"]))
        if isinstance(v, dict) and "Mtls" in v:
            return cls("Mtls", MtlsClaim.from_map(v["Mtls"]))
        raise ValueError(f"unknown credential cbor {v!r}")


@dataclass
class AuthPayload:
    """The AUTH frame. Carries only the method and credential — the credential
    is the connection's whole identity, and the server assigns the space id and
    namespace it resolves to (returned in AUTH_OK). The client never sends a
    space id.
    """

    method: int
    credentials: AuthCredentials

    def to_map(self) -> dict:
        return {
            "method": self.method,
            "credentials": self.credentials.to_cbor_value(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "AuthPayload":
        return cls(
            m["method"],
            AuthCredentials.from_cbor_value(m["credentials"]),
        )


@dataclass
class SpacePermissions:
    """The per-verb capability grants the server resolved for the authenticated agent."""

    can_encode: bool
    can_recall: bool
    can_plan: bool
    can_reason: bool
    can_forget: bool
    can_admin: bool
    # Authorizes the connection to run an op *on behalf of another identity*
    # via the per-request ``act_as`` field. Held only by a trusted service
    # principal (an edge / gateway); a normal agent's key never carries it, and
    # it does not widen what the connection's own agent may do.
    can_act_as: bool = False

    def to_map(self) -> dict:
        return {
            "can_encode": self.can_encode,
            "can_recall": self.can_recall,
            "can_plan": self.can_plan,
            "can_reason": self.can_reason,
            "can_forget": self.can_forget,
            "can_admin": self.can_admin,
            "can_act_as": self.can_act_as,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SpacePermissions":
        return cls(
            m["can_encode"],
            m["can_recall"],
            m["can_plan"],
            m["can_reason"],
            m["can_forget"],
            m["can_admin"],
            # Tolerate older servers that don't emit the field yet.
            m.get("can_act_as", False),
        )


@dataclass
class ServerFeatures:
    """Server-side limits and options surfaced in WELCOME — payload cap, stream cap, idle timeout, and accepted auth methods."""

    max_payload_size: int
    max_concurrent_streams: int
    idle_timeout_seconds: int
    auth_methods: list[int]

    def to_map(self) -> dict:
        return {
            "max_payload_size": self.max_payload_size,
            "max_concurrent_streams": self.max_concurrent_streams,
            "idle_timeout_seconds": self.idle_timeout_seconds,
            "auth_methods": list(self.auth_methods),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ServerFeatures":
        return cls(
            m["max_payload_size"],
            m["max_concurrent_streams"],
            m["idle_timeout_seconds"],
            list(m["auth_methods"]),
        )


@dataclass
class WelcomePayload:
    """WELCOME (``0x0081``). The server's handshake reply: its id, the negotiated version, the connection id, shared capabilities, and server limits."""

    server_id: str
    chosen_version: int
    connection_id: bytes  # 16-byte byte string
    capabilities: HelloCapabilities
    server_features: ServerFeatures

    def to_map(self) -> dict:
        return {
            "server_id": self.server_id,
            "chosen_version": self.chosen_version,
            "connection_id": self.connection_id,
            "capabilities": self.capabilities.to_map(),
            "server_features": self.server_features.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "WelcomePayload":
        return cls(
            m["server_id"],
            m["chosen_version"],
            m["connection_id"],
            HelloCapabilities.from_map(m["capabilities"]),
            ServerFeatures.from_map(m["server_features"]),
        )


@dataclass
class AuthOkPayload:
    """AUTH_OK (``0x0082``). The successful-auth reply: the server-resolved space id (the derived 16-byte storage id), bound shard, granted permissions, resolved namespace, and server clock."""

    space_id: bytes  # 16-byte byte string (derived storage id)
    bound_shard_id: int
    permissions: SpacePermissions
    # Owning tenant the connection resolved to (server-derived from auth).
    # Empty when the connection resolves to the reserved `brain` system
    # namespace. Read-only — the client never sends a namespace.
    namespace: str
    server_time_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "bound_shard_id": self.bound_shard_id,
            "permissions": self.permissions.to_map(),
            "namespace": self.namespace,
            "server_time_unix_nanos": self.server_time_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "AuthOkPayload":
        return cls(
            m["space_id"],
            m["bound_shard_id"],
            SpacePermissions.from_map(m["permissions"]),
            # Tolerate older servers that don't emit the field yet.
            m.get("namespace", ""),
            m["server_time_unix_nanos"],
        )


# ===========================================================================
# Keepalive (PING / PONG / SERVER_PING / CLIENT_PONG).
#
# Map keys are the CBOR field names on the wire and must match the server's
# brain-protocol definitions byte-for-byte. `from_map` tolerates a missing
# timestamp (defaults 0) so a malformed heartbeat still round-trips.
# ===========================================================================


@dataclass
class ByeRequest:
    """BYE (``0x001F``) — end the session cleanly.

    A goodbye is a CBOR map, **not** an empty payload. All three SDKs used to
    send zero bytes here, which the server cannot decode as a ByeRequest; it
    tolerates it today rather than rejecting, but the corpus ``req_bye`` vector
    pins the correct form.

    ``reason`` is written unconditionally, as ``null`` when absent, mirroring
    the server's attribute-free ``Option<String>``. The server accepts an
    omitted field too — serde visits ``none`` for a missing ``Option`` — but
    mirroring keeps the manifest comparison free of exceptions.
    """

    reason: Optional[str] = None

    def to_map(self) -> dict:
        return {"reason": self.reason}

    @classmethod
    def from_map(cls, m: dict) -> "ByeRequest":
        return cls(m.get("reason"))


@dataclass
class PingRequest:
    """PING (0x0010, client->server) — RTT probe."""

    client_timestamp_unix_nanos: int

    def to_map(self) -> dict:
        return {"client_timestamp_unix_nanos": self.client_timestamp_unix_nanos}

    @classmethod
    def from_map(cls, m: dict) -> "PingRequest":
        return cls(m.get("client_timestamp_unix_nanos", 0))


@dataclass
class PongResponse:
    """PONG (0x0090, server->client) — reply to PING."""

    client_timestamp_unix_nanos: int
    server_timestamp_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "client_timestamp_unix_nanos": self.client_timestamp_unix_nanos,
            "server_timestamp_unix_nanos": self.server_timestamp_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "PongResponse":
        return cls(
            m.get("client_timestamp_unix_nanos", 0),
            m.get("server_timestamp_unix_nanos", 0),
        )


@dataclass
class ServerPingResponse:
    """SERVER_PING (0x0091, server->client) — idle-timer heartbeat."""

    server_timestamp_unix_nanos: int

    def to_map(self) -> dict:
        return {"server_timestamp_unix_nanos": self.server_timestamp_unix_nanos}

    @classmethod
    def from_map(cls, m: dict) -> "ServerPingResponse":
        return cls(m.get("server_timestamp_unix_nanos", 0))


@dataclass
class ClientPongRequest:
    """CLIENT_PONG (0x0011, client->server) — reply to SERVER_PING."""

    server_timestamp_unix_nanos: int
    client_timestamp_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "server_timestamp_unix_nanos": self.server_timestamp_unix_nanos,
            "client_timestamp_unix_nanos": self.client_timestamp_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ClientPongRequest":
        return cls(
            m.get("server_timestamp_unix_nanos", 0),
            m.get("client_timestamp_unix_nanos", 0),
        )


# ===========================================================================
# Per-request effective identity (``act_as``).
# ===========================================================================


@dataclass
class ActAs:
    """Per-request effective-identity selector carried on data-plane op
    requests. When present, the op runs as this ``(namespace, space_id)`` on
    behalf of the authenticated connection principal; when absent (the common
    case, omitted on the wire) the op runs as the connection's own key-bound
    identity.

    ``space_id`` is the human-readable structured space string (e.g.
    ``"support-bot:user123"``) and encodes as a CBOR text string; the server
    derives the 16-byte storage id from ``(namespace, space_id)``. An empty
    string selects the key-bound space.

    Honored server-side only when the connection principal holds
    ``can_act_as`` and ``namespace`` lies within its granted allowlist —
    otherwise the op is rejected with ``ActAsDenied``. This is the wire form
    only; the trust model is enforced by the server, not this codec.
    """

    namespace: str
    space_id: str

    def to_map(self) -> dict:
        return {"namespace": self.namespace, "space_id": self.space_id}

    @classmethod
    def from_map(cls, m: dict) -> "ActAs":
        return cls(m["namespace"], m["space_id"])


# ===========================================================================
# ENCODE / ENCODE_VECTOR_DIRECT.
# ===========================================================================


@dataclass
class EdgeRequest:
    """A caller-supplied edge to attach at encode time: target memory, edge kind, and weight."""

    target: int  # u128 MemoryId
    kind: int
    weight: float  # f32

    def to_map(self) -> dict:
        return {
            "target": self.target,
            "kind": self.kind,
            "weight": round_f32(self.weight),
        }

    @classmethod
    def from_map(cls, m: dict) -> "EdgeRequest":
        return cls(m["target"], m["kind"], m["weight"])


@dataclass
class EncodeRequest:
    """ENCODE (``0x0020``). Store a memory from text — the server embeds it. Carries the text, session, idempotency and txn ids, and an optional event time."""

    text: str
    session_id: int  # u64
    request_id: bytes  # 16-byte byte string
    txn_id: Optional[bytes]  # 16-byte byte string or None
    occurred_at_unix_nanos: Optional[int]  # event time, or None
    # Effective identity this encode runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None
    # Write-completion mode. ``WaitMode.ACK`` (the default) is omitted from the
    # CBOR map so the common write stays byte-identical; ``WaitMode.DERIVED``
    # blocks for async derivation and is encoded as the bare integer ``1``,
    # after which the ENCODE_RESP carries a populated ``trace``. Reads use
    # ``trace`` instead — writes never carry it.
    wait: int = WaitMode.ACK
    # Opt out of content dedup and force a distinct memory. Default False: Brain
    # dedupes byte-identical text on ``(space_id, session_id, BLAKE3(text))`` and
    # returns the existing memory (``was_deduplicated = True``) without writing.
    # Set True when the same text is a genuinely distinct observation that must
    # coexist (e.g. the same fact re-stated at a different ``occurred_at``).
    # Omitted from the CBOR map when False so the default path stays
    # byte-identical.
    allow_duplicates: bool = False

    def to_map(self) -> dict:
        m = {
            "text": self.text,
            "session_id": self.session_id,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "occurred_at_unix_nanos": self.occurred_at_unix_nanos,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        if self.wait != WaitMode.ACK:
            m["wait"] = self.wait
        if self.allow_duplicates:
            m["allow_duplicates"] = self.allow_duplicates
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeRequest":
        act_as = m.get("act_as")
        return cls(
            m["text"],
            m["session_id"],
            m["request_id"],
            m["txn_id"],
            m["occurred_at_unix_nanos"],
            None if act_as is None else ActAs.from_map(act_as),
            int(m.get("wait", WaitMode.ACK)),
            bool(m.get("allow_duplicates", False)),
        )


@dataclass
class EncodeVectorDirectRequest:
    """The embedding rides the trailing raw little-endian f32 section, never
    the CBOR map. ``vector`` is excluded from ``to_map`` and reattached by
    ``encode_payload`` / ``decode_payload``.
    """

    text: str
    model_fingerprint: bytes  # 16-byte byte string
    session_id: int
    kind: int
    salience_hint: float  # f32
    edges: list[EdgeRequest]
    request_id: bytes
    txn_id: Optional[bytes]
    deduplicate: bool
    vector: list[float] = field(default_factory=list)

    def to_map(self) -> dict:
        return {
            "text": self.text,
            "model_fingerprint": self.model_fingerprint,
            "session_id": self.session_id,
            "kind": self.kind,
            "salience_hint": round_f32(self.salience_hint),
            "edges": [e.to_map() for e in self.edges],
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "deduplicate": self.deduplicate,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeVectorDirectRequest":
        return cls(
            m["text"],
            m["model_fingerprint"],
            m["session_id"],
            m["kind"],
            m["salience_hint"],
            [EdgeRequest.from_map(e) for e in m["edges"]],
            m["request_id"],
            m["txn_id"],
            m["deduplicate"],
        )


@dataclass
class EncodeResponse:
    """ENCODE_RESP (``0x00A0``). The stored memory's id plus write-path outcome: dedup flag, salience, auto-edge count, LSN, and the pending background stages."""

    memory_id: int  # u128
    was_deduplicated: bool
    salience: float  # f32
    auto_edges_added: int
    lsn: int
    space_id: bytes  # 16-byte byte string (derived storage id)
    session_id: int
    kind: int
    created_at_unix_nanos: int
    edges_out_count: int
    embedding_model_fp: bytes
    pending_stages: list[int]
    has_active_schema: bool
    # Full synchronous write-analysis trace, present only when the request set
    # ``trace = True``; omitted from the CBOR map otherwise.
    trace: Optional["EncodeTrace"] = None

    def to_map(self) -> dict:
        m = {
            "memory_id": self.memory_id,
            "was_deduplicated": self.was_deduplicated,
            "salience": round_f32(self.salience),
            "auto_edges_added": self.auto_edges_added,
            "lsn": self.lsn,
            "space_id": self.space_id,
            "session_id": self.session_id,
            "kind": self.kind,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "edges_out_count": self.edges_out_count,
            "embedding_model_fp": self.embedding_model_fp,
            "pending_stages": list(self.pending_stages),
            "has_active_schema": self.has_active_schema,
        }
        if self.trace is not None:
            m["trace"] = self.trace.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeResponse":
        trace = m.get("trace")
        return cls(
            m["memory_id"],
            m["was_deduplicated"],
            m["salience"],
            m["auto_edges_added"],
            m["lsn"],
            m["space_id"],
            m["session_id"],
            m["kind"],
            m["created_at_unix_nanos"],
            m["edges_out_count"],
            m["embedding_model_fp"],
            list(m["pending_stages"]),
            m["has_active_schema"],
            None if trace is None else EncodeTrace.from_map(trace),
        )


# ===========================================================================
# ENCODE trace (opt-in synchronous write-analysis).
# ===========================================================================


class EncodeTraceStageStatus:
    """Terminal status of one ENCODE-trace phase, as its on-wire integer discriminant."""

    OK = 0
    SKIPPED = 1
    FAILED = 2
    TIMEOUT = 3


@dataclass
class EncodeTraceStage:
    """One phase in an ENCODE-trace timeline: its name, terminal status, latency (µs), and a free-form detail string."""

    name: str
    status: int
    latency_us: int
    detail: str
    # The concrete data this stage produced (embed -> vector, persist ->
    # record, extractor -> graph, ...). Present only when the caller set
    # ``trace = True`` and the stage produced inspectable output; omitted from
    # the CBOR map otherwise so existing traces stay byte-identical.
    artifact: Optional["EncodeStageArtifact"] = None

    def to_map(self) -> dict:
        m = {
            "name": self.name,
            "status": self.status,
            "latency_us": self.latency_us,
            "detail": self.detail,
        }
        if self.artifact is not None:
            m["artifact"] = self.artifact.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceStage":
        artifact = m.get("artifact")
        return cls(
            m["name"],
            m["status"],
            m["latency_us"],
            m["detail"],
            None if artifact is None else EncodeStageArtifact.from_map(artifact),
        )


@dataclass
class EncodeTraceEntity:
    """One entity artifact an ENCODE produced: its id, name, and schema type qname."""

    id: bytes  # 16-byte byte string
    name: str
    type_qname: str

    def to_map(self) -> dict:
        return {"id": self.id, "name": self.name, "type_qname": self.type_qname}

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceEntity":
        return cls(m["id"], m["name"], m["type_qname"])


@dataclass
class EncodeTraceStatement:
    """One statement artifact an ENCODE produced, flattened to display strings plus its confidence."""

    id: bytes  # 16-byte byte string
    subject_name: str
    predicate: str
    object_name: str
    confidence: float  # f32
    # When the statement's EVENT happened, in unix nanos. Omitted from the
    # wire map for a statement with no event time.
    event_at_unix_nanos: Optional[int] = None

    def to_map(self) -> dict:
        m: dict = {
            "id": self.id,
            "subject_name": self.subject_name,
            "predicate": self.predicate,
            "object_name": self.object_name,
            "confidence": round_f32(self.confidence),
        }
        if self.event_at_unix_nanos is not None:
            m["event_at_unix_nanos"] = self.event_at_unix_nanos
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceStatement":
        return cls(
            m["id"],
            m["subject_name"],
            m["predicate"],
            m["object_name"],
            m["confidence"],
            m.get("event_at_unix_nanos"),
        )


@dataclass
class EncodeTraceRelation:
    """One relation artifact an ENCODE produced: the two endpoint names and the connecting predicate."""

    source_name: str
    predicate: str
    target_name: str

    def to_map(self) -> dict:
        return {
            "source_name": self.source_name,
            "predicate": self.predicate,
            "target_name": self.target_name,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceRelation":
        return cls(m["source_name"], m["predicate"], m["target_name"])


@dataclass
class EncodeTraceIndex:
    """One index the write landed in, with the outcome status (an ``EncodeTraceStageStatus`` int)."""

    name: str
    status: int

    def to_map(self) -> dict:
        return {"name": self.name, "status": self.status}

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceIndex":
        return cls(m["name"], m["status"])


@dataclass
class EncodeTraceDedup:
    """The dedup verdict carried on an ENCODE trace: whether the write deduplicated and, if so, the matched memory id."""

    was_deduplicated: bool
    matched_memory_id: Optional[bytes]  # 16-byte byte string or None

    def to_map(self) -> dict:
        return {
            "was_deduplicated": self.was_deduplicated,
            "matched_memory_id": self.matched_memory_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceDedup":
        return cls(m["was_deduplicated"], m["matched_memory_id"])


@dataclass
class EncodeTraceArtifacts:
    """What an ENCODE produced, resolved after the async stages drained — entities, statements, relations, indexes, and the dedup verdict."""

    entities: list[EncodeTraceEntity]
    statements: list[EncodeTraceStatement]
    relations: list[EncodeTraceRelation]
    indexes: list[EncodeTraceIndex]
    dedup: EncodeTraceDedup

    def to_map(self) -> dict:
        return {
            "entities": [e.to_map() for e in self.entities],
            "statements": [s.to_map() for s in self.statements],
            "relations": [r.to_map() for r in self.relations],
            "indexes": [i.to_map() for i in self.indexes],
            "dedup": self.dedup.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTraceArtifacts":
        return cls(
            [EncodeTraceEntity.from_map(e) for e in m["entities"]],
            [EncodeTraceStatement.from_map(s) for s in m["statements"]],
            [EncodeTraceRelation.from_map(r) for r in m["relations"]],
            [EncodeTraceIndex.from_map(i) for i in m["indexes"]],
            EncodeTraceDedup.from_map(m["dedup"]),
        )


@dataclass
class EncodeTrace:
    """Full synchronous write-analysis trace for one ENCODE (present when the request set ``trace = True``): the per-phase timeline, the produced artifacts, and total latency (µs)."""

    stages: list[EncodeTraceStage]
    artifacts: EncodeTraceArtifacts
    total_latency_us: int

    def to_map(self) -> dict:
        return {
            "stages": [s.to_map() for s in self.stages],
            "artifacts": self.artifacts.to_map(),
            "total_latency_us": self.total_latency_us,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeTrace":
        return cls(
            [EncodeTraceStage.from_map(s) for s in m["stages"]],
            EncodeTraceArtifacts.from_map(m["artifacts"]),
            m["total_latency_us"],
        )


# ===========================================================================
# Per-stage write artifacts — the concrete data each ENCODE stage produced.
#
# Shared shape for the live ``trace = true`` per-stage ``artifact`` AND the
# durable MEMORY_INSPECT bundle. Every ``EncodeStageArtifact`` field is
# optional and omitted from the CBOR map when empty/absent, matching the
# server's ``skip_serializing_if``: ``vector`` when empty, ``record`` when
# None, ``hype_questions`` when empty, ``keyword_fields`` when empty,
# ``graph`` when None. Field order: vector, record, hype_questions,
# keyword_fields, graph.
# ===========================================================================


@dataclass
class EncodeStageRecord:
    """The durable metadata row a ``persist`` stage wrote."""

    memory_id: bytes  # 16-byte byte string
    kind: int  # u8
    salience: float  # f32
    created_at_unix_nanos: int  # u64
    occurred_at_unix_nanos: int  # u64
    vector_dim: int  # u32
    text_len: int  # u32
    lsn: int  # u64

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "kind": self.kind,
            "salience": round_f32(self.salience),
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "occurred_at_unix_nanos": self.occurred_at_unix_nanos,
            "vector_dim": self.vector_dim,
            "text_len": self.text_len,
            "lsn": self.lsn,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeStageRecord":
        return cls(
            m["memory_id"],
            m["kind"],
            m["salience"],
            m["created_at_unix_nanos"],
            m["occurred_at_unix_nanos"],
            m["vector_dim"],
            m["text_len"],
            m["lsn"],
        )


@dataclass
class EncodeStageKeywordField:
    """One text-index field and the analyzed terms the write produced for it."""

    field: str
    terms: list[str]

    def to_map(self) -> dict:
        return {"field": self.field, "terms": list(self.terms)}

    @classmethod
    def from_map(cls, m: dict) -> "EncodeStageKeywordField":
        return cls(m["field"], list(m["terms"]))


@dataclass
class EncodeGraphNode:
    """A node in the knowledge graph an ENCODE produced."""

    id: bytes  # 16-byte byte string
    name: str
    kind: str
    type_qname: str

    def to_map(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "type_qname": self.type_qname,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeGraphNode":
        return cls(m["id"], m["name"], m["kind"], m["type_qname"])


@dataclass
class EncodeGraphEdge:
    """A directed edge in the knowledge graph an ENCODE produced."""

    source: bytes  # 16-byte byte string
    target: bytes  # 16-byte byte string
    predicate: str
    kind: str
    confidence: float  # f32
    # When the EVENT this edge records happened, in unix nanos. Omitted for
    # an undated statement and for every non-statement edge kind.
    event_at_unix_nanos: Optional[int] = None

    def to_map(self) -> dict:
        m: dict = {
            "source": self.source,
            "target": self.target,
            "predicate": self.predicate,
            "kind": self.kind,
            "confidence": round_f32(self.confidence),
        }
        if self.event_at_unix_nanos is not None:
            m["event_at_unix_nanos"] = self.event_at_unix_nanos
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeGraphEdge":
        return cls(
            m["source"],
            m["target"],
            m["predicate"],
            m["kind"],
            m["confidence"],
            m.get("event_at_unix_nanos"),
        )


@dataclass
class EncodeStageGraph:
    """The knowledge graph an ENCODE produced — nodes + directed edges."""

    nodes: list[EncodeGraphNode]
    edges: list[EncodeGraphEdge]

    def to_map(self) -> dict:
        return {
            "nodes": [n.to_map() for n in self.nodes],
            "edges": [e.to_map() for e in self.edges],
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeStageGraph":
        return cls(
            [EncodeGraphNode.from_map(n) for n in m["nodes"]],
            [EncodeGraphEdge.from_map(e) for e in m["edges"]],
        )


@dataclass
class EncodeStageArtifact:
    """The concrete output one ENCODE stage produced (embed -> vector, persist
    -> record, HyPE -> questions, text-index -> keyword terms, extractor ->
    graph). Every field is optional and omitted from the CBOR map when
    empty/absent (matching the server's ``skip_serializing_if``). Field order:
    vector, record, hype_questions, keyword_fields, graph."""

    vector: list[float] = field(default_factory=list)  # f32 elements
    record: Optional[EncodeStageRecord] = None
    hype_questions: list[str] = field(default_factory=list)
    keyword_fields: list[EncodeStageKeywordField] = field(default_factory=list)
    graph: Optional[EncodeStageGraph] = None

    def to_map(self) -> dict:
        m: dict = {}
        if self.vector:
            m["vector"] = [round_f32(x) for x in self.vector]
        if self.record is not None:
            m["record"] = self.record.to_map()
        if self.hype_questions:
            m["hype_questions"] = list(self.hype_questions)
        if self.keyword_fields:
            m["keyword_fields"] = [k.to_map() for k in self.keyword_fields]
        if self.graph is not None:
            m["graph"] = self.graph.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EncodeStageArtifact":
        record = m.get("record")
        graph = m.get("graph")
        return cls(
            [float(x) for x in m.get("vector", [])],
            None if record is None else EncodeStageRecord.from_map(record),
            list(m.get("hype_questions", [])),
            [EncodeStageKeywordField.from_map(k) for k in m.get("keyword_fields", [])],
            None if graph is None else EncodeStageGraph.from_map(graph),
        )


# ===========================================================================
# MEMORY_INSPECT — one memory's durable write-artifact bundle.
# ===========================================================================


@dataclass
class MemoryInspectRequest:
    """MEMORY_INSPECT (``0x0028``). Fetch the durable write-artifact bundle for
    one memory. Single-shot (not paginated)."""

    memory_id: bytes  # 16-byte byte string
    # Effective identity this inspect runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {"memory_id": self.memory_id}
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "MemoryInspectRequest":
        act_as = m.get("act_as")
        return cls(
            m["memory_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class MemoryInspectResponse:
    """MEMORY_INSPECT_RESP (``0x00A8``). The durable per-memory artifact bundle
    plus text. ``found = False`` (with an empty ``artifact``) when no memory /
    no bundle exists for the id under the caller's scope."""

    found: bool
    memory_id: bytes  # 16-byte byte string
    text: str
    artifact: EncodeStageArtifact

    def to_map(self) -> dict:
        return {
            "found": self.found,
            "memory_id": self.memory_id,
            "text": self.text,
            "artifact": self.artifact.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "MemoryInspectResponse":
        return cls(
            m["found"],
            m["memory_id"],
            m["text"],
            EncodeStageArtifact.from_map(m["artifact"]),
        )


# ===========================================================================
# RECALL.
# ===========================================================================


class AnswerKind:
    """The shape of a recall answer. Encoded as the variant-name string on
    the wire.

      * ``Single`` — exactly one memory answers the cue.
      * ``Many``   — several memories answer the cue.
      * ``None``   — nothing is stored that answers the cue.
    """

    SINGLE = "Single"
    MANY = "Many"
    NONE = "None"


@dataclass
class RecallRequest:
    """RECALL (``0x0021``). Cue-driven memory retrieval: the cue text and subject, result and confidence bounds, temporal/kind filters, and enrichment toggles."""

    cue_text: str
    subject_name: str
    max_results: int
    confidence_threshold: float  # f32
    session_filter: Optional[list[int]]
    age_bound_unix_nanos: Optional[int]
    as_of_record_time_unix_nanos: Optional[int]
    kind_filter: Optional[list[int]]
    salience_floor: float  # f32
    include_edges: bool
    include_graph: bool
    include_text: bool
    request_id: Optional[bytes]
    txn_id: Optional[bytes]
    # Opt-in per-stage read-pipeline trace. Always present on the wire
    # (defaults to False); when True the final RECALL_RESP frame carries a
    # populated ``trace``.
    trace: bool = False
    # Effective identity this recall runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "cue_text": self.cue_text,
            "subject_name": self.subject_name,
            "max_results": self.max_results,
            "confidence_threshold": round_f32(self.confidence_threshold),
            "session_filter": (
                None if self.session_filter is None else list(self.session_filter)
            ),
            "age_bound_unix_nanos": self.age_bound_unix_nanos,
            "as_of_record_time_unix_nanos": self.as_of_record_time_unix_nanos,
            "kind_filter": None if self.kind_filter is None else list(self.kind_filter),
            "salience_floor": round_f32(self.salience_floor),
            "include_edges": self.include_edges,
            "include_graph": self.include_graph,
            "include_text": self.include_text,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "trace": self.trace,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RecallRequest":
        act_as = m.get("act_as")
        return cls(
            m["cue_text"],
            m["subject_name"],
            m["max_results"],
            m["confidence_threshold"],
            None if m["session_filter"] is None else list(m["session_filter"]),
            m["age_bound_unix_nanos"],
            m["as_of_record_time_unix_nanos"],
            None if m["kind_filter"] is None else list(m["kind_filter"]),
            m["salience_floor"],
            m["include_edges"],
            m["include_graph"],
            m["include_text"],
            m["request_id"],
            m["txn_id"],
            bool(m.get("trace", False)),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EdgeView:
    """A memory edge as returned on the read path: target memory, edge kind, and weight."""

    target: int
    kind: int
    weight: float  # f32

    def to_map(self) -> dict:
        return {"target": self.target, "kind": self.kind, "weight": round_f32(self.weight)}

    @classmethod
    def from_map(cls, m: dict) -> "EdgeView":
        return cls(m["target"], m["kind"], m["weight"])


@dataclass
class EnrichedEntity:
    """A graph entity attached to a recall result: its id, name, and type qname."""

    id: bytes
    name: str
    type_qname: str

    def to_map(self) -> dict:
        return {"id": self.id, "name": self.name, "type_qname": self.type_qname}

    @classmethod
    def from_map(cls, m: dict) -> "EnrichedEntity":
        return cls(m["id"], m["name"], m["type_qname"])


@dataclass
class EnrichedStatement:
    """A graph statement attached to a recall result: subject, predicate, object label, and confidence."""

    id: bytes
    subject_name: str
    predicate: str
    object_label: str
    confidence: float  # f32
    # When the statement's EVENT happened, in unix nanos. Omitted from the
    # wire map for a statement with no event time.
    event_at_unix_nanos: Optional[int] = None

    def to_map(self) -> dict:
        m: dict = {
            "id": self.id,
            "subject_name": self.subject_name,
            "predicate": self.predicate,
            "object_label": self.object_label,
            "confidence": round_f32(self.confidence),
        }
        if self.event_at_unix_nanos is not None:
            m["event_at_unix_nanos"] = self.event_at_unix_nanos
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EnrichedStatement":
        return cls(
            m["id"],
            m["subject_name"],
            m["predicate"],
            m["object_label"],
            m["confidence"],
            m.get("event_at_unix_nanos"),
        )


@dataclass
class EnrichedRelation:
    """A graph relation attached to a recall result: the from-name, predicate, and to-name."""

    from_name: str
    predicate: str
    to_name: str

    def to_map(self) -> dict:
        return {"from_name": self.from_name, "predicate": self.predicate, "to_name": self.to_name}

    @classmethod
    def from_map(cls, m: dict) -> "EnrichedRelation":
        return cls(m["from_name"], m["predicate"], m["to_name"])


@dataclass
class GraphEnrichment:
    """The typed-graph context attached to a recall result — the entities, statements, and relations near the answer."""

    entities: list[EnrichedEntity]
    statements: list[EnrichedStatement]
    relations: list[EnrichedRelation]

    def to_map(self) -> dict:
        return {
            "entities": [e.to_map() for e in self.entities],
            "statements": [s.to_map() for s in self.statements],
            "relations": [r.to_map() for r in self.relations],
        }

    @classmethod
    def from_map(cls, m: dict) -> "GraphEnrichment":
        return cls(
            [EnrichedEntity.from_map(e) for e in m["entities"]],
            [EnrichedStatement.from_map(s) for s in m["statements"]],
            [EnrichedRelation.from_map(r) for r in m["relations"]],
        )


@dataclass
class MemoryResult:
    """One memory in a recall answer: its text and ids plus the full scoring/provenance surface — similarity, confidence, salience, fused/rerank scores, edges, and optional graph enrichment."""

    memory_id: int  # u128
    text: str
    similarity_score: float  # f32
    confidence: float  # f32
    salience: float  # f32
    kind: int
    space_id: bytes  # 16-byte byte string (derived storage id)
    session_id: int
    created_at_unix_nanos: int
    last_accessed_at_unix_nanos: int
    edges: Optional[list[EdgeView]]
    contributing_retrievers: list[int]
    fused_score: float  # f32
    rerank_score: Optional[float]  # f32 or None
    salience_initial: float  # f32
    access_count: int
    lsn: int
    flags: int
    consolidated_at_unix_nanos: Optional[int]
    occurred_at_unix_nanos: Optional[int]
    edges_out_count: int
    edges_in_count: int
    graph: Optional[GraphEnrichment]

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "similarity_score": round_f32(self.similarity_score),
            "confidence": round_f32(self.confidence),
            "salience": round_f32(self.salience),
            "kind": self.kind,
            "space_id": self.space_id,
            "session_id": self.session_id,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "last_accessed_at_unix_nanos": self.last_accessed_at_unix_nanos,
            "edges": None if self.edges is None else [e.to_map() for e in self.edges],
            "contributing_retrievers": list(self.contributing_retrievers),
            "fused_score": round_f32(self.fused_score),
            "rerank_score": None if self.rerank_score is None else round_f32(self.rerank_score),
            "salience_initial": round_f32(self.salience_initial),
            "access_count": self.access_count,
            "lsn": self.lsn,
            "flags": self.flags,
            "consolidated_at_unix_nanos": self.consolidated_at_unix_nanos,
            "occurred_at_unix_nanos": self.occurred_at_unix_nanos,
            "edges_out_count": self.edges_out_count,
            "edges_in_count": self.edges_in_count,
            "graph": None if self.graph is None else self.graph.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "MemoryResult":
        return cls(
            m["memory_id"],
            m["text"],
            m["similarity_score"],
            m["confidence"],
            m["salience"],
            m["kind"],
            m["space_id"],
            m["session_id"],
            m["created_at_unix_nanos"],
            m["last_accessed_at_unix_nanos"],
            None if m["edges"] is None else [EdgeView.from_map(e) for e in m["edges"]],
            list(m["contributing_retrievers"]),
            m["fused_score"],
            m["rerank_score"],
            m["salience_initial"],
            m["access_count"],
            m["lsn"],
            m["flags"],
            m["consolidated_at_unix_nanos"],
            m["occurred_at_unix_nanos"],
            m["edges_out_count"],
            m["edges_in_count"],
            None if m["graph"] is None else GraphEnrichment.from_map(m["graph"]),
        )


@dataclass
class RecallResponseFrame:
    """RECALL_RESP (``0x00A1``), one streamed frame. Carries the answer shape, this frame's memories, and streaming progress (final flag, cumulative and estimated-remaining counts)."""

    answer_kind: str  # AnswerKind variant-name string
    memories: list[MemoryResult]
    is_final: bool
    cumulative_count: int
    estimated_remaining: Optional[int]
    # Per-stage read-pipeline trace, present only on the final frame and only
    # when the request set ``trace = True``; omitted from the CBOR map otherwise.
    trace: Optional["RecallTrace"] = None

    def to_map(self) -> dict:
        m = {
            "answer_kind": self.answer_kind,
            "memories": [r.to_map() for r in self.memories],
            "is_final": self.is_final,
            "cumulative_count": self.cumulative_count,
            "estimated_remaining": self.estimated_remaining,
        }
        if self.trace is not None:
            m["trace"] = self.trace.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RecallResponseFrame":
        trace = m.get("trace")
        return cls(
            m["answer_kind"],
            [MemoryResult.from_map(r) for r in m["memories"]],
            m["is_final"],
            m["cumulative_count"],
            m["estimated_remaining"],
            None if trace is None else RecallTrace.from_map(trace),
        )


# ===========================================================================
# RECALL trace (opt-in per-stage read-pipeline observability).
# ===========================================================================


class RecallTraceRetrieverStatus:
    """Terminal status of one retriever lane in a RECALL trace, as its on-wire integer discriminant."""

    SUCCESS = 0
    SKIPPED = 1
    TIMEOUT = 2
    FAILURE = 3


@dataclass
class RecallTraceRetriever:
    """What one retriever lane did during a traced RECALL: its name (a ``RetrieverName`` int), terminal status, a status detail string, latency (ms), and candidate count."""

    name: int
    status: int
    status_detail: str
    latency_ms: float  # f64
    candidate_count: int
    # Only populated in full-detail mode (``trace = True``): the raw
    # candidates this lane contributed before fusion, in the lane's own
    # rank order. Empty when the connected server predates this field.
    candidates: list["RecallTraceCandidate"] = field(default_factory=list)

    def to_map(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "status_detail": self.status_detail,
            "latency_ms": mark_f64(self.latency_ms),
            "candidate_count": self.candidate_count,
            "candidates": [c.to_map() for c in self.candidates],
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceRetriever":
        return cls(
            m["name"],
            m["status"],
            m["status_detail"],
            m["latency_ms"],
            m["candidate_count"],
            [RecallTraceCandidate.from_map(c) for c in m.get("candidates", [])],
        )


@dataclass
class RecallTraceCandidate:
    """One retriever-lane candidate surfaced in full-detail trace mode. The
    graph lane surfaces typed items (entities / relations), so ``item_id`` is
    interpreted against ``kind`` (a ``RankedItemKindWire`` discriminant).
    ``text`` is a human-readable label (memory text, entity name, or a rendered
    statement/relation), truncated server-side; ``score`` is the lane's raw score."""

    item_id: int  # u128 — memory / statement / entity / relation id, per kind
    kind: int  # RankedItemKindWire: 0 memory · 1 statement · 2 entity · 3 relation
    text: str
    score: float  # f32

    def to_map(self) -> dict:
        return {
            "item_id": self.item_id,
            "kind": self.kind,
            "text": self.text,
            "score": round_f32(self.score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceCandidate":
        return cls(m["item_id"], m["kind"], m["text"], m["score"])


class RankedItemKindWire:
    """Which id-space a ``RecallTraceDroppedId.id`` belongs to, as its
    on-wire integer discriminant. Mirrors the pipeline-internal
    ``RankedItemId``: unlike the type/temporal/confidence/tombstone filter
    steps (which only ever drop ``Memory`` items), supersession, as-of, and
    the final limit truncation can drop ``Statement`` and ``Relation``
    items too, so those three steps tag each dropped id with its kind."""

    MEMORY = 0
    STATEMENT = 1
    ENTITY = 2
    RELATION = 3


@dataclass
class RecallTraceDroppedId:
    """One id a filter-chain step dropped, tagged with which id-space
    (``RankedItemKindWire``) it came from. Used for ``dropped_by_supersession``
    / ``dropped_by_as_of`` / ``dropped_by_limit``, the three filter-chain
    steps that can drop non-``Memory`` items."""

    kind: int  # RankedItemKindWire
    id: int  # u128

    def to_map(self) -> dict:
        return {"kind": self.kind, "id": self.id}

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceDroppedId":
        return cls(m["kind"], m["id"])


@dataclass
class RecallTraceFilterChain:
    """Survivor counts after each step of the RECALL filter chain."""

    before: int
    after_type: int
    after_temporal: int
    after_confidence: int
    after_tombstone: int
    after_supersession: int
    after_as_of: int
    after_limit: int
    # Only populated in full-detail mode (``trace = True``): which memory
    # ids were removed by this specific filter step (empty = nothing
    # dropped here, or the connected server predates this field). These
    # four steps only ever drop ``Memory`` items in practice, so they stay
    # plain id lists.
    dropped_by_type: list[int] = field(default_factory=list)
    dropped_by_temporal: list[int] = field(default_factory=list)
    dropped_by_confidence: list[int] = field(default_factory=list)
    dropped_by_tombstone: list[int] = field(default_factory=list)
    # Only populated in full-detail mode: kind-tagged ids removed by
    # supersession / as-of / the final limit truncation, since these three
    # steps can drop ``Statement`` and ``Relation`` items, not just
    # ``Memory`` ones (empty = nothing dropped here).
    dropped_by_supersession: list[RecallTraceDroppedId] = field(default_factory=list)
    dropped_by_as_of: list[RecallTraceDroppedId] = field(default_factory=list)
    dropped_by_limit: list[RecallTraceDroppedId] = field(default_factory=list)

    def to_map(self) -> dict:
        return {
            "before": self.before,
            "after_type": self.after_type,
            "after_temporal": self.after_temporal,
            "after_confidence": self.after_confidence,
            "after_tombstone": self.after_tombstone,
            "after_supersession": self.after_supersession,
            "after_as_of": self.after_as_of,
            "after_limit": self.after_limit,
            "dropped_by_type": list(self.dropped_by_type),
            "dropped_by_temporal": list(self.dropped_by_temporal),
            "dropped_by_confidence": list(self.dropped_by_confidence),
            "dropped_by_tombstone": list(self.dropped_by_tombstone),
            "dropped_by_supersession": [d.to_map() for d in self.dropped_by_supersession],
            "dropped_by_as_of": [d.to_map() for d in self.dropped_by_as_of],
            "dropped_by_limit": [d.to_map() for d in self.dropped_by_limit],
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceFilterChain":
        return cls(
            m["before"],
            m["after_type"],
            m["after_temporal"],
            m["after_confidence"],
            m["after_tombstone"],
            m["after_supersession"],
            m["after_as_of"],
            m["after_limit"],
            list(m.get("dropped_by_type", [])),
            list(m.get("dropped_by_temporal", [])),
            list(m.get("dropped_by_confidence", [])),
            list(m.get("dropped_by_tombstone", [])),
            [RecallTraceDroppedId.from_map(d) for d in m.get("dropped_by_supersession", [])],
            [RecallTraceDroppedId.from_map(d) for d in m.get("dropped_by_as_of", [])],
            [RecallTraceDroppedId.from_map(d) for d in m.get("dropped_by_limit", [])],
        )


@dataclass
class RecallTraceRerank:
    """Outcome of the cross-encoder rerank stage in a RECALL trace: whether it applied, how many candidates it scored, and its latency (ms)."""

    applied: bool
    candidates: int
    latency_ms: float  # f64
    # Full-detail mode only: the fused (pre-rerank) and post-rerank orders,
    # so the client can show exactly what the cross-encoder moved. Empty
    # when trace detail wasn't requested or the server predates this field.
    before_order: list[int] = field(default_factory=list)
    after_order: list[int] = field(default_factory=list)

    def to_map(self) -> dict:
        return {
            "applied": self.applied,
            "candidates": self.candidates,
            "latency_ms": mark_f64(self.latency_ms),
            "before_order": list(self.before_order),
            "after_order": list(self.after_order),
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceRerank":
        return cls(
            m["applied"],
            m["candidates"],
            m["latency_ms"],
            list(m.get("before_order", [])),
            list(m.get("after_order", [])),
        )


@dataclass
class RecallTraceFusionItem:
    """One fused item's RRF score plus the per-lane component scores that contributed to it."""

    memory_id: int  # u128
    rrf_score: float  # f32
    lane_scores: list[tuple[int, float]]  # (RetrieverName, f32) pairs

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "rrf_score": round_f32(self.rrf_score),
            "lane_scores": [[name, round_f32(score)] for name, score in self.lane_scores],
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceFusionItem":
        return cls(
            m["memory_id"],
            m["rrf_score"],
            [(pair[0], pair[1]) for pair in m["lane_scores"]],
        )


@dataclass
class RecallTraceFusion:
    """Full-detail mode only: per-fused-item score breakdown by contributing lane, surfaced on a ``RecallTrace`` when the request opted into tracing."""

    items: list[RecallTraceFusionItem]

    def to_map(self) -> dict:
        return {"items": [i.to_map() for i in self.items]}

    @classmethod
    def from_map(cls, m: dict) -> "RecallTraceFusion":
        return cls([RecallTraceFusionItem.from_map(i) for i in m["items"]])


@dataclass
class RecallTrace:
    """Per-stage observability for one RECALL (surfaced on the final frame when the request set ``trace = True``): the retriever lanes, the filter chain, the rerank outcome, and total latency (ms)."""

    retrievers: list[RecallTraceRetriever]
    filter_chain: RecallTraceFilterChain
    rerank: Optional[RecallTraceRerank]
    total_latency_ms: float  # f64
    # Full-detail mode only: per-fused-item score breakdown by contributing
    # lane. None when trace detail wasn't requested, fusion produced
    # nothing, or the connected server predates this field.
    fusion: Optional[RecallTraceFusion] = None

    def to_map(self) -> dict:
        return {
            "retrievers": [r.to_map() for r in self.retrievers],
            "filter_chain": self.filter_chain.to_map(),
            "rerank": None if self.rerank is None else self.rerank.to_map(),
            "total_latency_ms": mark_f64(self.total_latency_ms),
            "fusion": None if self.fusion is None else self.fusion.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallTrace":
        rerank = m["rerank"]
        fusion = m.get("fusion")
        return cls(
            [RecallTraceRetriever.from_map(r) for r in m["retrievers"]],
            RecallTraceFilterChain.from_map(m["filter_chain"]),
            None if rerank is None else RecallTraceRerank.from_map(rerank),
            m["total_latency_ms"],
            None if fusion is None else RecallTraceFusion.from_map(fusion),
        )


@dataclass
class RecallAnswer:
    """A drained recall answer: the terminal frame's ``answer_kind`` plus the
    ``memories`` concatenated across every streamed frame.

    ``answer_kind`` says how to read it: ``Single`` / ``Many`` carry the
    answering ``memories``; ``None`` carries an empty list (nothing stored
    answers the cue).
    """

    answer_kind: str  # AnswerKind variant-name string
    memories: list[MemoryResult]

    @property
    def is_empty(self) -> bool:
        """True when nothing stored answers the cue."""
        return self.answer_kind == AnswerKind.NONE or not self.memories


# ===========================================================================
# FORGET.
# ===========================================================================


@dataclass
class ForgetRequest:
    """FORGET (``0x0024``). Retire a memory by id under soft or hard mode, with idempotency and txn ids."""

    memory_id: int  # u128
    mode: int
    request_id: bytes
    txn_id: Optional[bytes]
    # Effective identity this forget runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "memory_id": self.memory_id,
            "mode": self.mode,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "ForgetRequest":
        act_as = m.get("act_as")
        return cls(
            m["memory_id"],
            m["mode"],
            m["request_id"],
            m["txn_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class ForgetResponse:
    """FORGET_RESP (``0x00A4``). The forgotten memory's id, whether it was already gone, and how many edges were removed."""

    memory_id: int  # u128
    was_already_forgotten: bool
    edges_removed: int

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "was_already_forgotten": self.was_already_forgotten,
            "edges_removed": self.edges_removed,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ForgetResponse":
        return cls(m["memory_id"], m["was_already_forgotten"], m["edges_removed"])


# ===========================================================================
# MEMORY_LIST.
# ===========================================================================


class MemoryListSort:
    """Sort axis for MEMORY_LIST, as its on-wire integer discriminant. v1
    supports only ``CREATED`` end-to-end; the others are reserved wire values."""

    CREATED = 0
    SALIENCE = 1
    OCCURRED = 2
    LAST_ACCESSED = 3


class MemoryListDir:
    """Sort direction for MEMORY_LIST, as its on-wire integer discriminant."""

    ASC = 0
    DESC = 1


class MemoryListTimeAxis:
    """Which time field a MEMORY_LIST ``from``/``to`` range filters on, as its
    on-wire integer discriminant. v1 supports only ``CREATED``."""

    CREATED = 0
    OCCURRED = 1


@dataclass
class MemoryListRequest:
    """MEMORY_LIST (``0x0027``). A paginated enumeration of the caller's
    ``(namespace, space)`` memories — no query, no ranking. It walks the tenant
    timeline in a stable order and returns a page plus an opaque keyset cursor.
    Empty/zero fields mean "no filter". ``cursor`` / ``next_cursor`` are opaque
    byte blobs (CBOR arrays of ints on the wire, not byte strings)."""

    sort: int
    dir: int
    limit: int  # u32, validated server-side to 1..=100
    cursor: bytes  # empty on first page; opaque continuation token otherwise
    kinds: list[int]  # empty = all kinds
    include_tombstoned: bool
    time_axis: int
    from_unix_nanos: int  # 0 = no lower bound
    to_unix_nanos: int  # 0 = no upper bound
    salience_min: float  # f32
    salience_max: float  # f32
    text_contains: str  # empty = no filter
    # Effective identity this list runs as. Omitted from the CBOR map when None
    # so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "sort": self.sort,
            "dir": self.dir,
            "limit": self.limit,
            "cursor": list(self.cursor),
            "kinds": list(self.kinds),
            "include_tombstoned": self.include_tombstoned,
            "time_axis": self.time_axis,
            "from_unix_nanos": self.from_unix_nanos,
            "to_unix_nanos": self.to_unix_nanos,
            "salience_min": round_f32(self.salience_min),
            "salience_max": round_f32(self.salience_max),
            "text_contains": self.text_contains,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "MemoryListRequest":
        act_as = m.get("act_as")
        return cls(
            m["sort"],
            m["dir"],
            m["limit"],
            bytes(m["cursor"]),
            list(m["kinds"]),
            m["include_tombstoned"],
            m["time_axis"],
            m["from_unix_nanos"],
            m["to_unix_nanos"],
            m["salience_min"],
            m["salience_max"],
            m["text_contains"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class MemoryListItem:
    """One memory in a MEMORY_LIST response batch: the enumeration-relevant
    fields plus relationship-handle counts."""

    memory_id: bytes  # 16-byte byte string
    space_id: bytes  # 16-byte byte string (derived storage id)
    session_id: int
    text: str
    kind: int  # raw memory-kind byte
    state: int  # lifecycle state byte (0 = active, 1 = tombstoned)
    created_at_unix_nanos: int
    occurred_at_unix_nanos: int  # 0 when the memory has no event time
    last_accessed_at_unix_nanos: int
    salience: float  # f32, point-in-time snapshot
    access_count: int
    source_request_id: bytes  # 16-byte byte string
    statement_count: int
    entity_count: int
    relation_count: int

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "space_id": self.space_id,
            "session_id": self.session_id,
            "text": self.text,
            "kind": self.kind,
            "state": self.state,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "occurred_at_unix_nanos": self.occurred_at_unix_nanos,
            "last_accessed_at_unix_nanos": self.last_accessed_at_unix_nanos,
            "salience": round_f32(self.salience),
            "access_count": self.access_count,
            "source_request_id": self.source_request_id,
            "statement_count": self.statement_count,
            "entity_count": self.entity_count,
            "relation_count": self.relation_count,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MemoryListItem":
        return cls(
            m["memory_id"],
            m["space_id"],
            m["session_id"],
            m["text"],
            m["kind"],
            m["state"],
            m["created_at_unix_nanos"],
            m["occurred_at_unix_nanos"],
            m["last_accessed_at_unix_nanos"],
            m["salience"],
            m["access_count"],
            m["source_request_id"],
            m["statement_count"],
            m["entity_count"],
            m["relation_count"],
        )


@dataclass
class MemoryListResponseFrame:
    """MEMORY_LIST_RESP (``0x00A7``), one streamed frame. The last frame carries
    ``is_final = True``. Empty ``next_cursor`` on the final frame means
    "exhausted"; non-empty means "more pages available, resume with this"."""

    items: list[MemoryListItem]
    next_cursor: bytes  # opaque continuation token (CBOR array of ints)
    cumulative_count: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "next_cursor": list(self.next_cursor),
            "cumulative_count": self.cumulative_count,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MemoryListResponseFrame":
        return cls(
            [MemoryListItem.from_map(i) for i in m["items"]],
            bytes(m["next_cursor"]),
            m["cumulative_count"],
            m["is_final"],
        )


# ===========================================================================
# GRAPH_FETCH — full-agent typed-graph export.
# ===========================================================================


@dataclass
class GraphNode:
    """One graph node in a GRAPH_FETCH export. ``id`` is the 16-byte entity /
    statement / memory id (a CBOR byte string); ``kind`` says which id-space it
    is (0 = Entity, 1 = Statement, 2 = Memory). ``type_qname`` is the entity
    type qname (e.g. ``brain:Person``), empty for non-entity nodes."""

    id: bytes  # 16-byte byte string
    kind: int  # 0 = Entity, 1 = Statement, 2 = Memory
    label: str
    type_qname: str  # empty for non-entity nodes

    def to_map(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "type_qname": self.type_qname,
        }

    @classmethod
    def from_map(cls, m: dict) -> "GraphNode":
        return cls(m["id"], m["kind"], m["label"], m["type_qname"])


@dataclass
class GraphEdge:
    """One graph edge in a GRAPH_FETCH export. ``from_id`` / ``to_id`` are
    16-byte byte-string ids; ``kind`` is the edge kind (0 = Relation, 1 = Fact,
    2 = HasStatement, 3 = Mentions). ``label`` is the predicate / relation-type
    label, empty for ``Mentions``."""

    from_id: bytes  # 16-byte byte string
    to_id: bytes  # 16-byte byte string
    kind: int  # 0 = Relation, 1 = Fact, 2 = HasStatement, 3 = Mentions
    label: str  # empty for Mentions

    def to_map(self) -> dict:
        return {
            "from_id": self.from_id,
            "to_id": self.to_id,
            "kind": self.kind,
            "label": self.label,
        }

    @classmethod
    def from_map(cls, m: dict) -> "GraphEdge":
        return cls(m["from_id"], m["to_id"], m["kind"], m["label"])


@dataclass
class GraphFetchRequest:
    """GRAPH_FETCH (``0x0163``). A paginated export of the caller's whole
    ``(namespace, space)`` typed graph as a node/edge set. The default layer is
    the concept map (entity nodes + Relation/Fact edges); ``include_statements``
    adds value-object statement nodes, ``include_memories`` adds source-memory
    nodes, ``include_memory_edges`` adds the stored memory↔memory links between
    them. ``cursor`` / ``next_cursor`` are opaque byte blobs (CBOR arrays of
    ints on the wire, not byte strings)."""

    limit: int  # u32, validated server-side to 1..=500
    cursor: bytes  # empty on first page; opaque continuation token otherwise
    include_statements: bool
    include_memories: bool
    # Stored memory↔memory edges (SimilarTo, FollowedBy, …) incident to the
    # page's memory nodes. Requires include_memories; setting it alone is
    # rejected, since the edges would have no rendered endpoints.
    include_memory_edges: bool
    include_tombstoned: bool
    # Effective identity this export runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "limit": self.limit,
            "cursor": list(self.cursor),
            "include_statements": self.include_statements,
            "include_memories": self.include_memories,
            "include_memory_edges": self.include_memory_edges,
            "include_tombstoned": self.include_tombstoned,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "GraphFetchRequest":
        act_as = m.get("act_as")
        return cls(
            m["limit"],
            bytes(m["cursor"]),
            m["include_statements"],
            m["include_memories"],
            m["include_memory_edges"],
            m["include_tombstoned"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class GraphFetchResponseFrame:
    """GRAPH_FETCH_RESP (``0x01E3``), one streamed frame. Nodes/edges may repeat
    across pages (completeness, not disjointness) — dedup by id. Empty
    ``next_cursor`` means exhausted (CBOR array of ints on the wire)."""

    nodes: list[GraphNode]
    edges: list[GraphEdge]
    next_cursor: bytes  # opaque continuation token (CBOR array of ints)
    is_final: bool

    def to_map(self) -> dict:
        return {
            "nodes": [n.to_map() for n in self.nodes],
            "edges": [e.to_map() for e in self.edges],
            "next_cursor": list(self.next_cursor),
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "GraphFetchResponseFrame":
        return cls(
            [GraphNode.from_map(n) for n in m["nodes"]],
            [GraphEdge.from_map(e) for e in m["edges"]],
            bytes(m["next_cursor"]),
            m["is_final"],
        )


# ===========================================================================
# ERROR.
# ===========================================================================


@dataclass
class ErrorDetails:
    """Optional structured context on an ERROR — the offending field and its expected vs. actual values."""

    field: Optional[str]
    expected: Optional[str]
    actual: Optional[str]

    def to_map(self) -> dict:
        return {"field": self.field, "expected": self.expected, "actual": self.actual}

    @classmethod
    def from_map(cls, m: dict) -> "ErrorDetails":
        return cls(m["field"], m["expected"], m["actual"])


@dataclass
class ErrorResponse:
    """ERROR (``0x00FF``). A structured failure: numeric code, category, human message, optional field details, and an optional retry-after hint."""

    code: int  # u16
    category: int  # u8
    message: str
    details: Optional[ErrorDetails]
    retry_after_ms: Optional[int]

    def to_map(self) -> dict:
        return {
            "code": self.code,
            "category": self.category,
            "message": self.message,
            "details": None if self.details is None else self.details.to_map(),
            "retry_after_ms": self.retry_after_ms,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ErrorResponse":
        return cls(
            m["code"],
            m["category"],
            m["message"],
            None if m["details"] is None else ErrorDetails.from_map(m["details"]),
            m["retry_after_ms"],
        )


# ===========================================================================
# Typed-graph payloads exercised by the corpus.
# ===========================================================================


class StatementKind:
    """Statement kind.

    The six fieldless variants encode on the wire as their variant-name
    string ("Fact"/"Preference"/"Event"/"Attribute"/"Relation"/"Directive").
    The catch-all ``Custom(byte)`` encodes as a single-entry CBOR map
    ``{"Custom": <int>}`` (ciborium newtype-variant form).

    A ``kind`` field on a statement payload is therefore either a ``str``
    (a fieldless variant) or a ``{"Custom": int}`` dict; both pass through
    the CBOR codec unchanged. :meth:`custom` builds the dict form and
    :meth:`from_storage_byte` / :meth:`to_storage_byte` map to the
    storage-byte discriminant (0=Fact, 1=Preference, 2=Event, 3=Attribute,
    4=Relation, 5=Directive, >=6 => Custom).
    """

    FACT = "Fact"
    PREFERENCE = "Preference"
    EVENT = "Event"
    ATTRIBUTE = "Attribute"
    RELATION = "Relation"
    DIRECTIVE = "Directive"

    _BY_BYTE = {
        0: "Fact",
        1: "Preference",
        2: "Event",
        3: "Attribute",
        4: "Relation",
        5: "Directive",
    }
    _TO_BYTE = {name: b for b, name in _BY_BYTE.items()}

    @staticmethod
    def custom(byte: int) -> dict:
        """The wire value for a ``Custom`` statement kind."""
        return {"Custom": byte}

    @classmethod
    def from_storage_byte(cls, byte: int):
        """Map a storage-byte discriminant to a wire ``kind`` value."""
        name = cls._BY_BYTE.get(byte)
        return name if name is not None else cls.custom(byte)

    @classmethod
    def to_storage_byte(cls, kind) -> int:
        """Map a wire ``kind`` value back to its storage-byte discriminant."""
        if isinstance(kind, dict) and "Custom" in kind:
            return kind["Custom"]
        return cls._TO_BYTE[kind]


@dataclass
class StatementValue:
    """Externally-tagged scalar object value: ``{"Text": "..."}``,
    ``{"Integer": n}``, ``{"Float": f}`` (f64), ``{"Bool": b}``,
    ``{"UnixNanos": n}``, ``{"Blob": [bytes...]}`` (a Vec<u8> array).
    """

    variant: str
    value: object

    def to_cbor_value(self) -> object:
        if self.variant == "Blob":
            return {"Blob": list(self.value)}
        if self.variant == "Float":
            return {"Float": float(self.value)}  # f64
        return {self.variant: self.value}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "StatementValue":
        (variant, value), = v.items()
        if variant == "Blob":
            return cls("Blob", list(value))
        return cls(variant, value)


@dataclass
class StatementObject:
    """Externally-tagged statement object. ``EntityRef`` / ``MemoryRef`` /
    ``StatementRef`` wrap a 16-byte byte string; ``Value`` wraps a
    ``StatementValue``.
    """

    variant: str
    value: object

    def to_cbor_value(self) -> object:
        if self.variant == "Value":
            return {"Value": self.value.to_cbor_value()}
        # EntityRef / MemoryRef / StatementRef -> byte string id.
        return {self.variant: self.value}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "StatementObject":
        (variant, value), = v.items()
        if variant == "Value":
            return cls("Value", StatementValue.from_cbor_value(value))
        return cls(variant, value)


@dataclass
class EvidenceRef:
    """Externally-tagged evidence reference. ``Inline`` is a list of 16-byte
    byte-string memory ids; ``Overflow`` is a single 16-byte byte string.
    """

    variant: str
    value: object

    @classmethod
    def inline(cls, ids: list[bytes]) -> "EvidenceRef":
        return cls("Inline", list(ids))

    @classmethod
    def overflow(cls, id_: bytes) -> "EvidenceRef":
        return cls("Overflow", id_)

    def to_cbor_value(self) -> object:
        if self.variant == "Inline":
            return {"Inline": list(self.value)}
        return {"Overflow": self.value}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "EvidenceRef":
        (variant, value), = v.items()
        if variant == "Inline":
            return cls("Inline", list(value))
        return cls("Overflow", value)


@dataclass
class EntityCreateRequest:
    """ENTITY_CREATE (``0x0130``). Create a typed-graph entity: its type, canonical name, aliases, opaque attributes blob, and idempotency id."""

    entity_type_id: int
    canonical_name: str
    aliases: list[str]
    attributes_blob: list[int]  # Vec<u8> -> CBOR array of ints
    session_id: int  # u64
    request_id: bytes
    # Effective identity this entity-create runs as. Omitted from the CBOR map
    # when None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "entity_type_id": self.entity_type_id,
            "canonical_name": self.canonical_name,
            "aliases": list(self.aliases),
            "attributes_blob": list(self.attributes_blob),
            "session_id": self.session_id,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EntityCreateRequest":
        act_as = m.get("act_as")
        return cls(
            m["entity_type_id"],
            m["canonical_name"],
            list(m["aliases"]),
            list(m["attributes_blob"]),
            m["session_id"],
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EntityCreateResponse:
    """ENTITY_CREATE_RESP (``0x01B0``). The new entity's id."""

    entity_id: bytes  # 16-byte byte string

    def to_map(self) -> dict:
        return {"entity_id": self.entity_id}

    @classmethod
    def from_map(cls, m: dict) -> "EntityCreateResponse":
        return cls(m["entity_id"])


@dataclass
class StatementCreateRequest:
    """STATEMENT_CREATE (``0x0140``). Assert a typed-graph statement: kind, subject, predicate, object, confidence, evidence, extractor, and bi-temporal validity."""

    # StatementKind: a variant-name str, or {"Custom": int} for the catch-all.
    kind: Union[str, dict]
    subject: bytes  # 16-byte byte string
    predicate: str
    object: StatementObject
    confidence: float  # f32
    evidence: EvidenceRef
    extractor_id: int
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    event_at_unix_nanos: int
    schema_version: int
    session_id: int  # u64
    request_id: bytes
    # Effective identity this statement-create runs as. Omitted from the CBOR
    # map when None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "kind": self.kind,
            "subject": self.subject,
            "predicate": self.predicate,
            "object": self.object.to_cbor_value(),
            "confidence": round_f32(self.confidence),
            "evidence": self.evidence.to_cbor_value(),
            "extractor_id": self.extractor_id,
            "valid_from_unix_nanos": self.valid_from_unix_nanos,
            "valid_to_unix_nanos": self.valid_to_unix_nanos,
            "event_at_unix_nanos": self.event_at_unix_nanos,
            "schema_version": self.schema_version,
            "session_id": self.session_id,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "StatementCreateRequest":
        act_as = m.get("act_as")
        return cls(
            m["kind"],
            m["subject"],
            m["predicate"],
            StatementObject.from_cbor_value(m["object"]),
            m["confidence"],
            EvidenceRef.from_cbor_value(m["evidence"]),
            m["extractor_id"],
            m["valid_from_unix_nanos"],
            m["valid_to_unix_nanos"],
            m["event_at_unix_nanos"],
            m["schema_version"],
            m["session_id"],
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class StatementCreateResponse:
    """STATEMENT_CREATE_RESP (``0x01C0``). The new statement's id, any statement it auto-superseded, and its supersession-chain root."""

    statement_id: bytes
    auto_superseded: bytes
    chain_root: bytes

    def to_map(self) -> dict:
        return {
            "statement_id": self.statement_id,
            "auto_superseded": self.auto_superseded,
            "chain_root": self.chain_root,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementCreateResponse":
        return cls(m["statement_id"], m["auto_superseded"], m["chain_root"])


@dataclass
class RelationCreateRequest:
    """RELATION_CREATE (``0x0150``). Assert a typed-graph relation between two entities: type, endpoints, properties blob, evidence, confidence, and validity window."""

    relation_type: str
    from_entity: bytes
    to_entity: bytes
    properties_blob: list[int]  # Vec<u8> -> CBOR array of ints
    evidence: EvidenceRef
    extractor_id: int
    confidence: float  # f32
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    session_id: int  # u64
    request_id: bytes
    # Effective identity this relation-create runs as. Omitted from the CBOR
    # map when None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "relation_type": self.relation_type,
            "from_entity": self.from_entity,
            "to_entity": self.to_entity,
            "properties_blob": list(self.properties_blob),
            "evidence": self.evidence.to_cbor_value(),
            "extractor_id": self.extractor_id,
            "confidence": round_f32(self.confidence),
            "valid_from_unix_nanos": self.valid_from_unix_nanos,
            "valid_to_unix_nanos": self.valid_to_unix_nanos,
            "session_id": self.session_id,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RelationCreateRequest":
        act_as = m.get("act_as")
        return cls(
            m["relation_type"],
            m["from_entity"],
            m["to_entity"],
            list(m["properties_blob"]),
            EvidenceRef.from_cbor_value(m["evidence"]),
            m["extractor_id"],
            m["confidence"],
            m["valid_from_unix_nanos"],
            m["valid_to_unix_nanos"],
            m["session_id"],
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class RelationCreateResponse:
    """RELATION_CREATE_RESP (``0x01D0``). The new relation's id."""

    relation_id: bytes

    def to_map(self) -> dict:
        return {"relation_id": self.relation_id}

    @classmethod
    def from_map(cls, m: dict) -> "RelationCreateResponse":
        return cls(m["relation_id"])


@dataclass
class SchemaUploadRequest:
    """SCHEMA_UPLOAD (``0x0120``). Merge a schema document into the active namespace, with dry-run and allow-breaking flags plus an idempotency id."""

    schema_document: str
    dry_run: bool
    allow_breaking: bool
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "schema_document": self.schema_document,
            "dry_run": self.dry_run,
            "allow_breaking": self.allow_breaking,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaUploadRequest":
        return cls(m["schema_document"], m["dry_run"], m["allow_breaking"], m["request_id"])


@dataclass
class SchemaValidationError:
    """One diagnostic from schema validation: code, message, source span (line/column/length), and severity."""

    code: str
    message: str
    line: int
    column: int
    length: int
    severity: int

    def to_map(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "line": self.line,
            "column": self.column,
            "length": self.length,
            "severity": self.severity,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaValidationError":
        return cls(m["code"], m["message"], m["line"], m["column"], m["length"], m["severity"])


@dataclass
class SchemaReplaceRequest:
    """SCHEMA_REPLACE (``0x0127``). Destructive namespace swap.

    Unlike :class:`SchemaUploadRequest`, which merges, this DROPS every declared
    row in the namespace before the new document lands. Entities whose type
    disappears survive as orphans — readable as plain memories, no longer
    enriched from the typed-graph tables.

    ``force_drop_existing`` MUST be ``True``; the server rejects ``False`` with
    ``InvalidRequest``. It is deliberately not defaulted, so the irreversible
    intent is written at the call site.
    """

    schema_document: str
    force_drop_existing: bool
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "schema_document": self.schema_document,
            "force_drop_existing": self.force_drop_existing,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaReplaceRequest":
        return cls(m["schema_document"], m["force_drop_existing"], m["request_id"])


@dataclass
class SchemaReplaceResponse:
    """SCHEMA_REPLACE_RESP (``0x01A7``).

    ``dropped_count`` is how many declared rows were removed before the new
    schema took effect — the number a caller needs to understand what the swap
    destroyed. ``schema_version`` is always greater than the pre-replace one.
    """

    namespace: str
    schema_version: int
    dropped_count: int
    validation_errors: list[SchemaValidationError]

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "schema_version": self.schema_version,
            "dropped_count": self.dropped_count,
            "validation_errors": [e.to_map() for e in self.validation_errors],
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaReplaceResponse":
        return cls(
            m["namespace"],
            m["schema_version"],
            m["dropped_count"],
            [SchemaValidationError.from_map(e) for e in m.get("validation_errors", [])],
        )


@dataclass
class CancelStreamRequest:
    """CANCEL_STREAM (``0x0050``). Stop an in-flight stream.

    ``target_stream_id`` names the stream to stop; the request itself travels on
    a DIFFERENT stream id so it does not queue behind the frames it is
    cancelling. ``reason`` is ``"ClientUnneeded"``, ``"Timeout"``, or
    ``{"Other": "<text>"}`` — the CBOR shape of Brain's ``CancellationReason``
    enum, where unit variants are bare strings and the payload variant is a
    single-key map.
    """

    target_stream_id: int
    reason: object = "ClientUnneeded"

    def to_map(self) -> dict:
        return {"target_stream_id": self.target_stream_id, "reason": self.reason}

    @classmethod
    def from_map(cls, m: dict) -> "CancelStreamRequest":
        return cls(m["target_stream_id"], m.get("reason", "ClientUnneeded"))


@dataclass
class CancelStreamAck:
    """CANCEL_STREAM_ACK (``0x00D0``)."""

    target_stream_id: int
    cancelled_at_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "target_stream_id": self.target_stream_id,
            "cancelled_at_unix_nanos": self.cancelled_at_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "CancelStreamAck":
        return cls(m["target_stream_id"], m["cancelled_at_unix_nanos"])


@dataclass
class SchemaUploadResponse:
    """SCHEMA_UPLOAD_RESP (``0x01A0``). The resolved namespace and new version, any validation errors, whether the change is backward-compatible, and a migration summary."""

    namespace: str
    schema_version: int
    validation_errors: list[SchemaValidationError]
    backward_compatible: bool
    migration_summary_blob: list[int]  # Vec<u8> -> CBOR array of ints

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "schema_version": self.schema_version,
            "validation_errors": [e.to_map() for e in self.validation_errors],
            "backward_compatible": self.backward_compatible,
            "migration_summary_blob": list(self.migration_summary_blob),
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaUploadResponse":
        return cls(
            m["namespace"],
            m["schema_version"],
            [SchemaValidationError.from_map(e) for e in m["validation_errors"]],
            m["backward_compatible"],
            list(m["migration_summary_blob"]),
        )


@dataclass
class TimeRange:
    """An optional-bounded time window (unix-ms from/to) used as a query filter."""

    from_unix_ms: Optional[int]
    to_unix_ms: Optional[int]

    def to_map(self) -> dict:
        return {"from_unix_ms": self.from_unix_ms, "to_unix_ms": self.to_unix_ms}

    @classmethod
    def from_map(cls, m: dict) -> "TimeRange":
        return cls(m["from_unix_ms"], m["to_unix_ms"])


@dataclass
class FusionConfig:
    """RRF fusion tuning for a query — the ``k`` constant and per-retriever semantic/lexical/graph weights."""

    k: int
    semantic_weight: float  # f32
    lexical_weight: float  # f32
    graph_weight: float  # f32

    def to_map(self) -> dict:
        return {
            "k": self.k,
            "semantic_weight": round_f32(self.semantic_weight),
            "lexical_weight": round_f32(self.lexical_weight),
            "graph_weight": round_f32(self.graph_weight),
        }

    @classmethod
    def from_map(cls, m: dict) -> "FusionConfig":
        return cls(m["k"], m["semantic_weight"], m["lexical_weight"], m["graph_weight"])


@dataclass
class RetrieverSelection:
    """Externally-tagged routing: ``"Auto"`` unit string, or
    ``{"Explicit": ["Semantic", ...]}``.

    The retrievers are **variant-name strings**, not integers. The server
    declares ``RetrieverWire`` with plain ``serde::Serialize`` and
    ``#[repr(u8)]``; serde ignores ``repr`` and emits the variant name. The
    ``repr`` attribute is a Rust memory-layout hint and says nothing about the
    encoding — reading it as one is how this previously sent integers, which the
    server cannot deserialize.

    Contrast :class:`RetrieverName`, which carries the same three families as
    integers, because that one uses ``serde_repr``.
    """

    variant: str
    value: object = None

    @classmethod
    def auto(cls) -> "RetrieverSelection":
        return cls("Auto")

    @classmethod
    def explicit(cls, retrievers: list[str]) -> "RetrieverSelection":
        """``retrievers`` are :class:`Retriever` name strings."""
        return cls("Explicit", list(retrievers))

    def to_cbor_value(self) -> object:
        if self.variant == "Auto":
            return "Auto"
        return {"Explicit": list(self.value)}

    @classmethod
    def from_cbor_value(cls, v: object) -> "RetrieverSelection":
        if v == "Auto":
            return cls("Auto")
        return cls("Explicit", list(v["Explicit"]))


@dataclass
class QueryRequest:
    """Typed-graph query payload fusing the three retrievers: the cue text, optional entity anchor, kind/predicate/time/confidence filters, retriever selection, and fusion config. RECALL is the sole primary read verb; this payload is no longer a standalone op and is now carried only inside QUERY_EXPLAIN / QUERY_TRACE."""

    text: str
    entity_anchor: Optional[bytes]
    kind_filter: list[int]  # Vec<u8> -> array of ints
    predicate_filter: list[str]
    # Sessions to scope the query to; None or empty = no restriction (every
    # session in the caller's space). Mirrors RecallRequest.session_filter.
    session_filter: Optional[list[int]]
    time_filter: Optional[TimeRange]
    as_of_record_time_unix_nanos: Optional[int]
    confidence_min: Optional[float]  # f32 or None
    include_tombstoned: bool
    include_superseded: bool
    limit: int
    retrievers: RetrieverSelection
    fusion_config: Optional[FusionConfig]
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "text": self.text,
            "entity_anchor": self.entity_anchor,
            "kind_filter": list(self.kind_filter),
            "predicate_filter": list(self.predicate_filter),
            "session_filter": (
                None if self.session_filter is None else list(self.session_filter)
            ),
            "time_filter": None if self.time_filter is None else self.time_filter.to_map(),
            "as_of_record_time_unix_nanos": self.as_of_record_time_unix_nanos,
            "confidence_min": (
                None if self.confidence_min is None else round_f32(self.confidence_min)
            ),
            "include_tombstoned": self.include_tombstoned,
            "include_superseded": self.include_superseded,
            "limit": self.limit,
            "retrievers": self.retrievers.to_cbor_value(),
            "fusion_config": None if self.fusion_config is None else self.fusion_config.to_map(),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "QueryRequest":
        return cls(
            m["text"],
            m["entity_anchor"],
            list(m["kind_filter"]),
            list(m["predicate_filter"]),
            None if m["session_filter"] is None else list(m["session_filter"]),
            None if m["time_filter"] is None else TimeRange.from_map(m["time_filter"]),
            m["as_of_record_time_unix_nanos"],
            m["confidence_min"],
            m["include_tombstoned"],
            m["include_superseded"],
            m["limit"],
            RetrieverSelection.from_cbor_value(m["retrievers"]),
            None if m["fusion_config"] is None else FusionConfig.from_map(m["fusion_config"]),
            m["request_id"],
        )


@dataclass
class MaterializeProceduralRequest:
    """MATERIALIZE_PROCEDURAL (``0x0164``). Assemble a procedural-memory system block for a space: session filter, top-k, confidence floor, and category selection."""

    space_id: bytes  # 16-byte byte string (derived storage id)
    session_filter: Optional[list[int]]  # subset of session ids, or None for all
    top_k: int
    min_confidence: float  # f32
    categories: list[str]
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "session_filter": (
                None if self.session_filter is None else list(self.session_filter)
            ),
            "top_k": self.top_k,
            "min_confidence": round_f32(self.min_confidence),
            "categories": list(self.categories),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MaterializeProceduralRequest":
        return cls(
            m["space_id"],
            None if m["session_filter"] is None else list(m["session_filter"]),
            m["top_k"],
            m["min_confidence"],
            list(m["categories"]),
            m["request_id"],
        )


@dataclass
class MaterializeProceduralResponse:
    """MATERIALIZE_PROCEDURAL_RESP (``0x01E4``). The rendered system block, the statement ids it drew on, the candidate count, and whether budget trimmed it."""

    system_block: str
    statement_ids: list[bytes]  # list of 16-byte byte strings
    total_candidates: int
    trimmed_by_budget: bool

    def to_map(self) -> dict:
        return {
            "system_block": self.system_block,
            "statement_ids": list(self.statement_ids),
            "total_candidates": self.total_candidates,
            "trimmed_by_budget": self.trimmed_by_budget,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MaterializeProceduralResponse":
        return cls(
            m["system_block"],
            list(m["statement_ids"]),
            m["total_candidates"],
            m["trimmed_by_budget"],
        )


# ===========================================================================
# LINK / UNLINK.
# ===========================================================================


@dataclass
class LinkRequest:
    """LINK (``0x0025``). Add a directed edge between two memories: source, target, kind, weight, plus idempotency and txn ids."""

    source: int  # u128 MemoryId
    target: int  # u128 MemoryId
    kind: int
    weight: float  # f32
    request_id: bytes
    txn_id: Optional[bytes]
    # Effective identity this link runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "source": self.source,
            "target": self.target,
            "kind": self.kind,
            "weight": round_f32(self.weight),
            "request_id": self.request_id,
            "txn_id": self.txn_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "LinkRequest":
        act_as = m.get("act_as")
        return cls(
            m["source"],
            m["target"],
            m["kind"],
            m["weight"],
            m["request_id"],
            m["txn_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class LinkResponse:
    """LINK_RESP (``0x00A5``). The created edge's endpoints, kind, weight, creation time, and whether it already existed."""

    source: int
    target: int
    kind: int
    weight: float  # f32
    created_at_unix_nanos: int
    already_existed: bool

    def to_map(self) -> dict:
        return {
            "source": self.source,
            "target": self.target,
            "kind": self.kind,
            "weight": round_f32(self.weight),
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "already_existed": self.already_existed,
        }

    @classmethod
    def from_map(cls, m: dict) -> "LinkResponse":
        return cls(
            m["source"],
            m["target"],
            m["kind"],
            m["weight"],
            m["created_at_unix_nanos"],
            m["already_existed"],
        )


@dataclass
class UnlinkRequest:
    """UNLINK (``0x0026``). Remove the edge of a given kind between two memories, with idempotency and txn ids."""

    source: int
    target: int
    kind: int
    request_id: bytes
    txn_id: Optional[bytes]
    # Effective identity this unlink runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "source": self.source,
            "target": self.target,
            "kind": self.kind,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "UnlinkRequest":
        act_as = m.get("act_as")
        return cls(
            m["source"],
            m["target"],
            m["kind"],
            m["request_id"],
            m["txn_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class UnlinkResponse:
    """UNLINK_RESP (``0x00A6``). The targeted edge's endpoints and kind, and whether it was actually removed."""

    source: int
    target: int
    kind: int
    removed: bool

    def to_map(self) -> dict:
        return {
            "source": self.source,
            "target": self.target,
            "kind": self.kind,
            "removed": self.removed,
        }

    @classmethod
    def from_map(cls, m: dict) -> "UnlinkResponse":
        return cls(m["source"], m["target"], m["kind"], m["removed"])


# ===========================================================================
# PLAN.
# ===========================================================================


class PlanStrategy:
    """The search strategy requested for PLAN, as its on-wire integer discriminant."""

    AUTO = 0
    A_STAR = 1
    MCTS = 2
    ATTRACTOR_ROLLOUT = 3


class PlanStatus:
    """The terminal outcome of a PLAN run, as its on-wire integer discriminant."""

    GOAL_REACHED = 0
    BUDGET_EXHAUSTED = 1
    NO_PATH_FOUND = 2
    CANCELLED = 3


@dataclass
class PlanState:
    """Externally-tagged plan endpoint: ``{"ByMemoryId": u128}``,
    ``{"ByText": "..."}``, or ``{"ByVector": {"offset": u32, "dim": u16}}``.
    """

    variant: str
    value: object

    @classmethod
    def by_memory_id(cls, memory_id: int) -> "PlanState":
        return cls("ByMemoryId", memory_id)

    @classmethod
    def by_text(cls, text: str) -> "PlanState":
        return cls("ByText", text)

    @classmethod
    def by_vector(cls, offset: int, dim: int) -> "PlanState":
        return cls("ByVector", {"offset": offset, "dim": dim})

    def to_cbor_value(self) -> object:
        return {self.variant: self.value}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "PlanState":
        (variant, value), = v.items()
        if variant == "ByVector":
            return cls("ByVector", {"offset": value["offset"], "dim": value["dim"]})
        return cls(variant, value)


@dataclass
class TransitionKind:
    """Externally-tagged transition kind: unit variants ``"Initial"`` /
    ``"Causal"`` / ``"Temporal"`` / ``"Similarity"`` encode as strings;
    ``Other(str)`` encodes as ``{"Other": "..."}``.
    """

    variant: str
    value: object = None

    @classmethod
    def other(cls, label: str) -> "TransitionKind":
        return cls("Other", label)

    def to_cbor_value(self) -> object:
        if self.variant == "Other":
            return {"Other": self.value}
        return self.variant

    @classmethod
    def from_cbor_value(cls, v: object) -> "TransitionKind":
        if isinstance(v, dict):
            (variant, value), = v.items()
            return cls(variant, value)
        return cls(v)


@dataclass
class PlanBudget:
    """Search-cost bounds for a plan: max steps, wall-time, and branches explored."""

    max_steps: int
    max_wall_time_ms: int
    max_branches_explored: int

    def to_map(self) -> dict:
        return {
            "max_steps": self.max_steps,
            "max_wall_time_ms": self.max_wall_time_ms,
            "max_branches_explored": self.max_branches_explored,
        }

    @classmethod
    def from_map(cls, m: dict) -> "PlanBudget":
        return cls(m["max_steps"], m["max_wall_time_ms"], m["max_branches_explored"])


@dataclass
class PlanRequest:
    """PLAN (``0x0022``). Search for a memory path from ``start`` to ``goal`` under a budget, with an optional strategy hint, session filter, and idempotency/txn ids."""

    start: PlanState
    goal: PlanState
    budget: PlanBudget
    strategy_hint: Optional[int]
    session_filter: Optional[list[int]]
    request_id: Optional[bytes]
    txn_id: Optional[bytes]
    # Opt-in per-stage observability. Always present on the wire (defaults to
    # False); when True the final PLAN_RESP frame carries a populated
    # ``trace: PlanTrace`` describing every node the bidirectional BFS
    # visited (in both directions) and every meeting point found, including
    # the ones dropped by the ``max_paths`` cap. Mirrors ``RecallRequest.trace``.
    trace: bool = False
    # Effective identity this plan runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "start": self.start.to_cbor_value(),
            "goal": self.goal.to_cbor_value(),
            "budget": self.budget.to_map(),
            "strategy_hint": self.strategy_hint,
            "session_filter": (
                None if self.session_filter is None else list(self.session_filter)
            ),
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "trace": self.trace,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "PlanRequest":
        act_as = m.get("act_as")
        return cls(
            PlanState.from_cbor_value(m["start"]),
            PlanState.from_cbor_value(m["goal"]),
            PlanBudget.from_map(m["budget"]),
            m["strategy_hint"],
            None if m["session_filter"] is None else list(m["session_filter"]),
            m["request_id"],
            m["txn_id"],
            bool(m.get("trace", False)),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class PlanStep:
    """One step in a returned plan: its index, the memory, how the step was reached (transition kind), confidence, and estimated distance to goal."""

    step_index: int
    memory_id: int  # u128
    text: str
    transition_kind: TransitionKind
    confidence: float  # f32
    estimated_distance_to_goal: float  # f32

    def to_map(self) -> dict:
        return {
            "step_index": self.step_index,
            "memory_id": self.memory_id,
            "text": self.text,
            "transition_kind": self.transition_kind.to_cbor_value(),
            "confidence": round_f32(self.confidence),
            "estimated_distance_to_goal": round_f32(self.estimated_distance_to_goal),
        }

    @classmethod
    def from_map(cls, m: dict) -> "PlanStep":
        return cls(
            m["step_index"],
            m["memory_id"],
            m["text"],
            TransitionKind.from_cbor_value(m["transition_kind"]),
            m["confidence"],
            m["estimated_distance_to_goal"],
        )


@dataclass
class PlanResponseFrame:
    """PLAN_RESP (``0x00A2``), one streamed frame. The plan steps in this frame, the final flag, and the terminal plan status."""

    steps: list[PlanStep]
    is_final: bool
    plan_status: Optional[int]
    # Per-stage bidirectional-search trace, present only on the final frame
    # and only when the request set ``trace = True``; omitted from the CBOR
    # map otherwise. Mirrors ``RecallResponseFrame.trace``.
    trace: Optional["PlanTrace"] = None

    def to_map(self) -> dict:
        m = {
            "steps": [s.to_map() for s in self.steps],
            "is_final": self.is_final,
            "plan_status": self.plan_status,
        }
        if self.trace is not None:
            m["trace"] = self.trace.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "PlanResponseFrame":
        trace = m.get("trace")
        return cls(
            [PlanStep.from_map(s) for s in m["steps"]],
            m["is_final"],
            m["plan_status"],
            None if trace is None else PlanTrace.from_map(trace),
        )


# ===========================================================================
# PLAN trace (opt-in per-stage bidirectional-search observability).
# ===========================================================================


class PlanTraceDirection:
    """Which direction of the bidirectional BFS a ``PlanTraceNode`` was visited from, as its on-wire integer discriminant."""

    FORWARD = 0
    BACKWARD = 1


@dataclass
class PlanTraceNode:
    """One node the bidirectional BFS visited, from either direction: its
    memory, direction, depth, the edge it was reached through (``None`` for
    a root), and the goal-proximity alignment score when one was computed."""

    memory_id: int  # u128
    text: str
    direction: int  # PlanTraceDirection
    depth: int
    parent_edge: Optional[int]  # WireMemoryId or None
    alignment_score: Optional[float]  # f32 or None

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "direction": self.direction,
            "depth": self.depth,
            "parent_edge": self.parent_edge,
            "alignment_score": (
                None if self.alignment_score is None else round_f32(self.alignment_score)
            ),
        }

    @classmethod
    def from_map(cls, m: dict) -> "PlanTraceNode":
        return cls(
            m["memory_id"],
            m["text"],
            m["direction"],
            m["depth"],
            m["parent_edge"],
            m["alignment_score"],
        )


@dataclass
class PlanTraceMeetingPoint:
    """One meeting point the bidirectional BFS found where the forward and
    backward frontiers connected, flagging whether it survived the
    ``max_paths`` cap and contributed a path to the response."""

    memory_id: int  # u128
    text: str
    included_in_result: bool

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "included_in_result": self.included_in_result,
        }

    @classmethod
    def from_map(cls, m: dict) -> "PlanTraceMeetingPoint":
        return cls(m["memory_id"], m["text"], m["included_in_result"])


@dataclass
class PlanTrace:
    """Per-stage observability for one PLAN (surfaced on the final frame
    when the request set ``trace = True``): every node the bidirectional BFS
    visited in both directions, and every meeting point found (including
    ones dropped by the ``max_paths`` cap)."""

    explored: list[PlanTraceNode]
    meeting_points: list[PlanTraceMeetingPoint]

    def to_map(self) -> dict:
        return {
            "explored": [n.to_map() for n in self.explored],
            "meeting_points": [p.to_map() for p in self.meeting_points],
        }

    @classmethod
    def from_map(cls, m: dict) -> "PlanTrace":
        return cls(
            [PlanTraceNode.from_map(n) for n in m["explored"]],
            [PlanTraceMeetingPoint.from_map(p) for p in m["meeting_points"]],
        )


# ===========================================================================
# REASON.
# ===========================================================================


class ReasonStatus:
    """The terminal outcome of a REASON run, as its on-wire integer discriminant."""

    COMPLETE = 0
    BUDGET_EXHAUSTED = 1
    DEPTH_LIMIT_REACHED = 2
    CANCELLED = 3


@dataclass
class ObservationInput:
    """Externally-tagged: ``{"ByMemoryId": u128}`` or ``{"ByText": "..."}``."""

    variant: str
    value: object

    @classmethod
    def by_memory_id(cls, memory_id: int) -> "ObservationInput":
        return cls("ByMemoryId", memory_id)

    @classmethod
    def by_text(cls, text: str) -> "ObservationInput":
        return cls("ByText", text)

    def to_cbor_value(self) -> object:
        return {self.variant: self.value}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "ObservationInput":
        (variant, value), = v.items()
        return cls(variant, value)


@dataclass
class InferenceKind:
    """Externally-tagged: unit variants ``"CausalExplanation"`` /
    ``"EvidenceAccumulation"`` / ``"AnalogicalInference"`` encode as strings;
    ``Other(str)`` encodes as ``{"Other": "..."}``.
    """

    variant: str
    value: object = None

    @classmethod
    def other(cls, label: str) -> "InferenceKind":
        return cls("Other", label)

    def to_cbor_value(self) -> object:
        if self.variant == "Other":
            return {"Other": self.value}
        return self.variant

    @classmethod
    def from_cbor_value(cls, v: object) -> "InferenceKind":
        if isinstance(v, dict):
            (variant, value), = v.items()
            return cls(variant, value)
        return cls(v)


@dataclass
class ReasonRequest:
    """REASON (``0x0023``). Draw inferences from an observation: the input, search depth, confidence threshold, session filter, inference cap, and wall-time budget."""

    observation: ObservationInput
    depth: int
    confidence_threshold: float  # f32
    session_filter: Optional[list[int]]
    max_inferences: int
    budget_wall_time_ms: int
    request_id: Optional[bytes]
    txn_id: Optional[bytes]
    # Opt-in per-stage observability. Always present on the wire (defaults to
    # False); when True the final REASON_RESP frame carries a populated
    # ``trace: ReasonTrace`` describing the full base-candidate set, every
    # edge the outward walk considered (and why each was pruned), the
    # un-collapsed per-item score components, and whether topic-alignment
    # centroid computation ran. Mirrors ``RecallRequest.trace``.
    trace: bool = False
    # Effective identity this reason runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "observation": self.observation.to_cbor_value(),
            "depth": self.depth,
            "confidence_threshold": round_f32(self.confidence_threshold),
            "session_filter": (
                None if self.session_filter is None else list(self.session_filter)
            ),
            "max_inferences": self.max_inferences,
            "budget_wall_time_ms": self.budget_wall_time_ms,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "trace": self.trace,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "ReasonRequest":
        act_as = m.get("act_as")
        return cls(
            ObservationInput.from_cbor_value(m["observation"]),
            m["depth"],
            m["confidence_threshold"],
            None if m["session_filter"] is None else list(m["session_filter"]),
            m["max_inferences"],
            m["budget_wall_time_ms"],
            m["request_id"],
            m["txn_id"],
            bool(m.get("trace", False)),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class InferenceStep:
    """One inference in a reasoning chain: its index, the claim, supporting and contradicting memories, confidence, and inference kind."""

    step_index: int
    claim: str
    supporting_memories: list[int]  # list of u128
    contradicting_memories: list[int]  # list of u128
    confidence: float  # f32
    inference_kind: InferenceKind

    def to_map(self) -> dict:
        return {
            "step_index": self.step_index,
            "claim": self.claim,
            "supporting_memories": list(self.supporting_memories),
            "contradicting_memories": list(self.contradicting_memories),
            "confidence": round_f32(self.confidence),
            "inference_kind": self.inference_kind.to_cbor_value(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "InferenceStep":
        return cls(
            m["step_index"],
            m["claim"],
            list(m["supporting_memories"]),
            list(m["contradicting_memories"]),
            m["confidence"],
            InferenceKind.from_cbor_value(m["inference_kind"]),
        )


@dataclass
class ReasonResponseFrame:
    """REASON_RESP (``0x00A3``), one streamed frame. The inference steps in this frame, the final flag, and the terminal reason status."""

    inferences: list[InferenceStep]
    is_final: bool
    reason_status: Optional[int]
    # Per-stage read-pipeline trace, present only on the final frame and only
    # when the request set ``trace = True``; omitted from the CBOR map
    # otherwise. Mirrors ``RecallResponseFrame.trace``.
    trace: Optional["ReasonTrace"] = None

    def to_map(self) -> dict:
        m = {
            "inferences": [i.to_map() for i in self.inferences],
            "is_final": self.is_final,
            "reason_status": self.reason_status,
        }
        if self.trace is not None:
            m["trace"] = self.trace.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "ReasonResponseFrame":
        trace = m.get("trace")
        return cls(
            [InferenceStep.from_map(i) for i in m["inferences"]],
            m["is_final"],
            m["reason_status"],
            None if trace is None else ReasonTrace.from_map(trace),
        )


# ===========================================================================
# REASON trace (opt-in per-stage evidence-walk observability).
# ===========================================================================


@dataclass
class ReasonTraceCandidate:
    """One base-candidate hit surfaced in a REASON trace: its memory id, text, and HNSW score."""

    memory_id: int  # u128
    text: str
    score: float  # f32

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "score": round_f32(self.score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceCandidate":
        return cls(m["memory_id"], m["text"], m["score"])


@dataclass
class ReasonTraceBase:
    """The base observation's resolved candidate set, before any evidence walk — the full HNSW hit set, not just the subset that seeded the walk."""

    candidates: list[ReasonTraceCandidate]

    def to_map(self) -> dict:
        return {"candidates": [c.to_map() for c in self.candidates]}

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceBase":
        return cls([ReasonTraceCandidate.from_map(c) for c in m["candidates"]])


@dataclass
class ReasonTraceEdgeCandidate:
    """One edge the outward evidence walk visited, considered or dropped: the target memory, edge kind, depth, source memory, and raw score."""

    memory_id: int  # u128
    text: str
    edge_kind: int  # EdgeKind
    depth: int
    from_memory_id: int  # u128
    raw_score: float  # f32

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "edge_kind": self.edge_kind,
            "depth": self.depth,
            "from_memory_id": self.from_memory_id,
            "raw_score": round_f32(self.raw_score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceEdgeCandidate":
        return cls(
            m["memory_id"],
            m["text"],
            m["edge_kind"],
            m["depth"],
            m["from_memory_id"],
            m["raw_score"],
        )


@dataclass
class ReasonTraceIdWithText:
    """A memory id plus its stored text, with no other payload — the shared
    shape for the walk's plain id-dropped buckets (tombstone / visited /
    trim-cap) so an opaque id is never surfaced without the content that
    explains the drop."""

    memory_id: int  # u128
    text: str

    def to_map(self) -> dict:
        return {"memory_id": self.memory_id, "text": self.text}

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceIdWithText":
        return cls(m["memory_id"], m["text"])


@dataclass
class ReasonTraceScoredId:
    """A memory id plus its stored text, paired with the score it was dropped at."""

    memory_id: int  # u128
    text: str
    score: float  # f32

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "score": round_f32(self.score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceScoredId":
        return cls(m["memory_id"], m["text"], m["score"])


@dataclass
class ReasonTraceWalk:
    """Everything the outward evidence walk considered and every reason an
    edge or item was pruned before becoming a surviving ``InferenceStep``."""

    considered: list[ReasonTraceEdgeCandidate]
    dropped_by_edge_kind: list[ReasonTraceEdgeCandidate]
    dropped_by_tombstone: list[ReasonTraceIdWithText]
    dropped_by_visited: list[ReasonTraceIdWithText]
    dropped_by_confidence: list[ReasonTraceScoredId]
    dropped_by_max_supporting: list[ReasonTraceIdWithText]
    dropped_by_max_contradicting: list[ReasonTraceIdWithText]

    def to_map(self) -> dict:
        return {
            "considered": [c.to_map() for c in self.considered],
            "dropped_by_edge_kind": [c.to_map() for c in self.dropped_by_edge_kind],
            "dropped_by_tombstone": [c.to_map() for c in self.dropped_by_tombstone],
            "dropped_by_visited": [c.to_map() for c in self.dropped_by_visited],
            "dropped_by_confidence": [c.to_map() for c in self.dropped_by_confidence],
            "dropped_by_max_supporting": [c.to_map() for c in self.dropped_by_max_supporting],
            "dropped_by_max_contradicting": [
                c.to_map() for c in self.dropped_by_max_contradicting
            ],
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceWalk":
        return cls(
            [ReasonTraceEdgeCandidate.from_map(c) for c in m["considered"]],
            [ReasonTraceEdgeCandidate.from_map(c) for c in m["dropped_by_edge_kind"]],
            [ReasonTraceIdWithText.from_map(c) for c in m["dropped_by_tombstone"]],
            [ReasonTraceIdWithText.from_map(c) for c in m["dropped_by_visited"]],
            [ReasonTraceScoredId.from_map(c) for c in m["dropped_by_confidence"]],
            [ReasonTraceIdWithText.from_map(c) for c in m["dropped_by_max_supporting"]],
            [ReasonTraceIdWithText.from_map(c) for c in m["dropped_by_max_contradicting"]],
        )


@dataclass
class ReasonTraceScoreBreakdown:
    """The un-collapsed multiplicative score components combined into one
    ``InferenceStep.confidence`` value, for one surviving evidence item."""

    memory_id: int  # u128
    text: str
    base_similarity: float  # f32
    decay: float  # f32
    weight_product: float  # f32
    alignment: float  # f32
    # Structural-fit nudge from VSA analogical inference (bind/bundle/
    # analogy_query over the item's statement-graph triple against the
    # observation's own triple). Neutral 1.0 when no triple is resolvable
    # for the item -- a re-rank nudge only, never a gate.
    analogical_fit: float  # f32
    final_score: float  # f32

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "text": self.text,
            "base_similarity": round_f32(self.base_similarity),
            "decay": round_f32(self.decay),
            "weight_product": round_f32(self.weight_product),
            "alignment": round_f32(self.alignment),
            "analogical_fit": round_f32(self.analogical_fit),
            "final_score": round_f32(self.final_score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceScoreBreakdown":
        return cls(
            m["memory_id"],
            m["text"],
            m["base_similarity"],
            m["decay"],
            m["weight_product"],
            m["alignment"],
            m["analogical_fit"],
            m["final_score"],
        )


@dataclass
class ReasonTraceCentroid:
    """Whether topic-alignment centroid computation ran for this REASON, and
    why not when it didn't (``build_base_centroid`` silently returns
    ``None`` on several paths — singleton base, ``ByText`` observation,
    missing text, embed error)."""

    computed: bool
    skipped_reason: Optional[str]

    def to_map(self) -> dict:
        return {"computed": self.computed, "skipped_reason": self.skipped_reason}

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTraceCentroid":
        return cls(m["computed"], m["skipped_reason"])


@dataclass
class ReasonTrace:
    """Per-stage observability for one REASON (surfaced on the final frame
    when the request set ``trace = True``): the full base-candidate set, the
    outward evidence walk (considered edges + every prune reason), the
    un-collapsed per-item score components, and the centroid outcome."""

    base: ReasonTraceBase
    walk: ReasonTraceWalk
    scoring: list[ReasonTraceScoreBreakdown]
    centroid: ReasonTraceCentroid

    def to_map(self) -> dict:
        return {
            "base": self.base.to_map(),
            "walk": self.walk.to_map(),
            "scoring": [s.to_map() for s in self.scoring],
            "centroid": self.centroid.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "ReasonTrace":
        return cls(
            ReasonTraceBase.from_map(m["base"]),
            ReasonTraceWalk.from_map(m["walk"]),
            [ReasonTraceScoreBreakdown.from_map(s) for s in m["scoring"]],
            ReasonTraceCentroid.from_map(m["centroid"]),
        )


# ===========================================================================
# TXN_BEGIN / TXN_COMMIT / TXN_ABORT.
# ===========================================================================


@dataclass
class TxnBeginRequest:
    """TXN_BEGIN (``0x0040``). Open a transaction under a client-chosen id, with a timeout."""

    txn_id: bytes
    timeout_seconds: int

    def to_map(self) -> dict:
        return {"txn_id": self.txn_id, "timeout_seconds": self.timeout_seconds}

    @classmethod
    def from_map(cls, m: dict) -> "TxnBeginRequest":
        return cls(m["txn_id"], m["timeout_seconds"])


@dataclass
class TxnBeginResponse:
    """TXN_BEGIN_RESP (``0x00C0``). The transaction id, its timeout, and when it started."""

    txn_id: bytes
    timeout_seconds: int
    started_at_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "txn_id": self.txn_id,
            "timeout_seconds": self.timeout_seconds,
            "started_at_unix_nanos": self.started_at_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "TxnBeginResponse":
        return cls(m["txn_id"], m["timeout_seconds"], m["started_at_unix_nanos"])


@dataclass
class TxnCommitRequest:
    """TXN_COMMIT (``0x0041``). Commit the transaction with the given id."""

    txn_id: bytes

    def to_map(self) -> dict:
        return {"txn_id": self.txn_id}

    @classmethod
    def from_map(cls, m: dict) -> "TxnCommitRequest":
        return cls(m["txn_id"])


@dataclass
class TxnCommitResponse:
    """TXN_COMMIT_RESP (``0x00C1``). The transaction id, commit time, and how many operations were applied."""

    txn_id: bytes
    committed_at_unix_nanos: int
    operations_applied: int

    def to_map(self) -> dict:
        return {
            "txn_id": self.txn_id,
            "committed_at_unix_nanos": self.committed_at_unix_nanos,
            "operations_applied": self.operations_applied,
        }

    @classmethod
    def from_map(cls, m: dict) -> "TxnCommitResponse":
        return cls(m["txn_id"], m["committed_at_unix_nanos"], m["operations_applied"])


@dataclass
class TxnAbortRequest:
    """TXN_ABORT (``0x0042``). Abort the transaction with the given id."""

    txn_id: bytes

    def to_map(self) -> dict:
        return {"txn_id": self.txn_id}

    @classmethod
    def from_map(cls, m: dict) -> "TxnAbortRequest":
        return cls(m["txn_id"])


@dataclass
class TxnAbortResponse:
    """TXN_ABORT_RESP (``0x00C2``). The transaction id and how many operations were discarded."""

    txn_id: bytes
    operations_discarded: int

    def to_map(self) -> dict:
        return {"txn_id": self.txn_id, "operations_discarded": self.operations_discarded}

    @classmethod
    def from_map(cls, m: dict) -> "TxnAbortResponse":
        return cls(m["txn_id"], m["operations_discarded"])


# ===========================================================================
# SUBSCRIBE / UNSUBSCRIBE + the subscription event union.
# ===========================================================================


class EventType:
    """The kind of change a subscription event reports, as its on-wire integer discriminant."""

    # Cognitive events.
    ENCODED = 0
    FORGOTTEN = 1
    RECLAIMED = 2
    KIND_CHANGED = 3
    # Typed-graph events (graph_payload populated).
    ENTITY_CREATED = 16
    ENTITY_UPDATED = 17
    ENTITY_RENAMED = 18
    ENTITY_MERGED = 19
    ENTITY_UNMERGED = 20
    ENTITY_TOMBSTONED = 21
    STATEMENT_CREATED = 22
    STATEMENT_SUPERSEDED = 23
    STATEMENT_TOMBSTONED = 24
    RELATION_CREATED = 25
    RELATION_SUPERSEDED = 26
    STAGE_COMPLETED = 27
    SCHEMA_UPDATED = 29
    RELATION_TOMBSTONED = 30
    # Unified-edge change feed (edge_payload populated).
    EDGE_ADDED = 31
    EDGE_REMOVED = 32
    EDGE_SUPERSEDED = 33


class StageOutcome:
    """The result of a write-pipeline background stage, as its on-wire integer discriminant."""

    OK = 0
    EMPTY = 1
    FAILED = 2


class StageAuditStatus:
    """The audit disposition of an extractor stage, as its on-wire integer discriminant."""

    SUCCEEDED = 0
    PARTIALLY_APPLIED = 1
    FAILED = 2
    SKIPPED = 3


@dataclass
class StageAutoEdgePayload:
    """Auto-edge stage detail: how many edges the stage wrote."""

    edges_written: int

    def to_map(self) -> dict:
        return {"edges_written": self.edges_written}

    @classmethod
    def from_map(cls, m: dict) -> "StageAutoEdgePayload":
        return cls(m["edges_written"])


@dataclass
class StageTemporalEdgePayload:
    """Temporal-edge stage detail: how many edges the stage wrote."""

    edges_written: int

    def to_map(self) -> dict:
        return {"edges_written": self.edges_written}

    @classmethod
    def from_map(cls, m: dict) -> "StageTemporalEdgePayload":
        return cls(m["edges_written"])


@dataclass
class StageHypePayload:
    """HyPE stage detail: how many hypothetical questions were embedded and
    persisted, and the LLM micro-USD spent generating them (``0`` on a cache
    hit)."""

    questions_written: int
    cost_micro_usd: int

    def to_map(self) -> dict:
        return {
            "questions_written": self.questions_written,
            "cost_micro_usd": self.cost_micro_usd,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StageHypePayload":
        return cls(m["questions_written"], m["cost_micro_usd"])


@dataclass
class StageExtractorPayload:
    """Extractor stage detail: entity/statement/relation counts, the audit status, and any error message."""

    entity_count: int
    statement_count: int
    relation_count: int
    audit_status: int
    error_message: str

    def to_map(self) -> dict:
        return {
            "entity_count": self.entity_count,
            "statement_count": self.statement_count,
            "relation_count": self.relation_count,
            "audit_status": self.audit_status,
            "error_message": self.error_message,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StageExtractorPayload":
        return cls(
            m["entity_count"],
            m["statement_count"],
            m["relation_count"],
            m["audit_status"],
            m["error_message"],
        )


@dataclass
class StagePayload:
    """Externally-tagged per-stage detail: ``{"AutoEdge": {...}}`` /
    ``{"TemporalEdge": {...}}`` / ``{"Extractor": {...}}`` / ``{"Hype": {...}}``.
    """

    variant: str
    value: object

    def to_cbor_value(self) -> object:
        return {self.variant: self.value.to_map()}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "StagePayload":
        (variant, value), = v.items()
        if variant == "AutoEdge":
            return cls("AutoEdge", StageAutoEdgePayload.from_map(value))
        if variant == "TemporalEdge":
            return cls("TemporalEdge", StageTemporalEdgePayload.from_map(value))
        if variant == "Extractor":
            return cls("Extractor", StageExtractorPayload.from_map(value))
        if variant == "Hype":
            return cls("Hype", StageHypePayload.from_map(value))
        raise ValueError(f"unknown stage payload variant {variant!r}")


@dataclass
class SimilarityFilter:
    """A subscription filter admitting only memories similar to a reference memory above a threshold."""

    reference_memory_id: int  # u128
    threshold: float  # f32

    def to_map(self) -> dict:
        return {
            "reference_memory_id": self.reference_memory_id,
            "threshold": round_f32(self.threshold),
        }

    @classmethod
    def from_map(cls, m: dict) -> "SimilarityFilter":
        return cls(m["reference_memory_id"], m["threshold"])


@dataclass
class SubscriptionFilter:
    """The selection filter on a subscription: optional session, kind, similarity, space-subset, and memory-id-subset constraints (None = no constraint)."""

    session_filter: Optional[list[int]]
    kinds: Optional[list[int]]
    similar_to: Optional[SimilarityFilter]
    spaces: Optional[list[bytes]]  # subset of space ids (16-byte), or None for all
    memory_ids: Optional[list[int]] = None  # subset of memory ids (u128), or None for all

    def to_map(self) -> dict:
        return {
            "session_filter": None if self.session_filter is None else list(self.session_filter),
            "kinds": None if self.kinds is None else list(self.kinds),
            "similar_to": None if self.similar_to is None else self.similar_to.to_map(),
            "spaces": None if self.spaces is None else list(self.spaces),
            "memory_ids": None if self.memory_ids is None else list(self.memory_ids),
        }

    @classmethod
    def from_map(cls, m: dict) -> "SubscriptionFilter":
        return cls(
            None if m["session_filter"] is None else list(m["session_filter"]),
            None if m["kinds"] is None else list(m["kinds"]),
            None if m["similar_to"] is None else SimilarityFilter.from_map(m["similar_to"]),
            None if m["spaces"] is None else list(m["spaces"]),
            None if m.get("memory_ids") is None else list(m["memory_ids"]),
        )


@dataclass
class SubscribeRequest:
    """SUBSCRIBE (``0x0030``). Open an event stream under a filter, with history replay, an optional starting LSN, and an in-flight cap."""

    filter: SubscriptionFilter
    include_history: bool
    from_lsn: Optional[int]
    max_inflight: int
    # Effective identity this subscription runs as, on behalf of the
    # authenticated connection principal. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "filter": self.filter.to_map(),
            "include_history": self.include_history,
            "from_lsn": self.from_lsn,
            "max_inflight": self.max_inflight,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SubscribeRequest":
        act_as = m.get("act_as")
        return cls(
            SubscriptionFilter.from_map(m["filter"]),
            m["include_history"],
            m["from_lsn"],
            m["max_inflight"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EdgeEventPayload:
    """The unified-edge change carried by an edge event: typed endpoints, edge-kind tag/byte, relation type and id, weight, superseded id, and origin."""

    from_kind: int  # 0 = Memory, 1 = Entity
    from_id: bytes
    to_kind: int
    to_id: bytes
    edge_kind_tag: int  # 0 = Builtin, 1 = Mentions, 2 = Typed relation
    edge_kind_byte: int
    relation_type_id: Optional[int]
    weight: float  # f32
    relation_id: Optional[bytes]
    superseded_relation_id: Optional[bytes]
    origin: int  # 0 = EXPLICIT, 1 = AUTO_DERIVED

    def to_map(self) -> dict:
        return {
            "from_kind": self.from_kind,
            "from_id": self.from_id,
            "to_kind": self.to_kind,
            "to_id": self.to_id,
            "edge_kind_tag": self.edge_kind_tag,
            "edge_kind_byte": self.edge_kind_byte,
            "relation_type_id": self.relation_type_id,
            "weight": round_f32(self.weight),
            "relation_id": self.relation_id,
            "superseded_relation_id": self.superseded_relation_id,
            "origin": self.origin,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EdgeEventPayload":
        return cls(
            m["from_kind"],
            m["from_id"],
            m["to_kind"],
            m["to_id"],
            m["edge_kind_tag"],
            m["edge_kind_byte"],
            m["relation_type_id"],
            m["weight"],
            m["relation_id"],
            m["superseded_relation_id"],
            m["origin"],
        )


@dataclass
class EntityCreatedEvent:
    """Graph event body for an entity creation: the new entity's id, type, and canonical name."""

    entity_id: bytes
    entity_type_id: int
    canonical_name: str

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "entity_type_id": self.entity_type_id,
            "canonical_name": self.canonical_name,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityCreatedEvent":
        return cls(m["entity_id"], m["entity_type_id"], m["canonical_name"])


@dataclass
class EntityUpdatedEvent:
    """Graph event body for an entity update: id, type, canonical name, and whether its embedding version changed."""

    entity_id: bytes
    entity_type_id: int
    canonical_name: str
    embedding_version_changed: bool

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "entity_type_id": self.entity_type_id,
            "canonical_name": self.canonical_name,
            "embedding_version_changed": self.embedding_version_changed,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityUpdatedEvent":
        return cls(
            m["entity_id"],
            m["entity_type_id"],
            m["canonical_name"],
            m["embedding_version_changed"],
        )


@dataclass
class EntityRenamedEvent:
    """Graph event body for an entity rename: the id, old and new canonical names, and whether the old name became an alias."""

    entity_id: bytes
    old_canonical_name: str
    new_canonical_name: str
    old_moved_to_alias: bool

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "old_canonical_name": self.old_canonical_name,
            "new_canonical_name": self.new_canonical_name,
            "old_moved_to_alias": self.old_moved_to_alias,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityRenamedEvent":
        return cls(
            m["entity_id"],
            m["old_canonical_name"],
            m["new_canonical_name"],
            m["old_moved_to_alias"],
        )


@dataclass
class EntityMergedEvent:
    """Graph event body for an entity merge: survivor and merged ids, the audit id, confidence, and how many statements/relations were rerouted."""

    survivor: bytes
    merged: bytes
    audit_id: bytes
    confidence: float  # f32
    statements_rerouted: int
    relations_rerouted: int

    def to_map(self) -> dict:
        return {
            "survivor": self.survivor,
            "merged": self.merged,
            "audit_id": self.audit_id,
            "confidence": round_f32(self.confidence),
            "statements_rerouted": self.statements_rerouted,
            "relations_rerouted": self.relations_rerouted,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityMergedEvent":
        return cls(
            m["survivor"],
            m["merged"],
            m["audit_id"],
            m["confidence"],
            m["statements_rerouted"],
            m["relations_rerouted"],
        )


@dataclass
class EntityUnmergedEvent:
    """Graph event body for an entity unmerge: the restored entity id, the survivor it split from, and the audit id."""

    restored_entity_id: bytes
    from_survivor: bytes
    audit_id: bytes

    def to_map(self) -> dict:
        return {
            "restored_entity_id": self.restored_entity_id,
            "from_survivor": self.from_survivor,
            "audit_id": self.audit_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityUnmergedEvent":
        return cls(m["restored_entity_id"], m["from_survivor"], m["audit_id"])


@dataclass
class EntityTombstonedEvent:
    """Graph event body for an entity tombstone: the entity id and the reason."""

    entity_id: bytes
    reason: str

    def to_map(self) -> dict:
        return {"entity_id": self.entity_id, "reason": self.reason}

    @classmethod
    def from_map(cls, m: dict) -> "EntityTombstonedEvent":
        return cls(m["entity_id"], m["reason"])


@dataclass
class StatementCreatedEvent:
    """Graph event body for a statement creation: id, kind, subject, predicate, and confidence."""

    statement_id: bytes
    kind: int  # 1=Fact, 2=Preference, 3=Event
    subject: bytes
    predicate: str
    confidence: float  # f32

    def to_map(self) -> dict:
        return {
            "statement_id": self.statement_id,
            "kind": self.kind,
            "subject": self.subject,
            "predicate": self.predicate,
            "confidence": round_f32(self.confidence),
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementCreatedEvent":
        return cls(m["statement_id"], m["kind"], m["subject"], m["predicate"], m["confidence"])


@dataclass
class StatementSupersededEvent:
    """Graph event body for a statement supersession: the old and new statement ids and their chain root."""

    old_statement_id: bytes
    new_statement_id: bytes
    chain_root: bytes

    def to_map(self) -> dict:
        return {
            "old_statement_id": self.old_statement_id,
            "new_statement_id": self.new_statement_id,
            "chain_root": self.chain_root,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementSupersededEvent":
        return cls(m["old_statement_id"], m["new_statement_id"], m["chain_root"])


@dataclass
class StatementTombstonedEvent:
    """Graph event body for a statement tombstone: the statement id and the reason."""

    statement_id: bytes
    reason: str

    def to_map(self) -> dict:
        return {"statement_id": self.statement_id, "reason": self.reason}

    @classmethod
    def from_map(cls, m: dict) -> "StatementTombstonedEvent":
        return cls(m["statement_id"], m["reason"])


@dataclass
class RelationCreatedEvent:
    """Graph event body for a relation creation: the relation id, its type, and its from/to endpoints."""

    relation_id: bytes
    relation_type: str
    from_: bytes
    to: bytes

    def to_map(self) -> dict:
        return {
            "relation_id": self.relation_id,
            "relation_type": self.relation_type,
            "from": self.from_,
            "to": self.to,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationCreatedEvent":
        return cls(m["relation_id"], m["relation_type"], m["from"], m["to"])


@dataclass
class RelationSupersededEvent:
    """Graph event body for a relation supersession: the old and new relation ids."""

    old_relation_id: bytes
    new_relation_id: bytes

    def to_map(self) -> dict:
        return {
            "old_relation_id": self.old_relation_id,
            "new_relation_id": self.new_relation_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationSupersededEvent":
        return cls(m["old_relation_id"], m["new_relation_id"])


@dataclass
class RelationTombstonedEvent:
    """Graph event body for a relation tombstone: the relation id and the reason."""

    relation_id: bytes
    reason: str

    def to_map(self) -> dict:
        return {"relation_id": self.relation_id, "reason": self.reason}

    @classmethod
    def from_map(cls, m: dict) -> "RelationTombstonedEvent":
        return cls(m["relation_id"], m["reason"])


@dataclass
class SchemaUpdatedEvent:
    """Graph event body for a schema change: the namespace, its from/to versions, and whether the change is backward-compatible."""

    namespace: str
    from_version: int
    to_version: int
    backward_compatible: bool

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "from_version": self.from_version,
            "to_version": self.to_version,
            "backward_compatible": self.backward_compatible,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaUpdatedEvent":
        return cls(
            m["namespace"], m["from_version"], m["to_version"], m["backward_compatible"]
        )


_GRAPH_EVENT_TYPES = {
    "EntityCreated": EntityCreatedEvent,
    "EntityUpdated": EntityUpdatedEvent,
    "EntityRenamed": EntityRenamedEvent,
    "EntityMerged": EntityMergedEvent,
    "EntityUnmerged": EntityUnmergedEvent,
    "EntityTombstoned": EntityTombstonedEvent,
    "StatementCreated": StatementCreatedEvent,
    "StatementSuperseded": StatementSupersededEvent,
    "StatementTombstoned": StatementTombstonedEvent,
    "RelationCreated": RelationCreatedEvent,
    "RelationSuperseded": RelationSupersededEvent,
    "RelationTombstoned": RelationTombstonedEvent,
    "SchemaUpdated": SchemaUpdatedEvent,
}


@dataclass
class GraphEventPayload:
    """Externally-tagged typed-graph event body, e.g.
    ``{"EntityCreated": {...}}``. ``variant`` names the event kind; ``value``
    is the matching event dataclass.
    """

    variant: str
    value: object

    def to_cbor_value(self) -> object:
        return {self.variant: self.value.to_map()}

    @classmethod
    def from_cbor_value(cls, v: dict) -> "GraphEventPayload":
        (variant, value), = v.items()
        body_type = _GRAPH_EVENT_TYPES.get(variant)
        if body_type is None:
            raise ValueError(f"unknown graph event variant {variant!r}")
        return cls(variant, body_type.from_map(value))


@dataclass
class SubscriptionEvent:
    """SUBSCRIBE_EVENT (``0x00B0``). One pushed event: the event type and core memory fields, plus the optional graph, edge, or stage payload for typed-graph and pipeline events."""

    event_type: int
    memory_id: int  # u128
    session_id: int
    text: str
    kind: int
    salience: float  # f32
    timestamp_unix_nanos: int
    lsn: int
    graph_payload: Optional[GraphEventPayload]
    edge_payload: Optional[EdgeEventPayload]
    stage_kind: Optional[int]
    stage_outcome: Optional[int]
    stage_payload: Optional[StagePayload]

    def to_map(self) -> dict:
        return {
            "event_type": self.event_type,
            "memory_id": self.memory_id,
            "session_id": self.session_id,
            "text": self.text,
            "kind": self.kind,
            "salience": round_f32(self.salience),
            "timestamp_unix_nanos": self.timestamp_unix_nanos,
            "lsn": self.lsn,
            "graph_payload": (
                None if self.graph_payload is None else self.graph_payload.to_cbor_value()
            ),
            "edge_payload": None if self.edge_payload is None else self.edge_payload.to_map(),
            "stage_kind": self.stage_kind,
            "stage_outcome": self.stage_outcome,
            "stage_payload": (
                None if self.stage_payload is None else self.stage_payload.to_cbor_value()
            ),
        }

    @classmethod
    def from_map(cls, m: dict) -> "SubscriptionEvent":
        return cls(
            m["event_type"],
            m["memory_id"],
            m["session_id"],
            m["text"],
            m["kind"],
            m["salience"],
            m["timestamp_unix_nanos"],
            m["lsn"],
            None if m["graph_payload"] is None else GraphEventPayload.from_cbor_value(m["graph_payload"]),
            None if m["edge_payload"] is None else EdgeEventPayload.from_map(m["edge_payload"]),
            m["stage_kind"],
            m["stage_outcome"],
            None if m["stage_payload"] is None else StagePayload.from_cbor_value(m["stage_payload"]),
        )


@dataclass
class UnsubscribeRequest:
    """UNSUBSCRIBE (``0x0031``). Close the subscription on the given stream id."""

    target_stream_id: int

    def to_map(self) -> dict:
        return {"target_stream_id": self.target_stream_id}

    @classmethod
    def from_map(cls, m: dict) -> "UnsubscribeRequest":
        return cls(m["target_stream_id"])


@dataclass
class UnsubscribeResponse:
    """UNSUBSCRIBE_RESP (``0x00B1``). The closed stream id and the final LSN delivered."""

    target_stream_id: int
    final_lsn: int

    def to_map(self) -> dict:
        return {"target_stream_id": self.target_stream_id, "final_lsn": self.final_lsn}

    @classmethod
    def from_map(cls, m: dict) -> "UnsubscribeResponse":
        return cls(m["target_stream_id"], m["final_lsn"])


# ===========================================================================
# GET_CAPABILITIES.
# ===========================================================================


@dataclass
class GetCapabilitiesRequest:
    """Empty request — capabilities are server-side state. Encodes as an empty
    CBOR map, matching every other request body."""

    def to_map(self) -> dict:
        return {}

    @classmethod
    def from_map(cls, m: dict) -> "GetCapabilitiesRequest":
        return cls()


@dataclass
class Capabilities:
    """The live capability set of the connected shard: rerank and extractor-tier flags, the active schema namespaces, and the embedding vector dimension."""

    rerank: bool
    llm_extractor: bool
    classifier_extractor: bool
    pattern_extractor: bool
    schema_namespaces: list[str]
    vector_dim: int

    def to_map(self) -> dict:
        return {
            "rerank": self.rerank,
            "llm_extractor": self.llm_extractor,
            "classifier_extractor": self.classifier_extractor,
            "pattern_extractor": self.pattern_extractor,
            "schema_namespaces": list(self.schema_namespaces),
            "vector_dim": self.vector_dim,
        }

    @classmethod
    def from_map(cls, m: dict) -> "Capabilities":
        return cls(
            m["rerank"],
            m["llm_extractor"],
            m["classifier_extractor"],
            m["pattern_extractor"],
            list(m["schema_namespaces"]),
            m["vector_dim"],
        )


@dataclass
class GetCapabilitiesResponse:
    """GET_CAPABILITIES_RESP (``0x00B2``). The connected shard's live capability set."""

    capabilities: Capabilities

    def to_map(self) -> dict:
        return {"capabilities": self.capabilities.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "GetCapabilitiesResponse":
        return cls(Capabilities.from_map(m["capabilities"]))


# ===========================================================================
# EXTRACTOR_LIST.
# ===========================================================================


@dataclass
class ExtractorListRequest:
    """EXTRACTOR_LIST (``0x0124``). Empty request — every registered
    extractor is returned. Extraction is always-on; this is read-only
    introspection with no runtime enable/disable. Encodes as an empty CBOR
    map, matching every other request body."""

    def to_map(self) -> dict:
        return {}

    @classmethod
    def from_map(cls, m: dict) -> "ExtractorListRequest":
        return cls()


@dataclass
class ExtractorListItem:
    """One registered extractor: its id, owning namespace, name, tier kind
    (``0``=pattern, ``1``=classifier, ``2``=llm), the schema version it was
    registered against, and its creation timestamp."""

    extractor_id: int
    namespace: str
    name: str
    kind: int
    schema_version: int
    created_at_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "extractor_id": self.extractor_id,
            "namespace": self.namespace,
            "name": self.name,
            "kind": self.kind,
            "schema_version": self.schema_version,
            "created_at_unix_nanos": self.created_at_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ExtractorListItem":
        return cls(
            m["extractor_id"],
            m["namespace"],
            m["name"],
            m["kind"],
            m["schema_version"],
            m["created_at_unix_nanos"],
        )


@dataclass
class ExtractorListResponseFrame:
    """EXTRACTOR_LIST_RESP (``0x01A4``). A single-frame snapshot in v1 (a
    later cut may split into streaming), carrying the registered extractors,
    the total count, and ``is_final`` (always ``True`` in v1)."""

    items: list[ExtractorListItem]
    total: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "total": self.total,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ExtractorListResponseFrame":
        return cls(
            [ExtractorListItem.from_map(i) for i in m["items"]],
            m["total"],
            m["is_final"],
        )


# ===========================================================================
# ENTITY_GET / ENTITY_LIST.
# ===========================================================================


@dataclass
class EntityView:
    """The full stored view of a typed-graph entity: ids, names and aliases, attributes blob, mention count, timestamps, merge target, embedding version, and flags."""

    entity_id: bytes
    entity_type_id: int
    canonical_name: str
    normalized_name: str
    aliases: list[str]
    attributes_blob: list[int]  # Vec<u8> -> array of ints
    mention_count: int
    created_at_unix_nanos: int
    updated_at_unix_nanos: int
    merged_into: bytes  # all-zero when not merged
    embedding_version: int
    flags: int

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "entity_type_id": self.entity_type_id,
            "canonical_name": self.canonical_name,
            "normalized_name": self.normalized_name,
            "aliases": list(self.aliases),
            "attributes_blob": list(self.attributes_blob),
            "mention_count": self.mention_count,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "updated_at_unix_nanos": self.updated_at_unix_nanos,
            "merged_into": self.merged_into,
            "embedding_version": self.embedding_version,
            "flags": self.flags,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityView":
        return cls(
            m["entity_id"],
            m["entity_type_id"],
            m["canonical_name"],
            m["normalized_name"],
            list(m["aliases"]),
            list(m["attributes_blob"]),
            m["mention_count"],
            m["created_at_unix_nanos"],
            m["updated_at_unix_nanos"],
            m["merged_into"],
            m["embedding_version"],
            m["flags"],
        )


@dataclass
class EntityGetRequest:
    """ENTITY_GET (``0x0131``). Fetch one entity by id."""

    entity_id: bytes
    # Effective identity this get runs as. Omitted from the CBOR map when None so
    # the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {"entity_id": self.entity_id}
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EntityGetRequest":
        act_as = m.get("act_as")
        return cls(
            m["entity_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EntityGetResponse:
    """ENTITY_GET_RESP (``0x01B1``). The requested entity's view."""

    entity: EntityView

    def to_map(self) -> dict:
        return {"entity": self.entity.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "EntityGetResponse":
        return cls(EntityView.from_map(m["entity"]))


@dataclass
class EntityListRequest:
    """ENTITY_LIST (``0x0137``). Page through entities under optional type/name-prefix/mention filters, with tombstone and merge inclusion, a limit, and a cursor."""

    entity_type_id: int  # 0 = no filter
    name_prefix: str  # empty = no filter
    mention_count_min: int
    include_tombstoned: bool
    include_merged: bool
    limit: int  # 1..=1000
    cursor: list[int]  # Vec<u8> -> array of ints
    # Effective identity this list runs as. Omitted from the CBOR map when None
    # so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "entity_type_id": self.entity_type_id,
            "name_prefix": self.name_prefix,
            "mention_count_min": self.mention_count_min,
            "include_tombstoned": self.include_tombstoned,
            "include_merged": self.include_merged,
            "limit": self.limit,
            "cursor": list(self.cursor),
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EntityListRequest":
        act_as = m.get("act_as")
        return cls(
            m["entity_type_id"],
            m["name_prefix"],
            m["mention_count_min"],
            m["include_tombstoned"],
            m["include_merged"],
            m["limit"],
            list(m["cursor"]),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EntityListItem:
    """One entity in an ENTITY_LIST response frame."""

    entity: EntityView

    def to_map(self) -> dict:
        return {"entity": self.entity.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "EntityListItem":
        return cls(EntityView.from_map(m["entity"]))


@dataclass
class EntityListResponseFrame:
    """ENTITY_LIST_RESP (``0x01B7``), one streamed frame. The entities in this frame, the next-page cursor, cumulative count, and final flag."""

    items: list[EntityListItem]
    next_cursor: list[int]  # Vec<u8> -> array of ints
    cumulative_count: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "next_cursor": list(self.next_cursor),
            "cumulative_count": self.cumulative_count,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityListResponseFrame":
        return cls(
            [EntityListItem.from_map(i) for i in m["items"]],
            list(m["next_cursor"]),
            m["cumulative_count"],
            m["is_final"],
        )


# ===========================================================================
# ENTITY_RESOLVE.
# ===========================================================================


class ResolutionOutcome:
    """Resolution outcome discriminant (integer on the wire, 1-based)."""

    RESOLVED = 1
    CREATED = 2
    AMBIGUOUS = 3
    NOT_FOUND = 4


@dataclass
class EntityResolveRequest:
    """ENTITY_RESOLVE (``0x0136``). Resolve a candidate name (with context and an optional type hint) to an entity, optionally creating one, with an idempotency id."""

    candidate_name: str
    resolution_context: str
    entity_type_hint: int  # 0 = no hint
    allow_create: bool
    request_id: bytes
    # Effective identity this resolve runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "candidate_name": self.candidate_name,
            "resolution_context": self.resolution_context,
            "entity_type_hint": self.entity_type_hint,
            "allow_create": self.allow_create,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "EntityResolveRequest":
        act_as = m.get("act_as")
        return cls(
            m["candidate_name"],
            m["resolution_context"],
            m["entity_type_hint"],
            m["allow_create"],
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class EntityResolveResponse:
    """ENTITY_RESOLVE_RESP (``0x01B6``). The resolution outcome and tier, confidence, the resolved entity (or ambiguous candidates), and the audit id."""

    outcome: int  # ResolutionOutcome discriminant
    tier: int
    confidence: float
    resolved_entity: bytes  # all-zero for Ambiguous / NotFound
    candidate_ids: list[bytes]  # list of 16-byte byte strings; populated for Ambiguous
    audit_id: bytes

    def to_map(self) -> dict:
        return {
            "outcome": self.outcome,
            "tier": self.tier,
            "confidence": round_f32(self.confidence),
            "resolved_entity": self.resolved_entity,
            "candidate_ids": list(self.candidate_ids),
            "audit_id": self.audit_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityResolveResponse":
        return cls(
            m["outcome"],
            m["tier"],
            m["confidence"],
            m["resolved_entity"],
            list(m["candidate_ids"]),
            m["audit_id"],
        )


# ===========================================================================
# STATEMENT_GET / STATEMENT_LIST.
# ===========================================================================


@dataclass
class StatementView:
    """The full stored view of a statement: subject/predicate/object, confidence and evidence, bi-temporal validity, supersession-chain links, and tombstone state."""

    statement_id: bytes
    # StatementKind: a variant-name str, or {"Custom": int} for the catch-all.
    kind: Union[str, dict]
    subject: bytes
    subject_pending_audit_id: bytes
    predicate: str
    object: StatementObject
    confidence: float  # f32
    evidence: EvidenceRef
    extractor_id: int
    extracted_at_unix_nanos: int
    schema_version: int
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    event_at_unix_nanos: int
    version: int
    superseded_by: bytes
    supersedes: bytes
    chain_root: bytes
    tombstoned: bool
    tombstoned_at_unix_nanos: int
    tombstone_reason: int
    flags: int
    is_stateful: bool

    def to_map(self) -> dict:
        return {
            "statement_id": self.statement_id,
            "kind": self.kind,
            "subject": self.subject,
            "subject_pending_audit_id": self.subject_pending_audit_id,
            "predicate": self.predicate,
            "object": self.object.to_cbor_value(),
            "confidence": round_f32(self.confidence),
            "evidence": self.evidence.to_cbor_value(),
            "extractor_id": self.extractor_id,
            "extracted_at_unix_nanos": self.extracted_at_unix_nanos,
            "schema_version": self.schema_version,
            "valid_from_unix_nanos": self.valid_from_unix_nanos,
            "valid_to_unix_nanos": self.valid_to_unix_nanos,
            "event_at_unix_nanos": self.event_at_unix_nanos,
            "version": self.version,
            "superseded_by": self.superseded_by,
            "supersedes": self.supersedes,
            "chain_root": self.chain_root,
            "tombstoned": self.tombstoned,
            "tombstoned_at_unix_nanos": self.tombstoned_at_unix_nanos,
            "tombstone_reason": self.tombstone_reason,
            "flags": self.flags,
            "is_stateful": self.is_stateful,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementView":
        return cls(
            m["statement_id"],
            m["kind"],
            m["subject"],
            m["subject_pending_audit_id"],
            m["predicate"],
            StatementObject.from_cbor_value(m["object"]),
            m["confidence"],
            EvidenceRef.from_cbor_value(m["evidence"]),
            m["extractor_id"],
            m["extracted_at_unix_nanos"],
            m["schema_version"],
            m["valid_from_unix_nanos"],
            m["valid_to_unix_nanos"],
            m["event_at_unix_nanos"],
            m["version"],
            m["superseded_by"],
            m["supersedes"],
            m["chain_root"],
            m["tombstoned"],
            m["tombstoned_at_unix_nanos"],
            m["tombstone_reason"],
            m["flags"],
            m["is_stateful"],
        )


@dataclass
class StatementGetRequest:
    """STATEMENT_GET (``0x0141``). Fetch one statement by id, optionally following supersession to the current head."""

    statement_id: bytes
    follow_supersession: bool
    # Effective identity this get runs as. Omitted from the CBOR map when None so
    # the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "statement_id": self.statement_id,
            "follow_supersession": self.follow_supersession,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "StatementGetRequest":
        act_as = m.get("act_as")
        return cls(
            m["statement_id"],
            m["follow_supersession"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class StatementGetResponse:
    """STATEMENT_GET_RESP (``0x01C1``). The statement view and whether it was reached by following supersession."""

    statement: StatementView
    returned_via_supersession: bool

    def to_map(self) -> dict:
        return {
            "statement": self.statement.to_map(),
            "returned_via_supersession": self.returned_via_supersession,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementGetResponse":
        return cls(StatementView.from_map(m["statement"]), m["returned_via_supersession"])


@dataclass
class StatementListRequest:
    """STATEMENT_LIST (``0x0146``). Page statements for a subject/predicate under kind, confidence, and time-range filters, with current-only/tombstone toggles, a limit, and a cursor."""

    subject: bytes
    predicate: str
    kind: int  # 0 = no filter; 1=Fact / 2=Preference / 3=Event
    min_confidence: float  # f32
    time_range_start_unix_nanos: int
    time_range_end_unix_nanos: int
    only_current: bool
    include_tombstoned: bool
    limit: int
    cursor: list[int]  # Vec<u8> -> array of ints
    # Effective identity this list runs as. Omitted from the CBOR map when None
    # so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "subject": self.subject,
            "predicate": self.predicate,
            "kind": self.kind,
            "min_confidence": round_f32(self.min_confidence),
            "time_range_start_unix_nanos": self.time_range_start_unix_nanos,
            "time_range_end_unix_nanos": self.time_range_end_unix_nanos,
            "only_current": self.only_current,
            "include_tombstoned": self.include_tombstoned,
            "limit": self.limit,
            "cursor": list(self.cursor),
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "StatementListRequest":
        act_as = m.get("act_as")
        return cls(
            m["subject"],
            m["predicate"],
            m["kind"],
            m["min_confidence"],
            m["time_range_start_unix_nanos"],
            m["time_range_end_unix_nanos"],
            m["only_current"],
            m["include_tombstoned"],
            m["limit"],
            list(m["cursor"]),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class StatementListResponseFrame:
    """STATEMENT_LIST_RESP (``0x01C6``), one streamed frame. The statements in this frame, the next-page cursor, cumulative count, and final flag."""

    items: list[StatementView]
    next_cursor: list[int]  # Vec<u8> -> array of ints
    cumulative_count: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "next_cursor": list(self.next_cursor),
            "cumulative_count": self.cumulative_count,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementListResponseFrame":
        return cls(
            [StatementView.from_map(i) for i in m["items"]],
            list(m["next_cursor"]),
            m["cumulative_count"],
            m["is_final"],
        )


# ===========================================================================
# RELATION_LIST_FROM / RELATION_LIST_TO.
# ===========================================================================


@dataclass
class RelationView:
    """The full stored view of a relation: type and endpoints, properties blob, evidence and confidence, validity window, supersession-chain links, and tombstone state."""

    relation_id: bytes
    chain_root: bytes
    relation_type: str
    from_entity: bytes
    to_entity: bytes
    properties_blob: list[int]  # Vec<u8> -> array of ints
    evidence: EvidenceRef
    extractor_id: int
    extracted_at_unix_nanos: int
    confidence: float  # f32
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    version: int
    superseded_by: bytes
    supersedes: bytes
    tombstoned: bool
    tombstoned_at_unix_nanos: int
    flags: int

    def to_map(self) -> dict:
        return {
            "relation_id": self.relation_id,
            "chain_root": self.chain_root,
            "relation_type": self.relation_type,
            "from_entity": self.from_entity,
            "to_entity": self.to_entity,
            "properties_blob": list(self.properties_blob),
            "evidence": self.evidence.to_cbor_value(),
            "extractor_id": self.extractor_id,
            "extracted_at_unix_nanos": self.extracted_at_unix_nanos,
            "confidence": round_f32(self.confidence),
            "valid_from_unix_nanos": self.valid_from_unix_nanos,
            "valid_to_unix_nanos": self.valid_to_unix_nanos,
            "version": self.version,
            "superseded_by": self.superseded_by,
            "supersedes": self.supersedes,
            "tombstoned": self.tombstoned,
            "tombstoned_at_unix_nanos": self.tombstoned_at_unix_nanos,
            "flags": self.flags,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationView":
        return cls(
            m["relation_id"],
            m["chain_root"],
            m["relation_type"],
            m["from_entity"],
            m["to_entity"],
            list(m["properties_blob"]),
            EvidenceRef.from_cbor_value(m["evidence"]),
            m["extractor_id"],
            m["extracted_at_unix_nanos"],
            m["confidence"],
            m["valid_from_unix_nanos"],
            m["valid_to_unix_nanos"],
            m["version"],
            m["superseded_by"],
            m["supersedes"],
            m["tombstoned"],
            m["tombstoned_at_unix_nanos"],
            m["flags"],
        )


@dataclass
class RelationListFromRequest:
    """RELATION_LIST_FROM (``0x0154``). Page relations outgoing from an entity under type/time filters, with superseded/tombstone toggles, a limit, and a cursor."""

    from_entity: bytes
    relation_type_filter: str  # "" = any type
    time_range_start_unix_nanos: int
    time_range_end_unix_nanos: int
    include_superseded: bool
    include_tombstoned: bool
    limit: int
    cursor: list[int]  # Vec<u8> -> array of ints
    # Effective identity this list runs as. Omitted from the CBOR map when None
    # so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "from_entity": self.from_entity,
            "relation_type_filter": self.relation_type_filter,
            "time_range_start_unix_nanos": self.time_range_start_unix_nanos,
            "time_range_end_unix_nanos": self.time_range_end_unix_nanos,
            "include_superseded": self.include_superseded,
            "include_tombstoned": self.include_tombstoned,
            "limit": self.limit,
            "cursor": list(self.cursor),
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RelationListFromRequest":
        act_as = m.get("act_as")
        return cls(
            m["from_entity"],
            m["relation_type_filter"],
            m["time_range_start_unix_nanos"],
            m["time_range_end_unix_nanos"],
            m["include_superseded"],
            m["include_tombstoned"],
            m["limit"],
            list(m["cursor"]),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class RelationListFromResponseFrame:
    """RELATION_LIST_FROM_RESP (``0x01D4``), one streamed frame. The relations in this frame, the next-page cursor, cumulative count, and final flag."""

    items: list[RelationView]
    next_cursor: list[int]  # Vec<u8> -> array of ints
    cumulative_count: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "next_cursor": list(self.next_cursor),
            "cumulative_count": self.cumulative_count,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationListFromResponseFrame":
        return cls(
            [RelationView.from_map(i) for i in m["items"]],
            list(m["next_cursor"]),
            m["cumulative_count"],
            m["is_final"],
        )


@dataclass
class RelationListToRequest:
    """RELATION_LIST_TO (``0x0155``). Page relations incoming to an entity under type/time filters, with superseded/tombstone toggles, a limit, and a cursor."""

    to_entity: bytes
    relation_type_filter: str  # "" = any type
    time_range_start_unix_nanos: int
    time_range_end_unix_nanos: int
    include_superseded: bool
    include_tombstoned: bool
    limit: int
    cursor: list[int]  # Vec<u8> -> array of ints
    # Effective identity this list runs as. Omitted from the CBOR map when None
    # so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "to_entity": self.to_entity,
            "relation_type_filter": self.relation_type_filter,
            "time_range_start_unix_nanos": self.time_range_start_unix_nanos,
            "time_range_end_unix_nanos": self.time_range_end_unix_nanos,
            "include_superseded": self.include_superseded,
            "include_tombstoned": self.include_tombstoned,
            "limit": self.limit,
            "cursor": list(self.cursor),
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RelationListToRequest":
        act_as = m.get("act_as")
        return cls(
            m["to_entity"],
            m["relation_type_filter"],
            m["time_range_start_unix_nanos"],
            m["time_range_end_unix_nanos"],
            m["include_superseded"],
            m["include_tombstoned"],
            m["limit"],
            list(m["cursor"]),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class RelationListToResponseFrame:
    """RELATION_LIST_TO_RESP (``0x01D5``), one streamed frame. The relations in this frame, the next-page cursor, cumulative count, and final flag."""

    items: list[RelationView]
    next_cursor: list[int]  # Vec<u8> -> array of ints
    cumulative_count: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "next_cursor": list(self.next_cursor),
            "cumulative_count": self.cumulative_count,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationListToResponseFrame":
        return cls(
            [RelationView.from_map(i) for i in m["items"]],
            list(m["next_cursor"]),
            m["cumulative_count"],
            m["is_final"],
        )


# ===========================================================================
# SCHEMA_GET / SCHEMA_LIST / SCHEMA_VALIDATE.
# ===========================================================================


@dataclass
class SchemaGetRequest:
    """SCHEMA_GET (``0x0121``). Fetch a namespace's schema at a given version (0 = active)."""

    namespace: str
    version: int  # 0 = active version

    def to_map(self) -> dict:
        return {"namespace": self.namespace, "version": self.version}

    @classmethod
    def from_map(cls, m: dict) -> "SchemaGetRequest":
        return cls(m["namespace"], m["version"])


@dataclass
class SchemaGetResponse:
    """SCHEMA_GET_RESP (``0x01A1``). The namespace and version, the schema document and source blob, upload time, and validator version."""

    namespace: str
    schema_version: int
    schema_document: str
    source_blob: list[int]  # Vec<u8> -> array of ints
    uploaded_at_unix_nanos: int
    validator_version: int

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "schema_version": self.schema_version,
            "schema_document": self.schema_document,
            "source_blob": list(self.source_blob),
            "uploaded_at_unix_nanos": self.uploaded_at_unix_nanos,
            "validator_version": self.validator_version,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaGetResponse":
        return cls(
            m["namespace"],
            m["schema_version"],
            m["schema_document"],
            list(m["source_blob"]),
            m["uploaded_at_unix_nanos"],
            m["validator_version"],
        )


@dataclass
class SchemaListRequest:
    """SCHEMA_LIST (``0x0122``). Page a namespace's schema versions with a limit (0 = server-capped) and a cursor."""

    namespace: str
    limit: int  # 0 = unlimited (server-capped)
    cursor: list[int]  # Vec<u8> -> array of ints

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "limit": self.limit,
            "cursor": list(self.cursor),
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaListRequest":
        return cls(m["namespace"], m["limit"], list(m["cursor"]))


@dataclass
class SchemaListItem:
    """One schema version in a SCHEMA_LIST frame: its version, upload time, validator version, and whether source text is retained."""

    schema_version: int
    uploaded_at_unix_nanos: int
    validator_version: int
    has_source_text: bool

    def to_map(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "uploaded_at_unix_nanos": self.uploaded_at_unix_nanos,
            "validator_version": self.validator_version,
            "has_source_text": self.has_source_text,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaListItem":
        return cls(
            m["schema_version"],
            m["uploaded_at_unix_nanos"],
            m["validator_version"],
            m["has_source_text"],
        )


@dataclass
class SchemaListResponseFrame:
    """SCHEMA_LIST_RESP (``0x01A2``), one streamed frame. The namespace, the versions in this frame, the total, the next-page cursor, and the final flag."""

    namespace: str
    items: list[SchemaListItem]
    total: int
    next_cursor: list[int]  # Vec<u8> -> array of ints
    is_final: bool

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "items": [i.to_map() for i in self.items],
            "total": self.total,
            "next_cursor": list(self.next_cursor),
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaListResponseFrame":
        return cls(
            m["namespace"],
            [SchemaListItem.from_map(i) for i in m["items"]],
            m["total"],
            list(m["next_cursor"]),
            m["is_final"],
        )


@dataclass
class SchemaValidateRequest:
    """SCHEMA_VALIDATE (``0x0123``). Validate a schema document without uploading it."""

    schema_document: str

    def to_map(self) -> dict:
        return {"schema_document": self.schema_document}

    @classmethod
    def from_map(cls, m: dict) -> "SchemaValidateRequest":
        return cls(m["schema_document"])


@dataclass
class SchemaValidateResponse:
    """SCHEMA_VALIDATE_RESP (``0x01A3``). The resolved namespace, the version it would become, and any validation errors."""

    namespace: str
    would_be_version: int
    validation_errors: list[SchemaValidationError]

    def to_map(self) -> dict:
        return {
            "namespace": self.namespace,
            "would_be_version": self.would_be_version,
            "validation_errors": [e.to_map() for e in self.validation_errors],
        }

    @classmethod
    def from_map(cls, m: dict) -> "SchemaValidateResponse":
        return cls(
            m["namespace"],
            m["would_be_version"],
            [SchemaValidationError.from_map(e) for e in m["validation_errors"]],
        )


# ===========================================================================
# Payload codec seam: value <-> wire bytes, handling the vector trailer.
# ===========================================================================


def encode_payload(value) -> bytes:
    """Serialize a typed payload to wire bytes.

    For most payloads this is just the CBOR map. For
    ``EncodeVectorDirectRequest`` the embedding is appended as a raw
    little-endian f32 trailer after the CBOR section.
    """
    cbor = to_cbor(value.to_map())
    if isinstance(value, EncodeVectorDirectRequest):
        return cbor + f32_list_to_le_bytes(value.vector)
    return cbor


def decode_payload(payload_type, data: bytes):
    """Decode wire bytes to a typed payload of ``payload_type``.

    ``EncodeVectorDirectRequest`` reads the CBOR prefix and then the
    trailing raw f32 section; every other type consumes the whole buffer.
    """
    if payload_type is EncodeVectorDirectRequest:
        m, consumed = from_cbor_prefix(data)
        value = EncodeVectorDirectRequest.from_map(m)
        value.vector = le_bytes_to_f32_list(data[consumed:])
        return value
    return payload_type.from_map(from_cbor(data))


# ---------------------------------------------------------------------------
# Entity mutation — an entity accretes detail (update/rename), consolidates
# duplicates (merge/unmerge), and retires (tombstone) over its lifetime.
# ---------------------------------------------------------------------------


@dataclass
class EntityUpdateRequest:
    """ENTITY_UPDATE (``0x0132``). Replace name, aliases, and attributes."""

    entity_id: bytes
    canonical_name: str
    aliases: list[str]
    attributes_blob: list[int]
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "canonical_name": self.canonical_name,
            "aliases": list(self.aliases),
            "attributes_blob": list(self.attributes_blob),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityUpdateRequest":
        return cls(
            m["entity_id"],
            m["canonical_name"],
            list(m["aliases"]),
            list(m["attributes_blob"]),
            m["request_id"],
        )


@dataclass
class EntityUpdateResponse:
    """ENTITY_UPDATE_RESP (``0x01B2``). The post-update view."""

    entity: EntityView

    def to_map(self) -> dict:
        return {"entity": self.entity.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "EntityUpdateResponse":
        return cls(EntityView.from_map(m["entity"]))


@dataclass
class EntityRenameRequest:
    """ENTITY_RENAME (``0x0133``). ``move_to_alias`` keeps the old name."""

    entity_id: bytes
    new_canonical_name: str
    move_to_alias: bool
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "new_canonical_name": self.new_canonical_name,
            "move_to_alias": self.move_to_alias,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityRenameRequest":
        return cls(
            m["entity_id"], m["new_canonical_name"], m["move_to_alias"], m["request_id"]
        )


@dataclass
class EntityRenameResponse:
    """ENTITY_RENAME_RESP (``0x01B3``). The post-rename view."""

    entity: EntityView

    def to_map(self) -> dict:
        return {"entity": self.entity.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "EntityRenameResponse":
        return cls(EntityView.from_map(m["entity"]))


@dataclass
class EntityMergeRequest:
    """ENTITY_MERGE (``0x0134``). Fold ``merged`` into ``survivor``."""

    survivor: bytes
    merged: bytes
    confidence: float
    reason: str
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "survivor": self.survivor,
            "merged": self.merged,
            "confidence": round_f32(self.confidence),
            "reason": self.reason,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityMergeRequest":
        return cls(
            m["survivor"], m["merged"], m["confidence"], m["reason"], m["request_id"]
        )


@dataclass
class EntityMergeResponse:
    """ENTITY_MERGE_RESP (``0x01B4``). Merge-audit id + reversible window."""

    audit_id: bytes
    grace_period_seconds: int

    def to_map(self) -> dict:
        return {"audit_id": self.audit_id, "grace_period_seconds": self.grace_period_seconds}

    @classmethod
    def from_map(cls, m: dict) -> "EntityMergeResponse":
        return cls(m["audit_id"], m["grace_period_seconds"])


@dataclass
class EntityUnmergeRequest:
    """ENTITY_UNMERGE (``0x0135``). Undo a merge within its grace window."""

    merged_entity: bytes
    request_id: bytes

    def to_map(self) -> dict:
        return {"merged_entity": self.merged_entity, "request_id": self.request_id}

    @classmethod
    def from_map(cls, m: dict) -> "EntityUnmergeRequest":
        return cls(m["merged_entity"], m["request_id"])


@dataclass
class EntityUnmergeResponse:
    """ENTITY_UNMERGE_RESP (``0x01B5``). The restored entity's id."""

    restored_entity_id: bytes

    def to_map(self) -> dict:
        return {"restored_entity_id": self.restored_entity_id}

    @classmethod
    def from_map(cls, m: dict) -> "EntityUnmergeResponse":
        return cls(m["restored_entity_id"])


@dataclass
class EntityTombstoneRequest:
    """ENTITY_TOMBSTONE (``0x0138``). Soft-retire with an audit reason."""

    entity_id: bytes
    reason: str
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "entity_id": self.entity_id,
            "reason": self.reason,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityTombstoneRequest":
        return cls(m["entity_id"], m["reason"], m["request_id"])


@dataclass
class EntityTombstoneResponse:
    """ENTITY_TOMBSTONE_RESP (``0x01B8``). When the retirement took effect."""

    tombstoned_at_unix_nanos: int

    def to_map(self) -> dict:
        return {"tombstoned_at_unix_nanos": self.tombstoned_at_unix_nanos}

    @classmethod
    def from_map(cls, m: dict) -> "EntityTombstoneResponse":
        return cls(m["tombstoned_at_unix_nanos"])


# ---------------------------------------------------------------------------
# Statement lifecycle — a claim is revised (supersede), walked back (retract),
# retired (tombstone), or inspected across versions (history).
# ---------------------------------------------------------------------------


@dataclass
class StatementSupersedeRequest:
    """STATEMENT_SUPERSEDE (``0x0142``). Revise a claim, keeping the chain."""

    old_statement_id: bytes
    new_statement: StatementCreateRequest
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "old_statement_id": self.old_statement_id,
            "new_statement": self.new_statement.to_map(),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementSupersedeRequest":
        return cls(
            m["old_statement_id"],
            StatementCreateRequest.from_map(m["new_statement"]),
            m["request_id"],
        )


@dataclass
class StatementSupersedeResponse:
    """STATEMENT_SUPERSEDE_RESP (``0x01C2``). New id + chain root + version."""

    new_statement_id: bytes
    chain_root: bytes
    version: int

    def to_map(self) -> dict:
        return {
            "new_statement_id": self.new_statement_id,
            "chain_root": self.chain_root,
            "version": self.version,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementSupersedeResponse":
        return cls(m["new_statement_id"], m["chain_root"], m["version"])


@dataclass
class StatementTombstoneRequest:
    """STATEMENT_TOMBSTONE (``0x0143``). Soft-retire; ``reason`` is 1..=4."""

    statement_id: bytes
    reason: int
    reason_message: str
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "statement_id": self.statement_id,
            "reason": self.reason,
            "reason_message": self.reason_message,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementTombstoneRequest":
        return cls(m["statement_id"], m["reason"], m["reason_message"], m["request_id"])


@dataclass
class StatementTombstoneResponse:
    """STATEMENT_TOMBSTONE_RESP (``0x01C3``)."""

    tombstoned_at_unix_nanos: int

    def to_map(self) -> dict:
        return {"tombstoned_at_unix_nanos": self.tombstoned_at_unix_nanos}

    @classmethod
    def from_map(cls, m: dict) -> "StatementTombstoneResponse":
        return cls(m["tombstoned_at_unix_nanos"])


@dataclass
class StatementRetractRequest:
    """STATEMENT_RETRACT (``0x0144``). Assert wrong; schedules a hard-zero."""

    statement_id: bytes
    reason: int
    reason_message: str
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "statement_id": self.statement_id,
            "reason": self.reason,
            "reason_message": self.reason_message,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementRetractRequest":
        return cls(m["statement_id"], m["reason"], m["reason_message"], m["request_id"])


@dataclass
class StatementRetractResponse:
    """STATEMENT_RETRACT_RESP (``0x01C4``). Retracted-at + scheduled zero-at."""

    retracted_at_unix_nanos: int
    will_zero_at_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "retracted_at_unix_nanos": self.retracted_at_unix_nanos,
            "will_zero_at_unix_nanos": self.will_zero_at_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementRetractResponse":
        return cls(m["retracted_at_unix_nanos"], m["will_zero_at_unix_nanos"])


@dataclass
class StatementHistoryRequest:
    """STATEMENT_HISTORY (``0x0145``). A read — no ``request_id``."""

    anchor_id: bytes
    include_tombstoned: bool

    def to_map(self) -> dict:
        return {"anchor_id": self.anchor_id, "include_tombstoned": self.include_tombstoned}

    @classmethod
    def from_map(cls, m: dict) -> "StatementHistoryRequest":
        return cls(m["anchor_id"], m["include_tombstoned"])


@dataclass
class StatementHistoryResponseFrame:
    """STATEMENT_HISTORY_RESP (``0x01C5``), one streamed frame."""

    items: list[StatementView]
    chain_root: bytes
    total_versions: int
    is_final: bool

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "chain_root": self.chain_root,
            "total_versions": self.total_versions,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementHistoryResponseFrame":
        return cls(
            [StatementView.from_map(x) for x in m["items"]],
            m["chain_root"],
            m["total_versions"],
            m["is_final"],
        )


# ---------------------------------------------------------------------------
# Relation lifecycle + traversal — fetch one (get), revise (supersede), retire
# (tombstone), or walk the graph from an entity (traverse).
# ---------------------------------------------------------------------------


@dataclass
class RelationGetRequest:
    """RELATION_GET (``0x0151``). Fetch one relation by id.
    ``follow_supersession`` returns the current head of a superseded relation's
    chain rather than the (retired) id asked for."""

    relation_id: bytes
    follow_supersession: bool
    # Effective identity this get runs as. Omitted from the CBOR map when None so
    # the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "relation_id": self.relation_id,
            "follow_supersession": self.follow_supersession,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RelationGetRequest":
        act_as = m.get("act_as")
        return cls(
            m["relation_id"],
            m["follow_supersession"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class RelationGetResponse:
    """RELATION_GET_RESP (``0x01D1``). The relation view;
    ``returned_via_supersession`` flags that the view is the chain head, not the
    exact id requested."""

    relation: RelationView
    returned_via_supersession: bool

    def to_map(self) -> dict:
        return {
            "relation": self.relation.to_map(),
            "returned_via_supersession": self.returned_via_supersession,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationGetResponse":
        return cls(RelationView.from_map(m["relation"]), m["returned_via_supersession"])


@dataclass
class RelationSupersedeRequest:
    """RELATION_SUPERSEDE (``0x0152``). Revise a relation, keeping the old and
    new on one chain. The new edge is a full ``RelationCreateRequest``."""

    old_relation_id: bytes
    new_relation: RelationCreateRequest
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "old_relation_id": self.old_relation_id,
            "new_relation": self.new_relation.to_map(),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationSupersedeRequest":
        return cls(
            m["old_relation_id"],
            RelationCreateRequest.from_map(m["new_relation"]),
            m["request_id"],
        )


@dataclass
class RelationSupersedeResponse:
    """RELATION_SUPERSEDE_RESP (``0x01D2``). New relation id + monotonic
    version."""

    new_relation_id: bytes
    version: int

    def to_map(self) -> dict:
        return {"new_relation_id": self.new_relation_id, "version": self.version}

    @classmethod
    def from_map(cls, m: dict) -> "RelationSupersedeResponse":
        return cls(m["new_relation_id"], m["version"])


@dataclass
class RelationTombstoneRequest:
    """RELATION_TOMBSTONE (``0x0153``). Soft-retire a relation with a reason."""

    relation_id: bytes
    reason: str
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "relation_id": self.relation_id,
            "reason": self.reason,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationTombstoneRequest":
        return cls(m["relation_id"], m["reason"], m["request_id"])


@dataclass
class RelationTombstoneResponse:
    """RELATION_TOMBSTONE_RESP (``0x01D3``). When the retire took effect."""

    tombstoned_at_unix_nanos: int

    def to_map(self) -> dict:
        return {"tombstoned_at_unix_nanos": self.tombstoned_at_unix_nanos}

    @classmethod
    def from_map(cls, m: dict) -> "RelationTombstoneResponse":
        return cls(m["tombstoned_at_unix_nanos"])


@dataclass
class TraversalStepWire:
    """One hop in a traversal path: the relation edge crossed and its endpoints.
    The wire keys ``from`` / ``to`` map to the ``from_`` / ``to`` attributes
    (``from`` is a Python keyword)."""

    relation_id: bytes
    from_: bytes
    to: bytes
    relation_type: str
    depth: int

    def to_map(self) -> dict:
        return {
            "relation_id": self.relation_id,
            "from": self.from_,
            "to": self.to,
            "relation_type": self.relation_type,
            "depth": self.depth,
        }

    @classmethod
    def from_map(cls, m: dict) -> "TraversalStepWire":
        return cls(m["relation_id"], m["from"], m["to"], m["relation_type"], m["depth"])


@dataclass
class TraversalPathWire:
    """One path the traversal found, as an ordered list of steps."""

    steps: list[TraversalStepWire]

    def to_map(self) -> dict:
        return {"steps": [s.to_map() for s in self.steps]}

    @classmethod
    def from_map(cls, m: dict) -> "TraversalPathWire":
        return cls([TraversalStepWire.from_map(s) for s in m["steps"]])


@dataclass
class RelationTraverseRequest:
    """RELATION_TRAVERSE (``0x0156``). Multi-hop walk of the relation graph from
    ``start_entity``. ``direction`` is outgoing/incoming/both; the bounds cap the
    search; ``time_at_unix_nanos`` walks the graph as it stood at a record
    time."""

    start_entity: bytes
    relation_types: list[str]
    direction: int  # u8
    max_depth: int
    max_nodes: int
    time_at_unix_nanos: int
    include_superseded: bool
    request_id: bytes
    # Effective identity this traversal runs as. Omitted from the CBOR map when
    # None so the common single-tenant path stays byte-identical.
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m = {
            "start_entity": self.start_entity,
            "relation_types": list(self.relation_types),
            "direction": self.direction,
            "max_depth": self.max_depth,
            "max_nodes": self.max_nodes,
            "time_at_unix_nanos": self.time_at_unix_nanos,
            "include_superseded": self.include_superseded,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "RelationTraverseRequest":
        act_as = m.get("act_as")
        return cls(
            m["start_entity"],
            list(m["relation_types"]),
            m["direction"],
            m["max_depth"],
            m["max_nodes"],
            m["time_at_unix_nanos"],
            m["include_superseded"],
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class RelationTraverseResponseFrame:
    """RELATION_TRAVERSE_RESP (``0x01D6``), one streamed frame. ``is_final``
    marks the last; ``truncated`` flags a bound was hit before the graph was
    exhausted."""

    paths: list[TraversalPathWire]
    total_paths: int
    truncated: bool
    is_final: bool

    def to_map(self) -> dict:
        return {
            "paths": [p.to_map() for p in self.paths],
            "total_paths": self.total_paths,
            "truncated": self.truncated,
            "is_final": self.is_final,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationTraverseResponseFrame":
        return cls(
            [TraversalPathWire.from_map(p) for p in m["paths"]],
            m["total_paths"],
            m["truncated"],
            m["is_final"],
        )


# ---------------------------------------------------------------------------
# Query introspection — the plan (explain) and execution trace, a debug
# surface that wraps a full QueryRequest.
# ---------------------------------------------------------------------------


@dataclass
class QueryExplainRequest:
    """QUERY_EXPLAIN (``0x0161``). Ask for the plan of a query without running
    it. Wraps a full :class:`QueryRequest`."""

    query: QueryRequest

    def to_map(self) -> dict:
        return {"query": self.query.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "QueryExplainRequest":
        return cls(QueryRequest.from_map(m["query"]))


@dataclass
class QueryExplainResponse:
    """QUERY_EXPLAIN_RESP (``0x01E1``). The plan text plus an estimated cost."""

    plan_text: str
    estimated_cost_ms: float  # f32

    def to_map(self) -> dict:
        return {
            "plan_text": self.plan_text,
            "estimated_cost_ms": round_f32(self.estimated_cost_ms),
        }

    @classmethod
    def from_map(cls, m: dict) -> "QueryExplainResponse":
        return cls(m["plan_text"], m["estimated_cost_ms"])


@dataclass
class QueryTraceRequest:
    """QUERY_TRACE (``0x0162``). Run a query and return its per-stage execution
    trace. Wraps a full :class:`QueryRequest`."""

    query: QueryRequest

    def to_map(self) -> dict:
        return {"query": self.query.to_map()}

    @classmethod
    def from_map(cls, m: dict) -> "QueryTraceRequest":
        return cls(QueryRequest.from_map(m["query"]))


@dataclass
class QueryTraceResponse:
    """QUERY_TRACE_RESP (``0x01E2``). The trace text plus total latency."""

    trace_text: str
    total_latency_ms: float  # f64

    def to_map(self) -> dict:
        return {
            "trace_text": self.trace_text,
            "total_latency_ms": mark_f64(self.total_latency_ms),
        }

    @classmethod
    def from_map(cls, m: dict) -> "QueryTraceResponse":
        return cls(m["trace_text"], m["total_latency_ms"])


# ---------------------------------------------------------------------------
# Space registry — SPACE_CREATE / SPACE_LIST / SPACE_DELETE.
#
# A space is the per-request isolation unit within a namespace. Registry
# echoes carry the human-readable structured space string (``space_id: str``,
# a CBOR text string), not the derived 16-byte storage id.
# ---------------------------------------------------------------------------


@dataclass
class SpaceView:
    """One space row in a :class:`SpaceListResponse`: the human-readable
    structured space string plus activity and cardinality counters."""

    space_id: str
    created_at_unix_nanos: int
    last_active_unix_nanos: int
    memory_count: int
    session_count: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "last_active_unix_nanos": self.last_active_unix_nanos,
            "memory_count": self.memory_count,
            "session_count": self.session_count,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SpaceView":
        return cls(
            m["space_id"],
            m["created_at_unix_nanos"],
            m["last_active_unix_nanos"],
            m["memory_count"],
            m["session_count"],
        )


@dataclass
class SpaceCreateRequest:
    """SPACE_CREATE (``0x0070``). Provision the caller's effective space
    explicitly; idempotent. ``metadata`` is an opaque blob (CBOR array of
    ints), omitted from the map when None."""

    request_id: bytes  # 16-byte byte string
    metadata: Optional[list[int]] = None  # Vec<u8> -> CBOR array of ints
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {}
        if self.metadata is not None:
            m["metadata"] = list(self.metadata)
        m["request_id"] = self.request_id
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SpaceCreateRequest":
        metadata = m.get("metadata")
        act_as = m.get("act_as")
        return cls(
            m["request_id"],
            None if metadata is None else list(metadata),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SpaceCreateResponse:
    """SPACE_CREATE_RESP (``0x00F0``). ``created`` is False on an idempotent
    replay. ``space_id`` is the human-readable structured space string."""

    space_id: str
    created: bool
    created_at_unix_nanos: int
    last_active_unix_nanos: int
    memory_count: int
    session_count: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "created": self.created,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "last_active_unix_nanos": self.last_active_unix_nanos,
            "memory_count": self.memory_count,
            "session_count": self.session_count,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SpaceCreateResponse":
        return cls(
            m["space_id"],
            m["created"],
            m["created_at_unix_nanos"],
            m["last_active_unix_nanos"],
            m["memory_count"],
            m["session_count"],
        )


@dataclass
class SpaceListRequest:
    """SPACE_LIST (``0x0071``). Lists the caller's namespace's spaces.
    ``limit == 0`` means no cap."""

    limit: int
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {"limit": self.limit}
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SpaceListRequest":
        act_as = m.get("act_as")
        return cls(
            m["limit"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SpaceListResponse:
    """SPACE_LIST_RESP (``0x00F1``). ``cross_shard_complete`` is False when the
    listing covers only the caller-shard's spaces (v1 behavior)."""

    spaces: list[SpaceView]
    cross_shard_complete: bool

    def to_map(self) -> dict:
        return {
            "spaces": [s.to_map() for s in self.spaces],
            "cross_shard_complete": self.cross_shard_complete,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SpaceListResponse":
        return cls(
            [SpaceView.from_map(s) for s in m["spaces"]],
            m["cross_shard_complete"],
        )


@dataclass
class SpaceDeleteRequest:
    """SPACE_DELETE (``0x0072``). GDPR erasure of the caller's effective space —
    hard/immediate."""

    request_id: bytes  # 16-byte byte string
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {"request_id": self.request_id}
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SpaceDeleteRequest":
        act_as = m.get("act_as")
        return cls(
            m["request_id"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SpaceDeleteResponse:
    """SPACE_DELETE_RESP (``0x00F2``). ``existed`` is False when the space had no
    registry row. ``space_id`` is the human-readable structured space string."""

    space_id: str
    existed: bool
    memories_forgotten: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "existed": self.existed,
            "memories_forgotten": self.memories_forgotten,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SpaceDeleteResponse":
        return cls(m["space_id"], m["existed"], m["memories_forgotten"])


# ---------------------------------------------------------------------------
# Session registry — SESSION_CREATE / SESSION_LIST / SESSION_DELETE.
#
# A session is a conversation/run grouping within a space (soft grouping,
# never an isolation boundary). ``session_id`` is the client's opaque u64.
# Session response echoes carry the effective space as a 16-byte ``space_id``
# (CBOR byte string), surfaced as Python ``bytes`` like every other resolved
# id — distinct from the SPACE_* registry echoes, which are text strings.
# ---------------------------------------------------------------------------


@dataclass
class SessionView:
    """One session row in a :class:`SessionListResponse`. ``title`` is omitted
    from the map when None."""

    session_id: int  # u64
    created_at_unix_nanos: int
    last_active_unix_nanos: int
    memory_count: int
    title: Optional[str] = None

    def to_map(self) -> dict:
        m: dict = {
            "session_id": self.session_id,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "last_active_unix_nanos": self.last_active_unix_nanos,
        }
        if self.title is not None:
            m["title"] = self.title
        m["memory_count"] = self.memory_count
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SessionView":
        return cls(
            m["session_id"],
            m["created_at_unix_nanos"],
            m["last_active_unix_nanos"],
            m["memory_count"],
            m.get("title"),
        )


@dataclass
class SessionCreateRequest:
    """SESSION_CREATE (``0x0073``). Provision a session under the caller's
    effective space; idempotent. ``title`` is omitted from the map when None."""

    session_id: int  # u64
    request_id: bytes  # 16-byte byte string
    title: Optional[str] = None
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {"session_id": self.session_id}
        if self.title is not None:
            m["title"] = self.title
        m["request_id"] = self.request_id
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SessionCreateRequest":
        act_as = m.get("act_as")
        return cls(
            m["session_id"],
            m["request_id"],
            m.get("title"),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SessionCreateResponse:
    """SESSION_CREATE_RESP (``0x00F3``). ``space_id`` is the effective space's
    derived 16-byte storage id; ``created`` is False on an idempotent replay."""

    space_id: bytes  # 16-byte byte string (derived storage id)
    session_id: int  # u64
    created: bool
    created_at_unix_nanos: int
    last_active_unix_nanos: int
    memory_count: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "session_id": self.session_id,
            "created": self.created,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "last_active_unix_nanos": self.last_active_unix_nanos,
            "memory_count": self.memory_count,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SessionCreateResponse":
        return cls(
            m["space_id"],
            m["session_id"],
            m["created"],
            m["created_at_unix_nanos"],
            m["last_active_unix_nanos"],
            m["memory_count"],
        )


@dataclass
class SessionListRequest:
    """SESSION_LIST (``0x0074``). Lists one space's sessions newest-first.
    ``limit == 0`` means no cap."""

    limit: int
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {"limit": self.limit}
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SessionListRequest":
        act_as = m.get("act_as")
        return cls(
            m["limit"],
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SessionListResponse:
    """SESSION_LIST_RESP (``0x00F4``). ``space_id`` is the effective space's
    derived 16-byte storage id."""

    space_id: bytes  # 16-byte byte string (derived storage id)
    sessions: list[SessionView]

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "sessions": [s.to_map() for s in self.sessions],
        }

    @classmethod
    def from_map(cls, m: dict) -> "SessionListResponse":
        return cls(
            m["space_id"],
            [SessionView.from_map(s) for s in m["sessions"]],
        )


@dataclass
class SessionDeleteRequest:
    """SESSION_DELETE (``0x0075``). ``hard`` is always present on the wire
    (default False = soft, 7-day grace; True = immediate). The default session
    (``session_id = 0``) is non-deletable."""

    session_id: int  # u64
    request_id: bytes  # 16-byte byte string
    hard: bool = False
    act_as: Optional[ActAs] = None

    def to_map(self) -> dict:
        m: dict = {
            "session_id": self.session_id,
            "hard": self.hard,
            "request_id": self.request_id,
        }
        if self.act_as is not None:
            m["act_as"] = self.act_as.to_map()
        return m

    @classmethod
    def from_map(cls, m: dict) -> "SessionDeleteRequest":
        act_as = m.get("act_as")
        return cls(
            m["session_id"],
            m["request_id"],
            bool(m.get("hard", False)),
            None if act_as is None else ActAs.from_map(act_as),
        )


@dataclass
class SessionDeleteResponse:
    """SESSION_DELETE_RESP (``0x00F5``). ``existed`` is False when the session
    had no registry row. ``space_id`` is the effective space's derived 16-byte
    storage id."""

    space_id: bytes  # 16-byte byte string (derived storage id)
    session_id: int  # u64
    existed: bool
    memories_forgotten: int

    def to_map(self) -> dict:
        return {
            "space_id": self.space_id,
            "session_id": self.session_id,
            "existed": self.existed,
            "memories_forgotten": self.memories_forgotten,
        }

    @classmethod
    def from_map(cls, m: dict) -> "SessionDeleteResponse":
        return cls(
            m["space_id"],
            m["session_id"],
            m["existed"],
            m["memories_forgotten"],
        )
