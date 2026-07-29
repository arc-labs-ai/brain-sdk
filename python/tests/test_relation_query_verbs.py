"""Relation-lifecycle + query-introspection verbs added to reach parity with
the Rust SDK: ENCODE_VECTOR_DIRECT, RELATION_GET / RELATION_SUPERSEDE /
RELATION_TOMBSTONE / RELATION_TRAVERSE, and QUERY_EXPLAIN / QUERY_TRACE.

Two layers of coverage:

  * ``test_relation_query_types_round_trip`` — encode -> decode equality for
    every new wire type (these ops have no conformance corpus, so the guarantee
    is that the Python structs mirror the Rust structs field-for-field).
  * ``test_relation_query_verbs`` — drive the new unary + streamed verbs against
    an in-process mock server over one connection and check the decoded replies.
"""

from __future__ import annotations

import cbor2
import socket
import threading
import uuid

from brain_db_sdk import Auth, BrainClient
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.cbor import from_cbor, to_cbor
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    SpacePermissions,
    AuthOkPayload,
    AuthPayload,
    EncodeResponse,
    EncodeVectorDirectRequest,
    EvidenceRef,
    HelloPayload,
    MemoryKind,
    QueryExplainRequest,
    QueryExplainResponse,
    QueryRequest,
    QueryTraceRequest,
    QueryTraceResponse,
    RelationCreateRequest,
    RelationGetRequest,
    RelationGetResponse,
    RelationSupersedeRequest,
    RelationSupersedeResponse,
    RelationTombstoneRequest,
    RelationTombstoneResponse,
    RelationTraverseRequest,
    RelationTraverseResponseFrame,
    RelationView,
    Retriever,
    RetrieverSelection,
    ServerFeatures,
    TraversalPathWire,
    TraversalStepWire,
    WelcomePayload,
    decode_payload,
    encode_payload,
)

ENTITY_ID = b"\x11" * 16
RELATION_ID = b"\x33" * 16
NEW_RELATION_ID = b"\x55" * 16

# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _rid() -> bytes:
    return uuid.uuid4().bytes


