"""MEMORY_LIST + opt-in ENCODE/RECALL trace coverage.

MEMORY_LIST has no golden bytes in the conformance corpus (like the other
read-side enumeration ops), so its wire shape is proven here by a self
round-trip (``encode_payload`` -> ``decode_payload`` -> equal) plus a
streaming mock-server flatten. The trace types *are* corpus-pinned
(req_encode_trace / resp_encode_trace / resp_recall_trace), so these tests
only cover the ergonomic builder wiring and a hand-built round-trip.
"""

from __future__ import annotations

import socket
import threading

from brain_db_sdk import Auth, BrainClient, EncodeBuilder, RecallBuilder
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AuthOkPayload,
    AuthPayload,
    EncodeTrace,
    EncodeTraceArtifacts,
    EncodeTraceDedup,
    EncodeTraceEntity,
    EncodeTraceIndex,
    EncodeTraceRelation,
    EncodeTraceStage,
    EncodeTraceStageStatus,
    EncodeTraceStatement,
    HelloPayload,
    MemoryListDir,
    MemoryListItem,
    MemoryListRequest,
    MemoryListResponseFrame,
    MemoryListSort,
    MemoryListTimeAxis,
    RecallResponseFrame,
    RecallTrace,
    RecallTraceFilterChain,
    RecallTraceRerank,
    RecallTraceRetriever,
    RecallTraceRetrieverStatus,
    ServerFeatures,
    SpacePermissions,
    WaitMode,
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _sample_request(cursor: bytes = b"") -> MemoryListRequest:
    return MemoryListRequest(
        sort=MemoryListSort.CREATED,
        dir=MemoryListDir.DESC,
        limit=50,
        cursor=cursor,
        kinds=[0, 1],
        include_tombstoned=False,
        time_axis=MemoryListTimeAxis.CREATED,
        from_unix_nanos=0,
        to_unix_nanos=0,
        salience_min=0.0,
        salience_max=1.0,
        text_contains="",
    )


def _sample_item(byte: int, text: str) -> MemoryListItem:
    return MemoryListItem(
        memory_id=bytes([byte]) * 16,
        space_id=bytes([byte ^ 0x55]) * 16,
        session_id=1,
        text=text,
        kind=0,
        state=0,
        created_at_unix_nanos=1700000000000000000,
        occurred_at_unix_nanos=0,
        last_accessed_at_unix_nanos=1700000000000000001,
        salience=0.5,
        access_count=3,
        source_request_id=bytes([byte ^ 0xFF]) * 16,
        statement_count=2,
        entity_count=1,
        relation_count=0,
    )


def test_memory_list_request_round_trips() -> None:
    req = _sample_request(cursor=b"\x01\x02\x03")
    assert decode_payload(MemoryListRequest, encode_payload(req)) == req


def test_memory_list_frame_round_trips() -> None:
    frame = MemoryListResponseFrame(
        items=[_sample_item(0xAA, "one"), _sample_item(0xBB, "two")],
        next_cursor=b"\x09\x08",
        cumulative_count=2,
        is_final=True,
    )
    assert decode_payload(MemoryListResponseFrame, encode_payload(frame)) == frame


def test_memory_list_cursor_is_a_cbor_array_not_a_byte_string() -> None:
    # Vec<u8> without serde_bytes on the server -> CBOR array of ints. A byte
    # string (major type 2) would drift from the Rust reference bytes.
    payload = encode_payload(_sample_request(cursor=b"\x01\x02"))
    # 0x40|0x60 would prefix a byte/text string; the cursor must decode as a
    # list, and re-encode identically.
    decoded = decode_payload(MemoryListRequest, payload)
    assert decoded.cursor == b"\x01\x02"


def _serve_memory_list(sock: socket.socket) -> None:
    buf = bytearray()
    hello = read_frame(sock, buf)
    assert hello.opcode == Opcode.HELLO
    h = decode_payload(HelloPayload, hello.payload)
    welcome = WelcomePayload(
        server_id="mock",
        chosen_version=h.supported_versions[0],
        connection_id=b"\x00" * 16,
        capabilities=h.capabilities,
        server_features=ServerFeatures(
            max_payload_size=1 << 20,
            max_concurrent_streams=256,
            idle_timeout_seconds=60,
            auth_methods=[0],
        ),
    )
    write_frame(
        sock,
        Frame(
            opcode=int(Opcode.WELCOME),
            flags=FLAG_EOS,
            stream_id=hello.stream_id,
            payload=encode_payload(welcome),
        ),
    )

    auth = read_frame(sock, buf)
    assert auth.opcode == Opcode.AUTH
    decode_payload(AuthPayload, auth.payload)
    auth_ok = AuthOkPayload(
        space_id=b"\x01" * 16,
        bound_shard_id=0,
        permissions=SpacePermissions(True, True, True, True, True, False, False),
        namespace="",
        server_time_unix_nanos=1700000000000000000,
    )
    write_frame(
        sock,
        Frame(
            opcode=int(Opcode.AUTH_OK),
            flags=FLAG_EOS,
            stream_id=auth.stream_id,
            payload=encode_payload(auth_ok),
        ),
    )

    # Serve MEMORY_LIST requests (two-frame page) until the client says BYE.
    while True:
        req = read_frame(sock, buf)
        if req.opcode == Opcode.BYE:
            break
        assert req.opcode == Opcode.MEMORY_LIST_REQ
        decode_payload(MemoryListRequest, req.payload)
        sid = req.stream_id
        first = MemoryListResponseFrame(
            items=[_sample_item(0xAA, "one")],
            next_cursor=b"\x01",
            cumulative_count=1,
            is_final=False,
        )
        write_frame(
            sock,
            Frame(
                opcode=int(Opcode.MEMORY_LIST_RESP),
                flags=0,
                stream_id=sid,
                payload=encode_payload(first),
            ),
        )
        second = MemoryListResponseFrame(
            items=[_sample_item(0xBB, "two")], next_cursor=b"", cumulative_count=2, is_final=True
        )
        write_frame(
            sock,
            Frame(
                opcode=int(Opcode.MEMORY_LIST_RESP),
                flags=FLAG_EOS,
                stream_id=sid,
                payload=encode_payload(second),
            ),
        )


