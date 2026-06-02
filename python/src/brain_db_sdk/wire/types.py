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
from typing import Optional

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
    EPISODIC = 0
    SEMANTIC = 1
    CONSOLIDATED = 2


class EdgeKind:
    CAUSED = 0
    FOLLOWED_BY = 1
    DERIVED_FROM = 2
    SIMILAR_TO = 3
    CONTRADICTS = 4
    SUPPORTS = 5
    REFERENCES = 6
    PART_OF = 7


class ForgetMode:
    SOFT = 0
    HARD = 1


class StageKind:
    AUTO_EDGE = 0
    TEMPORAL_EDGE = 1
    EXTRACTOR = 2


class AuthMethod:
    TOKEN = 0
    MTLS = 1
    NONE = 2


class RetrieverName:
    SEMANTIC = 0
    LEXICAL = 1
    GRAPH = 2


class ErrorCategory:
    PROTOCOL = 0
    AUTHENTICATION = 1
    AUTHORIZATION = 2
    VALIDATION = 3
    NOT_FOUND = 4
    CONFLICT = 5
    RESOURCE_EXHAUSTED = 6
    INTERNAL = 7
    UNAVAILABLE = 8


# ===========================================================================
# Handshake.
# ===========================================================================


@dataclass
class HelloCapabilities:
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
    client_id: str
    supported_versions: list[int]
    capabilities: HelloCapabilities
    # Reserved for session resumption; None encodes as CBOR null.
    client_session_token: Optional[bytes]

    def to_map(self) -> dict:
        return {
            "client_id": self.client_id,
            "supported_versions": list(self.supported_versions),
            "capabilities": self.capabilities.to_map(),
            "client_session_token": self.client_session_token,
        }

    @classmethod
    def from_map(cls, m: dict) -> "HelloPayload":
        return cls(
            m["client_id"],
            list(m["supported_versions"]),
            HelloCapabilities.from_map(m["capabilities"]),
            m["client_session_token"],
        )