def _relation_view() -> RelationView:
    return RelationView(
        relation_id=RELATION_ID,
        chain_root=RELATION_ID,
        relation_type="collaborated_with",
        from_entity=ENTITY_ID,
        to_entity=b"\x66" * 16,
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


def _relation_create() -> RelationCreateRequest:
    return RelationCreateRequest(
        relation_type="collaborated_with",
        from_entity=ENTITY_ID,
        to_entity=b"\x66" * 16,
        properties_blob=[],
        evidence=EvidenceRef.inline([]),
        extractor_id=0,
        confidence=0.5,
        valid_from_unix_nanos=0,
        valid_to_unix_nanos=(1 << 64) - 1,
        session_id=0,
        request_id=_rid(),
    )


def _query_request() -> QueryRequest:
    return QueryRequest(
        text="computing pioneers",
        entity_anchor=None,
        kind_filter=[],
        predicate_filter=[],
        # Non-None on purpose: session_filter was missing from QueryRequest in
        # all three SDKs, and the server defaults a missing Option to None
        # rather than erroring — so the only thing that keeps this fixed is a
        # fixture that carries it and a server-side assertion that it arrived.
        session_filter=[7, 9],
        time_filter=None,
        as_of_record_time_unix_nanos=None,
        confidence_min=None,
        include_tombstoned=False,
        include_superseded=False,
        limit=10,
        # Explicit, not Auto: `Auto` is a bare string either way, so it exercises
        # nothing. The Explicit arm is where RetrieverWire's encoding shows, and
        # it was sending integers where the server expects variant-name strings.
        retrievers=RetrieverSelection.explicit([Retriever.SEMANTIC, Retriever.GRAPH]),
        fusion_config=None,
        request_id=_rid(),
    )


def _traversal_path() -> TraversalPathWire:
    return TraversalPathWire(
        steps=[
            TraversalStepWire(
                relation_id=RELATION_ID,
                from_=ENTITY_ID,
                to=b"\x66" * 16,
                relation_type="collaborated_with",
                depth=1,
            )
        ]
    )


def _round_trip(value, cls) -> None:
    back = cls.from_map(from_cbor(to_cbor(value.to_map())))
    assert back == value, f"{cls.__name__} round-trip mismatch: {back} != {value}"


def test_relation_query_types_round_trip() -> None:
    # ENCODE_VECTOR_DIRECT rides a trailing raw f32 section, so it goes through
    # the encode/decode_payload seam rather than plain to_map/from_map.
    evd = EncodeVectorDirectRequest(
        text="hello",
        model_fingerprint=b"\xAB" * 16,
        session_id=0,
        kind=MemoryKind.SEMANTIC,
        salience_hint=0.5,
        edges=[],
        request_id=_rid(),
        txn_id=None,
        deduplicate=True,
        vector=[0.25, -0.5, 1.0],
    )
    assert decode_payload(EncodeVectorDirectRequest, encode_payload(evd)) == evd

    # Relation lifecycle.
    _round_trip(RelationGetRequest(RELATION_ID, True), RelationGetRequest)
    _round_trip(RelationGetResponse(_relation_view(), True), RelationGetResponse)
    _round_trip(
        RelationSupersedeRequest(RELATION_ID, _relation_create(), _rid()),
        RelationSupersedeRequest,
    )
    _round_trip(RelationSupersedeResponse(NEW_RELATION_ID, 2), RelationSupersedeResponse)
    _round_trip(
        RelationTombstoneRequest(RELATION_ID, "merged duplicate", _rid()),
        RelationTombstoneRequest,
    )
    _round_trip(RelationTombstoneResponse(999), RelationTombstoneResponse)

    # Relation traversal (streamed).
    _round_trip(
        RelationTraverseRequest(ENTITY_ID, ["collaborated_with"], 2, 3, 100, 0, False, _rid()),
        RelationTraverseRequest,
    )
    _round_trip(_traversal_path().steps[0], TraversalStepWire)
    _round_trip(_traversal_path(), TraversalPathWire)
    _round_trip(
        RelationTraverseResponseFrame([_traversal_path()], 1, False, True),
        RelationTraverseResponseFrame,
    )

    # Query introspection.
    _round_trip(QueryExplainRequest(_query_request()), QueryExplainRequest)
    _round_trip(QueryExplainResponse("SCAN semantic", 1.5), QueryExplainResponse)
    _round_trip(QueryTraceRequest(_query_request()), QueryTraceRequest)
    _round_trip(QueryTraceResponse("stage: semantic 0.4ms", 2.5), QueryTraceResponse)


# ---------------------------------------------------------------------------
# Mock server driving the new unary + streamed verbs over one connection.
# ---------------------------------------------------------------------------


def _write(sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes, *, eos: bool = True) -> None:
    write_frame(
        sock,
        Frame(opcode=int(opcode), flags=FLAG_EOS if eos else 0, stream_id=stream_id, payload=payload),
    )


def _handshake(sock: socket.socket, buf: bytearray) -> None:
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        connection_id=b"\xAB" * 16,
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
        space_id=SERVER_AGENT_ID,
        bound_shard_id=0,
        permissions=SpacePermissions(True, True, True, True, True, True),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))


