"""Typed-graph verb round-trips against an in-process mock server:
ENTITY_CREATE, STATEMENT_CREATE, RELATION_CREATE, SCHEMA_UPLOAD, QUERY, and
MATERIALIZE_PROCEDURAL. Each is a single-shot request/response; the test drives
them in sequence over one connection and checks the decoded replies.
"""

from __future__ import annotations

import socket
import threading

from brain_db_sdk import Auth, BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AgentPermissions,
    AuthOkPayload,
    AuthPayload,
    EntityCreateRequest,
    EntityCreateResponse,
    EvidenceRef,
    HelloPayload,
    ItemId,
    MaterializeProceduralRequest,
    MaterializeProceduralResponse,
    QueryRequest,
    QueryResponse,
    QueryResultItem,
    RelationCreateRequest,
    RelationCreateResponse,
    RetrieverSelection,
    SchemaUploadRequest,
    SchemaUploadResponse,
    ServerFeatures,
    StatementCreateRequest,
    StatementCreateResponse,
    StatementKind,
    StatementObject,
    StatementValue,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

ENTITY_ID = b"\x11" * 16
STATEMENT_ID = b"\x22" * 16
RELATION_ID = b"\x33" * 16

# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes) -> None:
    write_frame(sock, Frame(opcode=int(opcode), flags=FLAG_EOS, stream_id=stream_id, payload=payload))


def _serve_graph(sock: socket.socket) -> None:
    buf = bytearray()

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
    decode_payload(AuthPayload, auth_frame.payload)
    auth_ok = AuthOkPayload(
        agent_id=SERVER_AGENT_ID,
        bound_shard_id=0,
        permissions=AgentPermissions(
            can_encode=True,
            can_recall=True,
            can_plan=True,
            can_reason=True,
            can_forget=True,
            can_admin=True,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # ENTITY_CREATE.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.ENTITY_CREATE_REQ
    req = decode_payload(EntityCreateRequest, f.payload)
    assert req.canonical_name == "Ada Lovelace"
    _write(sock, Opcode.ENTITY_CREATE_RESP, f.stream_id, encode_payload(EntityCreateResponse(ENTITY_ID)))

    # STATEMENT_CREATE.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.STATEMENT_CREATE_REQ
    req = decode_payload(StatementCreateRequest, f.payload)
    assert req.predicate == "born_in"
    _write(
        sock,
        Opcode.STATEMENT_CREATE_RESP,
        f.stream_id,
        encode_payload(StatementCreateResponse(STATEMENT_ID, b"\x00" * 16, STATEMENT_ID)),
    )

    # RELATION_CREATE.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_CREATE_REQ
    req = decode_payload(RelationCreateRequest, f.payload)
    assert req.relation_type == "collaborated_with"
    _write(sock, Opcode.RELATION_CREATE_RESP, f.stream_id, encode_payload(RelationCreateResponse(RELATION_ID)))

    # SCHEMA_UPLOAD.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.SCHEMA_UPLOAD_REQ
    req = decode_payload(SchemaUploadRequest, f.payload)
    assert req.dry_run
    _write(
        sock,
        Opcode.SCHEMA_UPLOAD_RESP,
        f.stream_id,
        encode_payload(SchemaUploadResponse("people", 2, [], True, [])),
    )

    # QUERY.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.QUERY_REQ
    req = decode_payload(QueryRequest, f.payload)
    assert req.text == "computing pioneers"
    _write(
        sock,
        Opcode.QUERY_RESP,
        f.stream_id,
        encode_payload(QueryResponse([QueryResultItem(ItemId(1, ENTITY_ID), 0.95, [])], 1.5, [])),
    )

    # MATERIALIZE_PROCEDURAL.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.MATERIALIZE_PROCEDURAL_REQ
    req = decode_payload(MaterializeProceduralRequest, f.payload)
    assert req.top_k == 3
    _write(
        sock,
        Opcode.MATERIALIZE_PROCEDURAL_RESP,
        f.stream_id,
        encode_payload(
            MaterializeProceduralResponse("## Procedures\n- be concise", [STATEMENT_ID], 1, False)
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


def _rid() -> bytes:
    import uuid

    return uuid.uuid4().bytes


def test_typed_graph_verbs_round_trip() -> None:
    host, port, thread, listener = _spawn(_serve_graph)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        entity = client.create_entity(
            EntityCreateRequest(
                entity_type_id=1,
                canonical_name="Ada Lovelace",
                aliases=["Ada"],
                attributes_blob=[],
                request_id=_rid(),
            )
        )
        assert entity.entity_id == ENTITY_ID

        statement = client.create_statement(
            StatementCreateRequest(
                kind=StatementKind.FACT,
                subject=entity.entity_id,
                predicate="born_in",
                object=StatementObject("Value", StatementValue("Integer", 1815)),
                confidence=0.99,
                evidence=EvidenceRef.inline([]),
                extractor_id=0,
                valid_from_unix_nanos=0,
                valid_to_unix_nanos=(1 << 64) - 1,
                event_at_unix_nanos=0,
                schema_version=1,
                request_id=_rid(),
            )
        )
        assert statement.statement_id == STATEMENT_ID
        assert statement.chain_root == STATEMENT_ID

        relation = client.create_relation(
            RelationCreateRequest(
                relation_type="collaborated_with",
                from_entity=entity.entity_id,
                to_entity=ENTITY_ID,
                properties_blob=[],
                evidence=EvidenceRef.inline([]),
                extractor_id=0,
                confidence=0.8,
                valid_from_unix_nanos=0,
                valid_to_unix_nanos=(1 << 64) - 1,
                request_id=_rid(),
            )
        )
        assert relation.relation_id == RELATION_ID

        schema = client.upload_schema(
            SchemaUploadRequest(
                schema_document="entity Person {}",
                dry_run=True,
                allow_breaking=False,
                request_id=_rid(),
            )
        )
        assert schema.namespace == "people"
        assert schema.backward_compatible

        results = client.query(
            QueryRequest(
                text="computing pioneers",
                entity_anchor=None,
                kind_filter=[],
                predicate_filter=[],
                time_filter=None,
                as_of_record_time_unix_nanos=None,
                confidence_min=None,
                include_tombstoned=False,
                include_superseded=False,
                limit=10,
                retrievers=RetrieverSelection.auto(),
                fusion_config=None,
                request_id=_rid(),
            )
        )
        assert len(results.items) == 1
        assert results.items[0].id.bytes == ENTITY_ID

        proc = client.materialize_procedural(
            MaterializeProceduralRequest(
                agent_id=client.agent_id,
                context_filter=0,
                top_k=3,
                min_confidence=0.5,
                categories=["style"],
                request_id=_rid(),
            )
        )
        assert proc.statement_ids == [STATEMENT_ID]
        assert not proc.trimmed_by_budget

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()
