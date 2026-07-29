"""The Brain HTTP contract — response types for :class:`BrainHttpClient`.

Field names are the JSON wire names (snake_case), identical across the Rust,
Python, and TypeScript SDKs. Each type parses from the edge's JSON via
``from_dict``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class EncodeResult:
    memory_id: str
    was_deduplicated: bool
    salience: float
    kind: int
    created_at_unix_nanos: int
    auto_edges_added: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EncodeResult:
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
    def from_dict(cls, d: dict[str, Any]) -> MemoryHit:
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
    def from_dict(cls, d: dict[str, Any]) -> RecallResult:
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
    def from_dict(cls, d: dict[str, Any]) -> ForgetResult:
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
    def from_dict(cls, d: dict[str, Any]) -> LinkResult:
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
    def from_dict(cls, d: dict[str, Any]) -> UnlinkResult:
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
    def from_dict(cls, d: dict[str, Any]) -> PlanStep:
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
    def from_dict(cls, d: dict[str, Any]) -> PlanResult:
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
    def from_dict(cls, d: dict[str, Any]) -> InferenceStep:
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
    def from_dict(cls, d: dict[str, Any]) -> ReasonResult:
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
    def from_dict(cls, d: dict[str, Any]) -> Permissions:
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
    space_id: str
    permissions: Permissions

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Whoami:
        return cls(
            namespace=d["namespace"],
            space_id=d["space_id"],
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
    def from_dict(cls, d: dict[str, Any]) -> Capabilities:
        return cls(
            rerank=d["rerank"],
            llm_extractor=d["llm_extractor"],
            classifier_extractor=d["classifier_extractor"],
            pattern_extractor=d["pattern_extractor"],
            schema_namespaces=list(d.get("schema_namespaces", [])),
            vector_dim=d["vector_dim"],
        )


# --- entities --------------------------------------------------------------


@dataclass
class EntityDetail:
    entity_id: str
    entity_type_id: int
    canonical_name: str
    aliases: list[str]
    mention_count: int
    created_at_unix_nanos: int
    updated_at_unix_nanos: int
    merged_into: Optional[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> EntityDetail:
        return cls(
            entity_id=d["entity_id"],
            entity_type_id=d["entity_type_id"],
            canonical_name=d["canonical_name"],
            aliases=list(d.get("aliases", [])),
            mention_count=d["mention_count"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
            updated_at_unix_nanos=d["updated_at_unix_nanos"],
            merged_into=d.get("merged_into"),
        )


@dataclass
class ListEntitiesResult:
    entities: list[EntityDetail]
    count: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ListEntitiesResult:
        return cls(
            entities=[EntityDetail.from_dict(e) for e in d.get("entities", [])],
            count=d["count"],
        )


@dataclass
class CreateEntityResult:
    entity_id: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> CreateEntityResult:
        return cls(entity_id=d["entity_id"])


@dataclass
class ResolveEntityResult:
    outcome: str
    tier: int
    confidence: float
    entity_id: Optional[str]
    candidate_ids: list[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ResolveEntityResult:
        return cls(
            outcome=d["outcome"],
            tier=d["tier"],
            confidence=d["confidence"],
            entity_id=d.get("entity_id"),
            candidate_ids=list(d.get("candidate_ids", [])),
        )


# --- traversal -------------------------------------------------------------


@dataclass
class TraversalStep:
    """One hop of a traversal path.

    ``from_`` carries the JSON key ``"from"`` — ``from`` is a Python keyword, so
    it is the one field name on the HTTP contract that cannot be spelled
    literally. Every other field here is the wire name verbatim.
    """

    relation_id: str
    from_: str
    to: str
    relation_type: str
    depth: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TraversalStep:
        return cls(
            relation_id=d["relation_id"],
            from_=d["from"],
            to=d["to"],
            relation_type=d["relation_type"],
            depth=d["depth"],
        )


@dataclass
class TraversalPath:
    steps: list[TraversalStep]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TraversalPath:
        return cls(steps=[TraversalStep.from_dict(s) for s in d.get("steps", [])])


@dataclass
class TraverseResult:
    paths: list[TraversalPath]
    total_paths: int
    truncated: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TraverseResult:
        return cls(
            paths=[TraversalPath.from_dict(p) for p in d.get("paths", [])],
            total_paths=d["total_paths"],
            truncated=d["truncated"],
        )


# --- relations -------------------------------------------------------------


@dataclass
class RelationDetail:
    relation_id: str
    relation_type: str
    from_entity: str
    to_entity: str
    confidence: float
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    is_symmetric: bool
    tombstoned: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RelationDetail:
        return cls(
            relation_id=d["relation_id"],
            relation_type=d["relation_type"],
            from_entity=d["from_entity"],
            to_entity=d["to_entity"],
            confidence=d["confidence"],
            valid_from_unix_nanos=d["valid_from_unix_nanos"],
            valid_to_unix_nanos=d["valid_to_unix_nanos"],
            is_symmetric=d["is_symmetric"],
            tombstoned=d["tombstoned"],
        )


@dataclass
class ListRelationsResult:
    relations: list[RelationDetail]
    count: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ListRelationsResult:
        return cls(
            relations=[RelationDetail.from_dict(r) for r in d.get("relations", [])],
            count=d["count"],
        )


# --- statements ------------------------------------------------------------


@dataclass
class StatementValue:
    """A literal statement object.

    Internally tagged: the discriminant rides in ``type`` alongside ``value`` in
    one flat object, e.g. ``{"type": "integer", "value": 1815}``. Tag spellings
    are snake_case per the container's ``rename_all`` — note ``unix_nanos``,
    which is the one that does not fall out of lowercasing the variant name.

    ``value``'s Python type follows the tag: ``text`` is ``str``, ``integer``
    and ``unix_nanos`` are ``int``, ``float`` is ``float``, ``bool`` is
    ``bool``, and ``blob`` is a ``list`` of byte-valued ``int``. Left as
    :data:`~typing.Any` because the contract genuinely varies it — ``type`` is
    what tells you which you have.
    """

    type: str
    value: Any

    #: Every tag the edge can emit, in contract order.
    TYPES = ("text", "integer", "float", "bool", "unix_nanos", "blob")

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StatementValue:
        return cls(type=d["type"], value=d["value"])


@dataclass
class StatementObject:
    """The object slot of a statement — a reference, or a literal.

    Internally tagged on ``kind`` with snake_case spellings: ``entity``,
    ``memory`` and ``statement`` each carry an ``id``, while ``value`` carries a
    :class:`StatementValue`. Exactly one of ``id`` / ``value`` is populated, and
    ``kind`` says which.

    This is *not* the same encoding as the wire tier's
    :class:`brain_db_sdk.wire.types.StatementObject`, which is externally tagged
    CBOR (``{"Value": ...}``). Same concept, different wire shape — the HTTP
    contract is the authority here.
    """

    kind: str
    id: Optional[str]
    value: Optional[StatementValue]

    #: Every tag the edge can emit, in contract order.
    KINDS = ("entity", "value", "memory", "statement")

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StatementObject:
        value = d.get("value")
        return cls(
            kind=d["kind"],
            id=d.get("id"),
            # Only the `value` variant nests a StatementValue; for the three
            # reference variants the key is absent.
            value=StatementValue.from_dict(value) if value is not None else None,
        )


@dataclass
class StatementDetail:
    statement_id: str
    kind: str
    subject: str
    predicate: str
    object: StatementObject
    confidence: float
    event_at_unix_nanos: int
    valid_from_unix_nanos: int
    valid_to_unix_nanos: int
    tombstoned: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StatementDetail:
        return cls(
            statement_id=d["statement_id"],
            kind=d["kind"],
            subject=d["subject"],
            predicate=d["predicate"],
            object=StatementObject.from_dict(d["object"]),
            confidence=d["confidence"],
            event_at_unix_nanos=d["event_at_unix_nanos"],
            valid_from_unix_nanos=d["valid_from_unix_nanos"],
            valid_to_unix_nanos=d["valid_to_unix_nanos"],
            tombstoned=d["tombstoned"],
        )


@dataclass
class ListStatementsResult:
    statements: list[StatementDetail]
    count: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ListStatementsResult:
        return cls(
            statements=[StatementDetail.from_dict(s) for s in d.get("statements", [])],
            count=d["count"],
        )


# --- graph -----------------------------------------------------------------


@dataclass
class GraphNode:
    id: str
    kind: str
    label: str
    type_qname: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GraphNode:
        return cls(
            id=d["id"],
            kind=d["kind"],
            label=d["label"],
            type_qname=d["type_qname"],
        )


@dataclass
class GraphEdge:
    from_id: str
    to_id: str
    kind: str
    label: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GraphEdge:
        return cls(
            from_id=d["from_id"],
            to_id=d["to_id"],
            kind=d["kind"],
            label=d["label"],
        )


@dataclass
class GraphPage:
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    next_cursor: Optional[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> GraphPage:
        return cls(
            nodes=[GraphNode.from_dict(n) for n in d.get("nodes", [])],
            edges=[GraphEdge.from_dict(e) for e in d.get("edges", [])],
            # ``skip_serializing_if = Option::is_none`` — absent, not null, on
            # the last page.
            next_cursor=d.get("next_cursor"),
        )


# --- memory listing --------------------------------------------------------


@dataclass
class MemoryListItem:
    memory_id: str
    text: str
    kind: int
    state: int
    created_at_unix_nanos: int
    occurred_at_unix_nanos: int
    last_accessed_at_unix_nanos: int
    salience: float
    access_count: int
    statement_count: int
    entity_count: int
    relation_count: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryListItem:
        return cls(
            memory_id=d["memory_id"],
            text=d["text"],
            kind=d["kind"],
            state=d["state"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
            occurred_at_unix_nanos=d["occurred_at_unix_nanos"],
            last_accessed_at_unix_nanos=d["last_accessed_at_unix_nanos"],
            salience=d["salience"],
            access_count=d["access_count"],
            statement_count=d["statement_count"],
            entity_count=d["entity_count"],
            relation_count=d["relation_count"],
        )


@dataclass
class MemoryListPage:
    items: list[MemoryListItem]
    next_cursor: Optional[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryListPage:
        return cls(
            items=[MemoryListItem.from_dict(i) for i in d.get("items", [])],
            # ``skip_serializing_if = Option::is_none`` — absent, not null, on
            # the last page.
            next_cursor=d.get("next_cursor"),
        )


# --- memory inspection -----------------------------------------------------


@dataclass
class StageRecord:
    memory_id: str
    kind: int
    salience: float
    created_at_unix_nanos: int
    occurred_at_unix_nanos: int
    vector_dim: int
    text_len: int
    lsn: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageRecord:
        return cls(
            memory_id=d["memory_id"],
            kind=d["kind"],
            salience=d["salience"],
            created_at_unix_nanos=d["created_at_unix_nanos"],
            occurred_at_unix_nanos=d["occurred_at_unix_nanos"],
            vector_dim=d["vector_dim"],
            text_len=d["text_len"],
            lsn=d["lsn"],
        )


@dataclass
class StageKeywordField:
    field: str
    terms: list[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageKeywordField:
        return cls(field=d["field"], terms=list(d.get("terms", [])))


@dataclass
class StageGraphNode:
    id: str
    name: str
    kind: str
    type_qname: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageGraphNode:
        return cls(
            id=d["id"],
            name=d["name"],
            kind=d["kind"],
            type_qname=d["type_qname"],
        )


@dataclass
class StageGraphEdge:
    source: str
    target: str
    predicate: str
    kind: str
    confidence: float
    event_at_unix_nanos: Optional[int]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageGraphEdge:
        return cls(
            source=d["source"],
            target=d["target"],
            predicate=d["predicate"],
            kind=d["kind"],
            confidence=d["confidence"],
            event_at_unix_nanos=d.get("event_at_unix_nanos"),
        )


@dataclass
class StageGraph:
    nodes: list[StageGraphNode]
    edges: list[StageGraphEdge]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageGraph:
        return cls(
            nodes=[StageGraphNode.from_dict(n) for n in d.get("nodes", [])],
            edges=[StageGraphEdge.from_dict(e) for e in d.get("edges", [])],
        )


@dataclass
class StageArtifact:
    vector: list[float]
    record: Optional[StageRecord]
    hype_questions: list[str]
    keyword_fields: list[StageKeywordField]
    graph: Optional[StageGraph]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageArtifact:
        record = d.get("record")
        graph = d.get("graph")
        return cls(
            vector=list(d.get("vector", [])),
            record=StageRecord.from_dict(record) if record is not None else None,
            hype_questions=list(d.get("hype_questions", [])),
            keyword_fields=[StageKeywordField.from_dict(k) for k in d.get("keyword_fields", [])],
            graph=StageGraph.from_dict(graph) if graph is not None else None,
        )


@dataclass
class MemoryInspect:
    found: bool
    memory_id: str
    text: str
    artifact: StageArtifact

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryInspect:
        return cls(
            found=d["found"],
            memory_id=d["memory_id"],
            text=d["text"],
            artifact=StageArtifact.from_dict(d["artifact"]),
        )


# --- schema ----------------------------------------------------------------


@dataclass
class SchemaError:
    code: str
    message: str
    line: int
    column: int
    length: int
    severity: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SchemaError:
        return cls(
            code=d["code"],
            message=d["message"],
            line=d["line"],
            column=d["column"],
            length=d["length"],
            severity=d["severity"],
        )


@dataclass
class Schema:
    namespace: str
    schema_version: int
    schema_document: str
    uploaded_at_unix_nanos: int
    validator_version: int

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Schema:
        return cls(
            namespace=d["namespace"],
            schema_version=d["schema_version"],
            schema_document=d["schema_document"],
            uploaded_at_unix_nanos=d["uploaded_at_unix_nanos"],
            validator_version=d["validator_version"],
        )


@dataclass
class SchemaUpload:
    namespace: str
    schema_version: int
    backward_compatible: bool
    validation_errors: list[SchemaError]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SchemaUpload:
        return cls(
            namespace=d["namespace"],
            schema_version=d["schema_version"],
            backward_compatible=d["backward_compatible"],
            validation_errors=[SchemaError.from_dict(e) for e in d.get("validation_errors", [])],
        )


@dataclass
class SchemaValidate:
    namespace: str
    would_be_version: int
    validation_errors: list[SchemaError]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SchemaValidate:
        return cls(
            namespace=d["namespace"],
            would_be_version=d["would_be_version"],
            validation_errors=[SchemaError.from_dict(e) for e in d.get("validation_errors", [])],
        )


@dataclass
class SchemaReplace:
    namespace: str
    schema_version: int
    dropped_count: int
    validation_errors: list[SchemaError]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SchemaReplace:
        return cls(
            namespace=d["namespace"],
            schema_version=d["schema_version"],
            dropped_count=d["dropped_count"],
            validation_errors=[SchemaError.from_dict(e) for e in d.get("validation_errors", [])],
        )
