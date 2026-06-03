"""Read-side, edge, cognitive, txn, and capability verbs added to reach verb
parity with the Rust SDK.

Two layers of coverage:

  * ``test_read_side_types_round_trip`` — encode -> decode equality for every
    new wire type (these ops have no conformance corpus, so the guarantee is
    that the Python structs mirror the Rust structs field-for-field).
  * ``test_*_verbs`` — drive the new unary + streamed verbs against an
    in-process mock server over one connection and check the decoded replies.
"""

from __future__ import annotations

import socket
import threading
import uuid

from brain_db_sdk import BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.cbor import from_cbor, to_cbor
from brain_db_sdk.wire.types import (
    AgentPermissions,
    AuthOkPayload,
    AuthPayload,
    Capabilities,
    EntityGetRequest,
    EntityGetResponse,
    EntityListItem,
    EntityListRequest,
    EntityListResponseFrame,
    EntityResolveRequest,
    EntityResolveResponse,
    EntityView,
    EvidenceRef,
    GetCapabilitiesRequest,
    GetCapabilitiesResponse,
    HelloPayload,
    InferenceKind,
    InferenceStep,
    LinkRequest,
    LinkResponse,
    ObservationInput,
    PlanBudget,
    PlanRequest,
    PlanResponseFrame,
    PlanState,
    PlanStatus,
    PlanStep,
    PlanStrategy,
    ReasonRequest,
    ReasonResponseFrame,
    ReasonStatus,
    RelationListFromRequest,
    RelationListFromResponseFrame,
    RelationListToRequest,
    RelationListToResponseFrame,
    RelationView,
    ResolutionOutcome,
    SchemaGetRequest,
    SchemaGetResponse,
    SchemaListItem,
    SchemaListRequest,
    SchemaListResponseFrame,
    SchemaValidateRequest,
    SchemaValidateResponse,
    ServerFeatures,
    StatementGetRequest,
    StatementGetResponse,
    StatementKind,
    StatementListRequest,
    StatementListResponseFrame,
    StatementObject,
    StatementValue,
    StatementView,
    TransitionKind,
    TxnAbortRequest,
    TxnAbortResponse,
    TxnBeginRequest,
    TxnBeginResponse,
    TxnCommitRequest,
    TxnCommitResponse,
    UnlinkRequest,
    UnlinkResponse,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

ENTITY_ID = b"\x11" * 16
STATEMENT_ID = b"\x22" * 16
RELATION_ID = b"\x33" * 16
TXN_ID = b"\x44" * 16


def _rid() -> bytes:
    return uuid.uuid4().bytes


def _entity_view() -> EntityView:
    return EntityView(
        entity_id=ENTITY_ID,
        entity_type_id=1,
        canonical_name="Ada Lovelace",
        normalized_name="ada lovelace",
        aliases=["Ada"],
        attributes_blob=[1, 2, 3],
        mention_count=4,
        created_at_unix_nanos=10,
        updated_at_unix_nanos=20,
        merged_into=b"\x00" * 16,
        embedding_version=2,
        flags=0,
    )


def _statement_view() -> StatementView:
    return StatementView(
        statement_id=STATEMENT_ID,
        kind=StatementKind.FACT,
        subject=ENTITY_ID,
        subject_pending_audit_id=b"\x00" * 16,
        predicate="born_in",
        object=StatementObject("Value", StatementValue("Integer", 1815)),
        confidence=0.5,
        evidence=EvidenceRef.inline([]),
        extractor_id=0,
        extracted_at_unix_nanos=1,
        schema_version=1,
        valid_from_unix_nanos=0,
        valid_to_unix_nanos=(1 << 64) - 1,
        event_at_unix_nanos=0,
        version=1,
        superseded_by=b"\x00" * 16,
        supersedes=b"\x00" * 16,
        chain_root=STATEMENT_ID,
        tombstoned=False,
        tombstoned_at_unix_nanos=0,
        tombstone_reason=0,
        flags=0,
        is_stateful=True,
    )


def _relation_view() -> RelationView:
    return RelationView(
        relation_id=RELATION_ID,
        chain_root=RELATION_ID,
        relation_type="collaborated_with",
        from_entity=ENTITY_ID,
        to_entity=b"\x55" * 16,
        properties_blob=[],
        evidence=EvidenceRef.inline([]),
        extractor_id=0,
        extracted_at_unix_nanos=1,
        confidence=0.5,
        valid_from_unix_nanos=0,
        valid_to_unix_nanos=(1 << 64) - 1,
        version=1,
        superseded_by=b"\x00" * 16,
        supersedes=b"\x00" * 16,
        tombstoned=False,
        tombstoned_at_unix_nanos=0,
        flags=1,
    )


def _round_trip(value, cls) -> None:
    back = cls.from_map(from_cbor(to_cbor(value.to_map())))
    assert back == value, f"{cls.__name__} round-trip mismatch: {back} != {value}"


def test_read_side_types_round_trip() -> None:
    # Capabilities / edge / txn (unary).
    _round_trip(GetCapabilitiesRequest(), GetCapabilitiesRequest)
    _round_trip(
        GetCapabilitiesResponse(Capabilities(True, False, True, False, ["people"], 384)),
        GetCapabilitiesResponse,
    )
    _round_trip(LinkRequest(1, 2, 3, 0.5, _rid(), None), LinkRequest)
    _round_trip(LinkResponse(1, 2, 3, 0.5, 9, True), LinkResponse)
    _round_trip(UnlinkRequest(1, 2, 3, _rid(), TXN_ID), UnlinkRequest)
    _round_trip(UnlinkResponse(1, 2, 3, False), UnlinkResponse)
    _round_trip(TxnBeginRequest(TXN_ID, 30), TxnBeginRequest)
    _round_trip(TxnBeginResponse(TXN_ID, 30, 99), TxnBeginResponse)
    _round_trip(TxnCommitRequest(TXN_ID), TxnCommitRequest)
    _round_trip(TxnCommitResponse(TXN_ID, 100, 3), TxnCommitResponse)
    _round_trip(TxnAbortRequest(TXN_ID), TxnAbortRequest)
    _round_trip(TxnAbortResponse(TXN_ID, 2), TxnAbortResponse)

    # Entity get/list.
    _round_trip(EntityGetRequest(ENTITY_ID), EntityGetRequest)
    _round_trip(EntityGetResponse(_entity_view()), EntityGetResponse)
    _round_trip(
        EntityListRequest(1, "Ad", 0, False, False, 100, []), EntityListRequest
    )
    _round_trip(
        EntityListResponseFrame([EntityListItem(_entity_view())], [9], 1, True),
        EntityListResponseFrame,
    )

    # Entity resolve.
    _round_trip(
        EntityResolveRequest("Ada Lovelace", "she joined in 2020", 1, True, _rid()),
        EntityResolveRequest,
    )
    _round_trip(
        EntityResolveResponse(
            ResolutionOutcome.RESOLVED, 1, 1.0, ENTITY_ID, [], b"\x00" * 16
        ),
        EntityResolveResponse,
    )
    _round_trip(
        EntityResolveResponse(
            ResolutionOutcome.AMBIGUOUS,
            0,
            0.0,
            b"\x00" * 16,
            [ENTITY_ID, b"\x66" * 16],
            b"\x77" * 16,
        ),
        EntityResolveResponse,
    )

    # Statement get/list.
    _round_trip(StatementGetRequest(STATEMENT_ID, True), StatementGetRequest)
    _round_trip(StatementGetResponse(_statement_view(), True), StatementGetResponse)
    _round_trip(
        StatementListRequest(ENTITY_ID, "born_in", 1, 0.5, 0, 0, True, False, 50, []),
        StatementListRequest,
    )
    _round_trip(
        StatementListResponseFrame([_statement_view()], [], 1, True),
        StatementListResponseFrame,
    )

    # Relation list-from / list-to.
    _round_trip(
        RelationListFromRequest(ENTITY_ID, "", 0, 0, False, False, 50, []),
        RelationListFromRequest,
    )
    _round_trip(
        RelationListFromResponseFrame([_relation_view()], [], 1, True),
        RelationListFromResponseFrame,
    )
    _round_trip(
        RelationListToRequest(ENTITY_ID, "collaborated_with", 0, 0, False, False, 50, []),
        RelationListToRequest,
    )
    _round_trip(
        RelationListToResponseFrame([_relation_view()], [], 1, True),
        RelationListToResponseFrame,
    )

    # Schema get/list/validate.
    _round_trip(SchemaGetRequest("people", 0), SchemaGetRequest)
    _round_trip(SchemaGetResponse("people", 2, "entity Person {}", [1, 2], 10, 1), SchemaGetResponse)
    _round_trip(SchemaListRequest("people", 0, []), SchemaListRequest)
    _round_trip(
        SchemaListResponseFrame("people", [SchemaListItem(1, 5, 2, True)], 1, [], True),
        SchemaListResponseFrame,
    )
    _round_trip(SchemaValidateRequest("entity Person {}"), SchemaValidateRequest)
    _round_trip(SchemaValidateResponse("people", 3, []), SchemaValidateResponse)

    # Plan (streamed): unit + Other transition kinds, all PlanState variants.
    plan_req = PlanRequest(
        start=PlanState.by_text("start"),
        goal=PlanState.by_vector(0, 384),
        budget=PlanBudget(10, 100, 5),
        strategy_hint=PlanStrategy.A_STAR,
        context_filter=[1, 2],
        request_id=_rid(),
        txn_id=None,
    )
    _round_trip(plan_req, PlanRequest)
    step_a = PlanStep(0, 7, "a", TransitionKind("Causal"), 0.5, 0.25)
    step_b = PlanStep(1, 8, "b", TransitionKind.other("custom"), 0.5, 0.25)
    _round_trip(step_a, PlanStep)
    _round_trip(step_b, PlanStep)
    _round_trip(
        PlanResponseFrame([step_a, step_b], True, PlanStatus.GOAL_REACHED), PlanResponseFrame
    )

    # Reason (streamed).
    reason_req = ReasonRequest(
        observation=ObservationInput.by_memory_id(5),
        depth=3,
        confidence_threshold=0.5,
        context_filter=None,
        max_inferences=10,
        budget_wall_time_ms=1000,
        request_id=_rid(),
        txn_id=None,
    )
    _round_trip(reason_req, ReasonRequest)
    inf_a = InferenceStep(0, "claim", [1, 2], [], 0.5, InferenceKind("CausalExplanation"))
    inf_b = InferenceStep(1, "claim2", [], [3], 0.25, InferenceKind.other("custom"))
    _round_trip(inf_a, InferenceStep)
    _round_trip(inf_b, InferenceStep)
    _round_trip(
        ReasonResponseFrame([inf_a, inf_b], True, ReasonStatus.COMPLETE), ReasonResponseFrame
    )


# ---------------------------------------------------------------------------
# Mock server driving the unary + streamed verbs over one connection.
# ---------------------------------------------------------------------------


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes, *, eos: bool = True) -> None:
    write_frame(
        sock,
        Frame(opcode=int(opcode), flags=FLAG_EOS if eos else 0, stream_id=stream_id, payload=payload),
    )