def _serve(sock: socket.socket) -> None:
    buf = bytearray()
    _handshake(sock, buf)

    # ENCODE_VECTOR_DIRECT (unary): decode the request, incl. the f32 trailer.
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.ENCODE_VECTOR_DIRECT_REQ
    req = decode_payload(EncodeVectorDirectRequest, f.payload)
    assert req.vector == [0.25, -0.5, 1.0]
    _write(
        sock,
        Opcode.ENCODE_VECTOR_DIRECT_RESP,
        f.stream_id,
        encode_payload(
            EncodeResponse(
                memory_id=7,
                was_deduplicated=False,
                salience=0.5,
                auto_edges_added=0,
                lsn=1,
                space_id=SERVER_AGENT_ID,
                session_id=0,
                kind=MemoryKind.SEMANTIC,
                created_at_unix_nanos=1,
                edges_out_count=0,
                embedding_model_fp=b"\xAB" * 16,
                pending_stages=[],
                has_active_schema=True,
            )
        ),
    )

    # RELATION_GET (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_GET_REQ
    _write(
        sock,
        Opcode.RELATION_GET_RESP,
        f.stream_id,
        encode_payload(RelationGetResponse(_relation_view(), False)),
    )

    # RELATION_SUPERSEDE (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_SUPERSEDE_REQ
    _write(
        sock,
        Opcode.RELATION_SUPERSEDE_RESP,
        f.stream_id,
        encode_payload(RelationSupersedeResponse(NEW_RELATION_ID, 2)),
    )

    # RELATION_TOMBSTONE (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_TOMBSTONE_REQ
    _write(
        sock,
        Opcode.RELATION_TOMBSTONE_RESP,
        f.stream_id,
        encode_payload(RelationTombstoneResponse(999)),
    )

    # RELATION_TRAVERSE (streamed: two frames flatten to two paths).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.RELATION_TRAVERSE_REQ
    _write(
        sock,
        Opcode.RELATION_TRAVERSE_RESP,
        f.stream_id,
        encode_payload(RelationTraverseResponseFrame([_traversal_path()], 2, False, False)),
        eos=False,
    )
    _write(
        sock,
        Opcode.RELATION_TRAVERSE_RESP,
        f.stream_id,
        encode_payload(RelationTraverseResponseFrame([_traversal_path()], 2, False, True)),
    )

    # QUERY_EXPLAIN (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.QUERY_EXPLAIN_REQ
    explain_req = decode_payload(QueryExplainRequest, f.payload)
    assert explain_req.query.session_filter == [7, 9], (
        "session_filter must survive the round trip"
    )
    # Read the RAW CBOR, not the SDK's decode: a decoder and encoder that are
    # wrong the same way agree with each other. The server's RetrieverWire is a
    # plain serde enum, so the wire carries variant-name strings.
    raw = cbor2.loads(f.payload)
    assert raw["query"]["retrievers"] == {"Explicit": ["Semantic", "Graph"]}, (
        "RetrieverWire encodes as the variant-name string; #[repr(u8)] is a "
        f"memory-layout hint, not a wire encoding. Got {raw['query']['retrievers']!r}"
    )
    _write(
        sock,
        Opcode.QUERY_EXPLAIN_RESP,
        f.stream_id,
        encode_payload(QueryExplainResponse("SCAN semantic", 1.5)),
    )

    # QUERY_TRACE (unary).
    f = read_frame(sock, buf)
    assert f.opcode == Opcode.QUERY_TRACE_REQ
    _write(
        sock,
        Opcode.QUERY_TRACE_RESP,
        f.stream_id,
        encode_payload(QueryTraceResponse("stage: semantic 0.4ms", 2.5)),
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


def test_relation_query_verbs() -> None:
    host, port, thread, listener = _spawn(_serve)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        encoded = client.encode_vector_direct(
            EncodeVectorDirectRequest(
                text="hello",
                model_fingerprint=b"\xAB" * 16,
                session_id=0,
                kind=MemoryKind.SEMANTIC,
                salience_hint=0.5,
                edges=[],
                request_id=_rid(),
                txn_id=None,
                deduplicate=True,
                vector=[0.25, -0.5, 1.0],
            )
        )
        assert encoded.memory_id == 7

        got = client.get_relation(RelationGetRequest(RELATION_ID, True))
        assert got.relation.relation_id == RELATION_ID
        assert not got.returned_via_supersession

        superseded = client.supersede_relation(
            RelationSupersedeRequest(RELATION_ID, _relation_create(), _rid())
        )
        assert superseded.new_relation_id == NEW_RELATION_ID
        assert superseded.version == 2

        tombstoned = client.tombstone_relation(
            RelationTombstoneRequest(RELATION_ID, "merged duplicate", _rid())
        )
        assert tombstoned.tombstoned_at_unix_nanos == 999

        paths = client.traverse_relations(
            RelationTraverseRequest(ENTITY_ID, ["collaborated_with"], 2, 3, 100, 0, False, _rid())
        )
        assert len(paths) == 2  # two streamed frames flattened
        assert paths[0].steps[0].from_ == ENTITY_ID

        explained = client.query_explain(QueryExplainRequest(_query_request()))
        assert explained.plan_text == "SCAN semantic"

        traced = client.query_trace(QueryTraceRequest(_query_request()))
        assert traced.total_latency_ms == 2.5

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()
