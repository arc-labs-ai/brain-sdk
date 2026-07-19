"""The Brain HTTP contract — response types for :class:`BrainHttpClient`.

Field names are the JSON wire names (snake_case), identical across the Rust,
Python, and TypeScript SDKs. Each type parses from the edge's JSON via
``from_dict``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class EncodeResult:
    memory_id: str
    was_deduplicated: bool
    salience: float
    kind: int
    created_at_unix_nanos: int
    auto_edges_added: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EncodeResult":
        return cls(
            memory_id=d["memory_id"],
            was_deduplicated=d["was_deduplicated"],
            salience=d["salience"],
            kind=d["kind"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
            auto_edges_added=d["auto_edges_added"],
        )


@dataclass
class MemoryHit:
    memory_id: str
    text: str
    similarity_score: float
    confidence: float
    salience: float
    kind: int
    created_at_unix_nanos: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MemoryHit":
        return cls(
            memory_id=d["memory_id"],
            text=d["text"],
            similarity_score=d["similarity_score"],
            confidence=d["confidence"],
            salience=d["salience"],
            kind=d["kind"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
        )


@dataclass
class RecallResult:
    answer_kind: str
    memories: list[MemoryHit]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RecallResult":
        return cls(
            answer_kind=d["answer_kind"],
            memories=[MemoryHit.from_dict(m) for m in d.get("memories", [])],
        )


@dataclass
class ForgetResult:
    memory_id: str
    was_already_forgotten: bool
    edges_removed: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ForgetResult":
        return cls(
            memory_id=d["memory_id"],
            was_already_forgotten=d["was_already_forgotten"],
            edges_removed=d["edges_removed"],
        )


@dataclass
class LinkResult:
    source: str
    target: str
    kind: str
    weight: float
    created_at_unix_nanos: int
    already_existed: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LinkResult":
        return cls(
            source=d["source"],
            target=d["target"],
            kind=d["kind"],
            weight=d["weight"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
            already_existed=d["already_existed"],
        )


@dataclass
class UnlinkResult:
    source: str
    target: str
    kind: str
    removed: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "UnlinkResult":
        return cls(source=d["source"], target=d["target"], kind=d["kind"], removed=d["removed"])


@dataclass
class PlanStep:
    step_index: int
    memory_id: str
    text: str
    transition_kind: str
    confidence: float
    estimated_distance_to_goal: float

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "PlanStep":
        return cls(
            step_index=d["step_index"],
            memory_id=d["memory_id"],
            text=d["text"],
            transition_kind=d["transition_kind"],
            confidence=d["confidence"],
            estimated_distance_to_goal=d["estimated_distance_to_goal"],
        )


@dataclass
class PlanResult:
    steps: list[PlanStep]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "PlanResult":
        return cls(steps=[PlanStep.from_dict(s) for s in d.get("steps", [])])


@dataclass
class InferenceStep:
    step_index: int
    claim: str
    supporting_memories: list[str]
    contradicting_memories: list[str]
    confidence: float
    inference_kind: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "InferenceStep":
        return cls(
            step_index=d["step_index"],
            claim=d["claim"],
            supporting_memories=list(d.get("supporting_memories", [])),
            contradicting_memories=list(d.get("contradicting_memories", [])),
            confidence=d["confidence"],
            inference_kind=d["inference_kind"],
        )


@dataclass
class ReasonResult:
    inferences: list[InferenceStep]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ReasonResult":
        return cls(inferences=[InferenceStep.from_dict(s) for s in d.get("inferences", [])])


@dataclass
class Permissions:
    can_encode: bool
    can_recall: bool
    can_plan: bool
    can_reason: bool
    can_forget: bool
    can_admin: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Permissions":
        return cls(
            can_encode=d["can_encode"],
            can_recall=d["can_recall"],
            can_plan=d["can_plan"],
            can_reason=d["can_reason"],
            can_forget=d["can_forget"],
            can_admin=d["can_admin"],
        )


@dataclass
class Whoami:
    namespace: str
    agent_id: str
    permissions: Permissions

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Whoami":
        return cls(
            namespace=d["namespace"],
            agent_id=d["agent_id"],
            permissions=Permissions.from_dict(d["permissions"]),
        )


@dataclass
class Capabilities:
    rerank: bool
    llm_extractor: bool
    classifier_extractor: bool
    pattern_extractor: bool
    schema_namespaces: list[str]
    vector_dim: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Capabilities":
        return cls(
            rerank=d["rerank"],
            llm_extractor=d["llm_extractor"],
            classifier_extractor=d["classifier_extractor"],
            pattern_extractor=d["pattern_extractor"],
            schema_namespaces=list(d.get("schema_namespaces", [])),
            vector_dim=d["vector_dim"],
        )