def test_memory_list_streams_and_flattens() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    host, port = listener.getsockname()

    def run() -> None:
        conn, _peer = listener.accept()
        with conn:
            _serve_memory_list(conn)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        client = BrainClient.connect(host, port, Auth.token(b"tok"))
        items = client.memory_list(_sample_request())
        assert [i.text for i in items] == ["one", "two"]
        frames = client.memory_list_frames(_sample_request())
        assert frames[-1].is_final
        assert frames[-1].next_cursor == b""
        client.close()
        thread.join(timeout=5)
    finally:
        listener.close()


def test_encode_builder_wait_mode() -> None:
    assert EncodeBuilder("x").build().wait == WaitMode.ACK
    assert EncodeBuilder("x").wait(WaitMode.DERIVED).build().wait == WaitMode.DERIVED
    assert EncodeBuilder("x").derived().build().wait == WaitMode.DERIVED
    assert EncodeBuilder("x").wait(WaitMode.ACK).build().wait == WaitMode.ACK


def test_recall_builder_trace_flag() -> None:
    assert RecallBuilder("x").build().trace is False
    assert RecallBuilder("x").trace().build().trace is True


def test_encode_trace_round_trips_via_response() -> None:
    from brain_db_sdk.wire.types import EncodeResponse

    trace = EncodeTrace(
        stages=[
            EncodeTraceStage("validate", EncodeTraceStageStatus.OK, 3, ""),
            EncodeTraceStage("auto_edge", EncodeTraceStageStatus.TIMEOUT, 0, "did not complete"),
        ],
        artifacts=EncodeTraceArtifacts(
            entities=[EncodeTraceEntity(b"\x44" * 16, "brain", "org:project")],
            statements=[EncodeTraceStatement(b"\x01" * 16, "niraj", "org:works_on", "brain", 0.9)],
            relations=[EncodeTraceRelation("niraj", "org:member_of", "arc-labs")],
            indexes=[EncodeTraceIndex("memory_hnsw", EncodeTraceStageStatus.OK)],
            dedup=EncodeTraceDedup(False, None),
        ),
        total_latency_us=44010,
    )
    resp = EncodeResponse(
        memory_id=1,
        was_deduplicated=False,
        salience=0.5,
        auto_edges_added=1,
        lsn=42,
        space_id=b"\x22" * 16,
        session_id=1,
        kind=0,
        created_at_unix_nanos=1700000000000000000,
        edges_out_count=1,
        embedding_model_fp=b"\x33" * 16,
        pending_stages=[0],
        has_active_schema=True,
        trace=trace,
    )
    # Byte-level round trip (f32 confidence 0.9 isn't bit-exact through a
    # single-precision round, so compare the stable wire bytes, not the value).
    wire = encode_payload(resp)
    assert encode_payload(decode_payload(EncodeResponse, wire)) == wire
    decoded = decode_payload(EncodeResponse, wire)
    assert decoded.trace is not None
    assert decoded.trace.artifacts.dedup.matched_memory_id is None
    assert decoded.trace.stages[1].status == EncodeTraceStageStatus.TIMEOUT
    # Without a trace the field is absent from the wire and decodes to None.
    resp.trace = None
    assert decode_payload(EncodeResponse, encode_payload(resp)).trace is None


def test_recall_trace_round_trips_via_frame() -> None:
    trace = RecallTrace(
        retrievers=[
            RecallTraceRetriever(0, RecallTraceRetrieverStatus.SUCCESS, "", 1.5, 12),
            RecallTraceRetriever(2, RecallTraceRetrieverStatus.SKIPPED, "no anchor", 0.0, 0),
        ],
        filter_chain=RecallTraceFilterChain(12, 12, 10, 8, 8, 7, 7, 5),
        rerank=RecallTraceRerank(True, 5, 2.25),
        total_latency_ms=4.75,
    )
    frame = RecallResponseFrame(
        answer_kind="None",
        memories=[],
        is_final=True,
        cumulative_count=0,
        estimated_remaining=0,
        trace=trace,
    )
    wire = encode_payload(frame)
    assert encode_payload(decode_payload(RecallResponseFrame, wire)) == wire
    decoded = decode_payload(RecallResponseFrame, wire)
    assert decoded.trace is not None
    assert decoded.trace.filter_chain.after_limit == 5
    assert len(decoded.trace.retrievers) == 2
    # rerank is Optional and encodes as null when absent.
    frame.trace.rerank = None
    assert decode_payload(RecallResponseFrame, encode_payload(frame)).trace.rerank is None