@dataclass
class MtlsClaim:
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
    ``{"Token": [bytes...]}`` (the token is a Vec<u8> array), ``Mtls`` is
    ``{"Mtls": {claim}}``, and ``None`` is the unit string ``"None"``.
    """

    variant: str
    value: object = None

    @classmethod
    def token(cls, raw: bytes) -> "AuthCredentials":
        return cls("Token", list(raw))

    @classmethod
    def mtls(cls, claim: MtlsClaim) -> "AuthCredentials":
        return cls("Mtls", claim)

    @classmethod
    def none(cls) -> "AuthCredentials":
        return cls("None")

    def to_cbor_value(self) -> object:
        if self.variant == "None":
            return "None"
        if self.variant == "Token":
            return {"Token": list(self.value)}
        if self.variant == "Mtls":
            return {"Mtls": self.value.to_map()}
        raise ValueError(f"unknown credential variant {self.variant!r}")

    @classmethod
    def from_cbor_value(cls, v: object) -> "AuthCredentials":
        if v == "None":
            return cls("None")
        if isinstance(v, dict) and "Token" in v:
            return cls("Token", list(v["Token"]))
        if isinstance(v, dict) and "Mtls" in v:
            return cls("Mtls", MtlsClaim.from_map(v["Mtls"]))
        raise ValueError(f"unknown credential cbor {v!r}")


@dataclass
class AuthPayload:
    method: int
    agent_id: bytes  # 16-byte byte string
    credentials: AuthCredentials

    def to_map(self) -> dict:
        return {
            "method": self.method,
            "agent_id": self.agent_id,
            "credentials": self.credentials.to_cbor_value(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "AuthPayload":
        return cls(
            m["method"],
            m["agent_id"],
            AuthCredentials.from_cbor_value(m["credentials"]),
        )


@dataclass
class AgentPermissions:
    can_encode: bool
    can_recall: bool
    can_plan: bool
    can_reason: bool
    can_forget: bool
    can_admin: bool

    def to_map(self) -> dict:
        return {
            "can_encode": self.can_encode,
            "can_recall": self.can_recall,
            "can_plan": self.can_plan,
            "can_reason": self.can_reason,
            "can_forget": self.can_forget,
            "can_admin": self.can_admin,
        }

    @classmethod
    def from_map(cls, m: dict) -> "AgentPermissions":
        return cls(
            m["can_encode"],
            m["can_recall"],
            m["can_plan"],
            m["can_reason"],
            m["can_forget"],
            m["can_admin"],
        )


@dataclass
class ServerFeatures:
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
    server_id: str
    chosen_version: int
    session_id: bytes  # 16-byte byte string
    capabilities: HelloCapabilities
    server_features: ServerFeatures

    def to_map(self) -> dict:
        return {
            "server_id": self.server_id,
            "chosen_version": self.chosen_version,
            "session_id": self.session_id,
            "capabilities": self.capabilities.to_map(),
            "server_features": self.server_features.to_map(),
        }

    @classmethod
    def from_map(cls, m: dict) -> "WelcomePayload":
        return cls(
            m["server_id"],
            m["chosen_version"],
            m["session_id"],
            HelloCapabilities.from_map(m["capabilities"]),
            ServerFeatures.from_map(m["server_features"]),
        )


@dataclass
class AuthOkPayload:
    agent_id: bytes
    bound_shard_id: int
    permissions: AgentPermissions
    server_time_unix_nanos: int

    def to_map(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "bound_shard_id": self.bound_shard_id,
            "permissions": self.permissions.to_map(),
            "server_time_unix_nanos": self.server_time_unix_nanos,
        }

    @classmethod
    def from_map(cls, m: dict) -> "AuthOkPayload":
        return cls(
            m["agent_id"],
            m["bound_shard_id"],
            AgentPermissions.from_map(m["permissions"]),
            m["server_time_unix_nanos"],
        )


# ===========================================================================
# ENCODE / ENCODE_VECTOR_DIRECT.
# ===========================================================================


@dataclass
class EdgeRequest:
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
    text: str
    context_id: int  # u64
    kind: int
    salience_hint: float  # f32
    edges: list[EdgeRequest]
    request_id: bytes  # 16-byte byte string
    txn_id: Optional[bytes]  # 16-byte byte string or None
    deduplicate: bool

    def to_map(self) -> dict:
        return {
            "text": self.text,
            "context_id": self.context_id,
            "kind": self.kind,
            "salience_hint": round_f32(self.salience_hint),
            "edges": [e.to_map() for e in self.edges],
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "deduplicate": self.deduplicate,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeRequest":
        return cls(
            m["text"],
            m["context_id"],
            m["kind"],
            m["salience_hint"],
            [EdgeRequest.from_map(e) for e in m["edges"]],
            m["request_id"],
            m["txn_id"],
            m["deduplicate"],
        )


@dataclass
class EncodeVectorDirectRequest:
    """The embedding rides the trailing raw little-endian f32 section, never
    the CBOR map. ``vector`` is excluded from ``to_map`` and reattached by
    ``encode_payload`` / ``decode_payload``.
    """

    text: str
    model_fingerprint: bytes  # 16-byte byte string
    context_id: int
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
            "context_id": self.context_id,
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
            m["context_id"],
            m["kind"],
            m["salience_hint"],
            [EdgeRequest.from_map(e) for e in m["edges"]],
            m["request_id"],
            m["txn_id"],
            m["deduplicate"],
        )


@dataclass
class EncodeResponse:
    memory_id: int  # u128
    was_deduplicated: bool
    salience: float  # f32
    auto_edges_added: int
    lsn: int
    agent_id: bytes
    context_id: int
    kind: int
    created_at_unix_nanos: int
    edges_out_count: int
    embedding_model_fp: bytes
    pending_stages: list[int]
    has_active_schema: bool

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "was_deduplicated": self.was_deduplicated,
            "salience": round_f32(self.salience),
            "auto_edges_added": self.auto_edges_added,
            "lsn": self.lsn,
            "agent_id": self.agent_id,
            "context_id": self.context_id,
            "kind": self.kind,
            "created_at_unix_nanos": self.created_at_unix_nanos,
            "edges_out_count": self.edges_out_count,
            "embedding_model_fp": self.embedding_model_fp,
            "pending_stages": list(self.pending_stages),
            "has_active_schema": self.has_active_schema,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EncodeResponse":
        return cls(
            m["memory_id"],
            m["was_deduplicated"],
            m["salience"],
            m["auto_edges_added"],
            m["lsn"],
            m["agent_id"],
            m["context_id"],
            m["kind"],
            m["created_at_unix_nanos"],
            m["edges_out_count"],
            m["embedding_model_fp"],
            list(m["pending_stages"]),
            m["has_active_schema"],
        )


# ===========================================================================
# RECALL.
# ===========================================================================


@dataclass
class RecallRequest:
    cue_text: str
    top_k: int
    confidence_threshold: float  # f32
    context_filter: Optional[list[int]]
    age_bound_unix_nanos: Optional[int]
    kind_filter: Optional[list[int]]
    salience_floor: float  # f32
    include_edges: bool
    include_graph: bool
    include_text: bool
    request_id: Optional[bytes]
    txn_id: Optional[bytes]
    agent_filter: list[bytes]  # list of 16-byte byte strings
    include_other_agents: bool

    def to_map(self) -> dict:
        return {
            "cue_text": self.cue_text,
            "top_k": self.top_k,
            "confidence_threshold": round_f32(self.confidence_threshold),
            "context_filter": (
                None if self.context_filter is None else list(self.context_filter)
            ),
            "age_bound_unix_nanos": self.age_bound_unix_nanos,
            "kind_filter": None if self.kind_filter is None else list(self.kind_filter),
            "salience_floor": round_f32(self.salience_floor),
            "include_edges": self.include_edges,
            "include_graph": self.include_graph,
            "include_text": self.include_text,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
            "agent_filter": list(self.agent_filter),
            "include_other_agents": self.include_other_agents,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallRequest":
        return cls(
            m["cue_text"],
            m["top_k"],
            m["confidence_threshold"],
            None if m["context_filter"] is None else list(m["context_filter"]),
            m["age_bound_unix_nanos"],
            None if m["kind_filter"] is None else list(m["kind_filter"]),
            m["salience_floor"],
            m["include_edges"],
            m["include_graph"],
            m["include_text"],
            m["request_id"],
            m["txn_id"],
            list(m["agent_filter"]),
            m["include_other_agents"],
        )


@dataclass
class EdgeView:
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
    id: bytes
    subject_name: str
    predicate: str
    object_label: str
    confidence: float  # f32

    def to_map(self) -> dict:
        return {
            "id": self.id,
            "subject_name": self.subject_name,
            "predicate": self.predicate,
            "object_label": self.object_label,
            "confidence": round_f32(self.confidence),
        }

    @classmethod
    def from_map(cls, m: dict) -> "EnrichedStatement":
        return cls(m["id"], m["subject_name"], m["predicate"], m["object_label"], m["confidence"])


@dataclass
class EnrichedRelation:
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
    memory_id: int  # u128
    text: str
    similarity_score: float  # f32
    confidence: float  # f32
    salience: float  # f32
    kind: int
    agent_id: bytes
    context_id: int
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
            "agent_id": self.agent_id,
            "context_id": self.context_id,
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
            m["agent_id"],
            m["context_id"],
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
            m["edges_out_count"],
            m["edges_in_count"],
            None if m["graph"] is None else GraphEnrichment.from_map(m["graph"]),
        )


@dataclass
class RecallResponseFrame:
    results: list[MemoryResult]
    is_final: bool
    cumulative_count: int
    estimated_remaining: Optional[int]

    def to_map(self) -> dict:
        return {
            "results": [r.to_map() for r in self.results],
            "is_final": self.is_final,
            "cumulative_count": self.cumulative_count,
            "estimated_remaining": self.estimated_remaining,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RecallResponseFrame":
        return cls(
            [MemoryResult.from_map(r) for r in m["results"]],
            m["is_final"],
            m["cumulative_count"],
            m["estimated_remaining"],
        )


# ===========================================================================
# FORGET.
# ===========================================================================


@dataclass
class ForgetRequest:
    memory_id: int  # u128
    mode: int
    request_id: bytes
    txn_id: Optional[bytes]

    def to_map(self) -> dict:
        return {
            "memory_id": self.memory_id,
            "mode": self.mode,
            "request_id": self.request_id,
            "txn_id": self.txn_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "ForgetRequest":
        return cls(m["memory_id"], m["mode"], m["request_id"], m["txn_id"])


@dataclass
class ForgetResponse:
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
# ERROR.
# ===========================================================================


@dataclass
class ErrorDetails:
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
    """Statement kind. Encoded as the variant-name string on the wire."""

    FACT = "Fact"
    PREFERENCE = "Preference"
    EVENT = "Event"


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
    entity_type_id: int
    canonical_name: str
    aliases: list[str]
    attributes_blob: list[int]  # Vec<u8> -> CBOR array of ints
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "entity_type_id": self.entity_type_id,
            "canonical_name": self.canonical_name,
            "aliases": list(self.aliases),
            "attributes_blob": list(self.attributes_blob),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "EntityCreateRequest":
        return cls(
            m["entity_type_id"],
            m["canonical_name"],
            list(m["aliases"]),
            list(m["attributes_blob"]),
            m["request_id"],
        )


@dataclass
class EntityCreateResponse:
    entity_id: bytes  # 16-byte byte string

    def to_map(self) -> dict:
        return {"entity_id": self.entity_id}

    @classmethod
    def from_map(cls, m: dict) -> "EntityCreateResponse":
        return cls(m["entity_id"])


@dataclass
class StatementCreateRequest:
    kind: str  # StatementKind variant-name string
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
    request_id: bytes

    def to_map(self) -> dict:
        return {
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
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "StatementCreateRequest":
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
            m["request_id"],
        )


@dataclass
class StatementCreateResponse:
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
    relation_type: str
    from_entity: bytes
    to_entity: bytes
    properties_blob: list[int]  # Vec<u8> -> CBOR array of ints
    evidence: EvidenceRef
    extractor_id: int
    confidence: float  # f32
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "relation_type": self.relation_type,
            "from_entity": self.from_entity,
            "to_entity": self.to_entity,
            "properties_blob": list(self.properties_blob),
            "evidence": self.evidence.to_cbor_value(),
            "extractor_id": self.extractor_id,
            "confidence": round_f32(self.confidence),
            "valid_from_unix_nanos": self.valid_from_unix_nanos,
            "valid_to_unix_nanos": self.valid_to_unix_nanos,
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RelationCreateRequest":
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
            m["request_id"],
        )


@dataclass
class RelationCreateResponse:
    relation_id: bytes

    def to_map(self) -> dict:
        return {"relation_id": self.relation_id}

    @classmethod
    def from_map(cls, m: dict) -> "RelationCreateResponse":
        return cls(m["relation_id"])


@dataclass
class SchemaUploadRequest:
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
class SchemaUploadResponse:
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
    from_unix_ms: Optional[int]
    to_unix_ms: Optional[int]

    def to_map(self) -> dict:
        return {"from_unix_ms": self.from_unix_ms, "to_unix_ms": self.to_unix_ms}

    @classmethod
    def from_map(cls, m: dict) -> "TimeRange":
        return cls(m["from_unix_ms"], m["to_unix_ms"])


@dataclass
class FusionConfig:
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
    """Externally-tagged routing: ``"Auto"`` unit string or
    ``{"Explicit": [retriever ints]}``.
    """

    variant: str
    value: object = None

    @classmethod
    def auto(cls) -> "RetrieverSelection":
        return cls("Auto")

    @classmethod
    def explicit(cls, retrievers: list[int]) -> "RetrieverSelection":
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
    text: str
    entity_anchor: Optional[bytes]
    kind_filter: list[int]  # Vec<u8> -> array of ints
    predicate_filter: list[str]
    time_filter: Optional[TimeRange]
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
            "time_filter": None if self.time_filter is None else self.time_filter.to_map(),
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
            None if m["time_filter"] is None else TimeRange.from_map(m["time_filter"]),
            m["confidence_min"],
            m["include_tombstoned"],
            m["include_superseded"],
            m["limit"],
            RetrieverSelection.from_cbor_value(m["retrievers"]),
            None if m["fusion_config"] is None else FusionConfig.from_map(m["fusion_config"]),
            m["request_id"],
        )


@dataclass
class ItemId:
    kind: int
    bytes: bytes  # 16-byte byte string

    def to_map(self) -> dict:
        return {"kind": self.kind, "bytes": self.bytes}

    @classmethod
    def from_map(cls, m: dict) -> "ItemId":
        return cls(m["kind"], m["bytes"])


@dataclass
class RetrieverContribution:
    retriever: int
    rank: int
    raw_score: float  # f32

    def to_map(self) -> dict:
        return {
            "retriever": self.retriever,
            "rank": self.rank,
            "raw_score": round_f32(self.raw_score),
        }

    @classmethod
    def from_map(cls, m: dict) -> "RetrieverContribution":
        return cls(m["retriever"], m["rank"], m["raw_score"])


@dataclass
class RetrieverOutcome:
    retriever: int
    status: int
    message: str
    latency_ms: float  # f64
    result_count: int

    def to_map(self) -> dict:
        return {
            "retriever": self.retriever,
            "status": self.status,
            "message": self.message,
            "latency_ms": mark_f64(self.latency_ms),
            "result_count": self.result_count,
        }

    @classmethod
    def from_map(cls, m: dict) -> "RetrieverOutcome":
        return cls(m["retriever"], m["status"], m["message"], m["latency_ms"], m["result_count"])


@dataclass
class QueryResultItem:
    id: ItemId
    fused_score: float  # f64
    contributing: list[RetrieverContribution]

    def to_map(self) -> dict:
        return {
            "id": self.id.to_map(),
            "fused_score": mark_f64(self.fused_score),
            "contributing": [c.to_map() for c in self.contributing],
        }

    @classmethod
    def from_map(cls, m: dict) -> "QueryResultItem":
        return cls(
            ItemId.from_map(m["id"]),
            m["fused_score"],
            [RetrieverContribution.from_map(c) for c in m["contributing"]],
        )


@dataclass
class QueryResponse:
    items: list[QueryResultItem]
    total_latency_ms: float  # f64
    retriever_outcomes: list[RetrieverOutcome]

    def to_map(self) -> dict:
        return {
            "items": [i.to_map() for i in self.items],
            "total_latency_ms": mark_f64(self.total_latency_ms),
            "retriever_outcomes": [o.to_map() for o in self.retriever_outcomes],
        }

    @classmethod
    def from_map(cls, m: dict) -> "QueryResponse":
        return cls(
            [QueryResultItem.from_map(i) for i in m["items"]],
            m["total_latency_ms"],
            [RetrieverOutcome.from_map(o) for o in m["retriever_outcomes"]],
        )


@dataclass
class MaterializeProceduralRequest:
    agent_id: bytes
    context_filter: int  # u64
    top_k: int
    min_confidence: float  # f32
    categories: list[str]
    request_id: bytes

    def to_map(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "context_filter": self.context_filter,
            "top_k": self.top_k,
            "min_confidence": round_f32(self.min_confidence),
            "categories": list(self.categories),
            "request_id": self.request_id,
        }

    @classmethod
    def from_map(cls, m: dict) -> "MaterializeProceduralRequest":
        return cls(
            m["agent_id"],
            m["context_filter"],
            m["top_k"],
            m["min_confidence"],
            list(m["categories"]),
            m["request_id"],
        )


@dataclass
class MaterializeProceduralResponse:
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