def _handshake(sock: socket.socket, buf: bytearray) -> AuthPayload:
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        session_id=b"\xAB" * 16,
        capabilities=hello.capabilities,
        server_features=ServerFeatures(
            max_payload_size=1 << 20,
            max_concurrent_streams=64,
            idle_timeout_seconds=300,
            auth_methods=[],
        ),
    )
    _write(sock, Opcode.WELCOME, 0, encode_payload(welcome))
    auth_frame = read_frame(sock, buf)
    auth = decode_payload(AuthPayload, auth_frame.payload)
    auth_ok = AuthOkPayload(
        agent_id=auth.agent_id,
        bound_shard_id=0,
        permissions=AgentPermissions(True, True, True, True, True, True),
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))
    return auth


def _serve_read_side(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    # GET_CAPABILITIES (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.GET_CAPABILITIES_REQ
    _write(
        sock,
        Opcode.GET_CAPABILITIES_RESP,
        f.stream_id,
        encode_payload(GetCapabilitiesResponse(Capabilities(True, False, True, True, ["people"], 384))),
    )

    # LINK (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.LINK_REQ
    req = decode_payload(LinkRequest, f.payload)
    _write(
        sock,
        Opcode.LINK_RESP,
        f.stream_id,
        encode_payload(LinkResponse(req.source, req.target, req.kind, req.weight, 7, False)),
    )

    # UNLINK (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.UNLINK_REQ
    req = decode_payload(UnlinkRequest, f.payload)
    _write(
        sock,
        Opcode.UNLINK_RESP,
        f.stream_id,
        encode_payload(UnlinkResponse(req.source, req.target, req.kind, True)),
    )

    # ENTITY_GET (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.ENTITY_GET_REQ
    _write(sock, Opcode.ENTITY_GET_RESP, f.stream_id, encode_payload(EntityGetResponse(_entity_view())))

    # ENTITY_RESOLVE (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.ENTITY_RESOLVE_REQ
    _write(
        sock,
        Opcode.ENTITY_RESOLVE_RESP,
        f.stream_id,
        encode_payload(
            EntityResolveResponse(
                ResolutionOutcome.RESOLVED, 1, 1.0, ENTITY_ID, [], b"\x00" * 16
            )
        ),
    )

    # STATEMENT_GET (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.STATEMENT_GET_REQ
    _write(
        sock,
        Opcode.STATEMENT_GET_RESP,
        f.stream_id,
        encode_payload(StatementGetResponse(_statement_view(), False)),
    )

    # SCHEMA_GET (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_GET_REQ
    _write(
        sock,
        Opcode.SCHEMA_GET_RESP,
        f.stream_id,
        encode_payload(SchemaGetResponse("people", 2, "entity Person {}", [], 10, 1)),
    )

    # SCHEMA_VALIDATE (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_VALIDATE_REQ
    _write(
        sock,
        Opcode.SCHEMA_VALIDATE_RESP,
        f.stream_id,
        encode_payload(SchemaValidateResponse("people", 3, [])),
    )

    # TXN_BEGIN / TXN_COMMIT / TXN_ABORT (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.TXN_BEGIN
    req = decode_payload(TxnBeginRequest, f.payload)
    _write(sock, Opcode.TXN_BEGIN_RESP, f.stream_id, encode_payload(TxnBeginResponse(req.txn_id, req.timeout_seconds, 50)))

    f = read_frame(sock, buf)
    assert f.opcode == Opcode.TXN_COMMIT
    req = decode_payload(TxnCommitRequest, f.payload)
    _write(sock, Opcode.TXN_COMMIT_RESP, f.stream_id, encode_payload(TxnCommitResponse(req.txn_id, 60, 2)))

    f = read_frame(sock, buf)
    assert f.opcode == Opcode.TXN_ABORT
    req = decode_payload(TxnAbortRequest, f.payload)
    _write(sock, Opcode.TXN_ABORT_RESP, f.stream_id, encode_payload(TxnAbortResponse(req.txn_id, 1)))

    # ENTITY_LIST (streamed: two frames).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.ENTITY_LIST_REQ
    _write(
        sock,
        Opcode.ENTITY_LIST_RESP,
        f.stream_id,
        encode_payload(EntityListResponseFrame([EntityListItem(_entity_view())], [9], 1, False)),
        eos=False,
    )
    _write(
        sock,
        Opcode.ENTITY_LIST_RESP,
        f.stream_id,
        encode_payload(EntityListResponseFrame([EntityListItem(_entity_view())], [], 2, True)),
    )

    # STATEMENT_LIST (streamed: single frame).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.STATEMENT_LIST_REQ
    _write(
        sock,
        Opcode.STATEMENT_LIST_RESP,
        f.stream_id,
        encode_payload(StatementListResponseFrame([_statement_view()], [], 1, True)),
    )

    # RELATION_LIST_FROM (streamed).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_LIST_FROM_REQ
    _write(
        sock,
        Opcode.RELATION_LIST_FROM_RESP,
        f.stream_id,
        encode_payload(RelationListFromResponseFrame([_relation_view()], [], 1, True)),
    )

    # RELATION_LIST_TO (streamed).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_LIST_TO_REQ
    _write(
        sock,
        Opcode.RELATION_LIST_TO_RESP,
        f.stream_id,
        encode_payload(RelationListToResponseFrame([_relation_view()], [], 1, True)),
    )

    # SCHEMA_LIST (streamed).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_LIST_REQ
    _write(
        sock,
        Opcode.SCHEMA_LIST_RESP,
        f.stream_id,
        encode_payload(SchemaListResponseFrame("people", [SchemaListItem(2, 10, 1, True)], 1, [], True)),
    )

    # PLAN (streamed: two frames flatten to three steps).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.PLAN_REQ
    _write(
        sock,
        Opcode.PLAN_RESP,
        f.stream_id,
        encode_payload(
            PlanResponseFrame(
                [PlanStep(0, 1, "s0", TransitionKind("Initial"), 1.0, 0.5)], False, None
            )
        ),
        eos=False,
    )
    _write(
        sock,
        Opcode.PLAN_RESP,
        f.stream_id,
        encode_payload(
            PlanResponseFrame(
                [
                    PlanStep(1, 2, "s1", TransitionKind("Causal"), 0.5, 0.25),
                    PlanStep(2, 3, "s2", TransitionKind.other("x"), 0.5, 0.0),
                ],
                True,
                PlanStatus.GOAL_REACHED,
            )
        ),
    )

    # REASON (streamed).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.REASON_REQ
    _write(
        sock,
        Opcode.REASON_RESP,
        f.stream_id,
        encode_payload(
            ReasonResponseFrame(
                [InferenceStep(0, "c", [1], [], 0.5, InferenceKind("EvidenceAccumulation"))],
                True,
                ReasonStatus.COMPLETE,
            )
        ),
    )

    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def _spawn(handler) -> tuple[str, int, threading.Thread, socket.socket]:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    host, port = listener.getsockname()

    def run() -> None:
        conn, _peer = listener.accept()
        with conn:
            handler(conn)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return host, port, thread, listener


def test_read_edge_cognitive_txn_verbs() -> None:
    host, port, thread, listener = _spawn(_serve_read_side)
    try:
        client = BrainClient.connect(host, port)

        caps = client.capabilities()
        assert caps.capabilities.vector_dim == 384
        assert caps.capabilities.schema_namespaces == ["people"]

        link = client.link(LinkRequest(1, 2, 3, 0.5, _rid(), None))
        assert link.created_at_unix_nanos == 7 and not link.already_existed

        unlink = client.unlink(UnlinkRequest(1, 2, 3, _rid(), None))
        assert unlink.removed

        entity = client.get_entity(EntityGetRequest(ENTITY_ID))
        assert entity.entity.canonical_name == "Ada Lovelace"

        resolved = client.resolve_entity(
            EntityResolveRequest("Ada Lovelace", "", 1, False, _rid())
        )
        assert resolved.outcome == ResolutionOutcome.RESOLVED
        assert resolved.resolved_entity == ENTITY_ID

        statement = client.get_statement(StatementGetRequest(STATEMENT_ID, True))
        assert statement.statement.predicate == "born_in"
        assert not statement.returned_via_supersession

        schema = client.get_schema(SchemaGetRequest("people", 0))
        assert schema.schema_version == 2

        valid = client.validate_schema(SchemaValidateRequest("entity Person {}"))
        assert valid.would_be_version == 3

        begun = client.txn_begin(TxnBeginRequest(TXN_ID, 30))
        assert begun.started_at_unix_nanos == 50
        committed = client.txn_commit(TxnCommitRequest(TXN_ID))
        assert committed.operations_applied == 2
        aborted = client.txn_abort(TxnAbortRequest(TXN_ID))
        assert aborted.operations_discarded == 1

        entities = client.list_entities(EntityListRequest(0, "", 0, False, False, 100, []))
        assert len(entities) == 2  # two streamed frames flattened

        statements = client.list_statements(
            StatementListRequest(ENTITY_ID, "", 0, 0.0, 0, 0, False, False, 50, [])
        )
        assert len(statements) == 1 and statements[0].statement_id == STATEMENT_ID

        rel_from = client.list_relations_from(
            RelationListFromRequest(ENTITY_ID, "", 0, 0, False, False, 50, [])
        )
        assert len(rel_from) == 1 and rel_from[0].relation_id == RELATION_ID

        rel_to = client.list_relations_to(
            RelationListToRequest(ENTITY_ID, "", 0, 0, False, False, 50, [])
        )
        assert len(rel_to) == 1

        schemas = client.list_schemas(SchemaListRequest("people", 0, []))
        assert len(schemas) == 1 and schemas[0].schema_version == 2

        steps = client.plan(
            PlanRequest(
                PlanState.by_text("start"),
                PlanState.by_text("goal"),
                PlanBudget(10, 100, 5),
                None,
                None,
                _rid(),
                None,
            )
        )
        assert [s.step_index for s in steps] == [0, 1, 2]  # frames flattened

        inferences = client.reason(
            ReasonRequest(
                ObservationInput.by_text("why?"), 3, 0.0, None, 10, 1000, _rid(), None
            )
        )
        assert len(inferences) == 1 and inferences[0].claim == "c"

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()
