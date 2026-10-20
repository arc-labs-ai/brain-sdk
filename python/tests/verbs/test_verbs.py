"""Verb round-trip tests: RECALL streaming and FORGET against an in-process
mock server, plus the ergonomic builders' defaults.

RECALL is the streaming case: the mock server replies with two ``RECALL_RESP``
frames on the request's stream, the first without EOS and the second with it,
and the client must collect both and flatten their results.
"""

from __future__ import annotations

import socket
import threading

from brain_db_sdk import Auth, BrainClient, ForgetBuilder, RecallBuilder
from brain_db_sdk.transport import read_frame, write_frame
from brain_db_sdk.wire.frame import FLAG_EOS, Frame
from brain_db_sdk.wire.opcode import Opcode
from brain_db_sdk.wire.types import (
    AnswerKind,
    AuthOkPayload,
    AuthPayload,
    ForgetMode,
    ForgetRequest,
    ForgetResponse,
    HelloPayload,
    MemoryKind,
    MemoryResult,
    RecallRequest,
    RecallResponseFrame,
    ServerFeatures,
    SpacePermissions,
    WelcomePayload,
    decode_payload,
    encode_payload,
)


def _write(
    sock: socket.socket, opcode: Opcode, stream_id: int, payload: bytes, eos: bool = True
) -> None:
    flags = FLAG_EOS if eos else 0
    write_frame(sock, Frame(opcode=int(opcode), flags=flags, stream_id=stream_id, payload=payload))


# The server assigns the agent id from the credential; the client never sends one.
SERVER_AGENT_ID = b"\x22" * 16


def _sample_result(tag: int, text: str) -> MemoryResult:
    return MemoryResult(
        memory_id=tag,
        text=text,
        similarity_score=0.9,
        confidence=0.8,
        salience=0.5,
        kind=MemoryKind.SEMANTIC,
        space_id=bytes([tag]) * 16,
        session_id=0,
        created_at_unix_nanos=1,
        last_accessed_at_unix_nanos=1,
        edges=None,
        contributing_retrievers=[],
        fused_score=0.7,
        rerank_score=None,
        salience_initial=0.5,
        access_count=0,
        lsn=1,
        flags=0,
        consolidated_at_unix_nanos=None,
        occurred_at_unix_nanos=None,
        edges_out_count=0,
        edges_in_count=0,
        graph=None,
    )


def _serve_recall_forget(sock: socket.socket) -> None:
    buf = bytearray()

    # Handshake.
    hello_frame = read_frame(sock, buf)
    hello = decode_payload(HelloPayload, hello_frame.payload)
    welcome = WelcomePayload(
        server_id="mock-brain",
        chosen_version=1,
        connection_id=b"\xcd" * 16,
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
        permissions=SpacePermissions(
            can_encode=True,
            can_recall=True,
            can_plan=True,
            can_reason=True,
            can_forget=True,
            can_admin=False,
        ),
        namespace="",
        server_time_unix_nanos=1,
    )
    _write(sock, Opcode.AUTH_OK, 0, encode_payload(auth_ok))

    # RECALL: two streamed frames, EOS only on the second.
    recall_frame = read_frame(sock, buf)
    assert recall_frame.opcode == Opcode.RECALL_REQ
    recall = decode_payload(RecallRequest, recall_frame.payload)
    assert recall.cue_text == "dark mode"
    sid = recall_frame.stream_id

    first = RecallResponseFrame(
        answer_kind=AnswerKind.MANY,
        memories=[_sample_result(0xAA, "first hit")],
        is_final=False,
        cumulative_count=1,
        estimated_remaining=1,
    )
    _write(sock, Opcode.RECALL_RESP, sid, encode_payload(first), eos=False)

    second = RecallResponseFrame(
        answer_kind=AnswerKind.MANY,
        memories=[_sample_result(0xBB, "second hit")],
        is_final=True,
        cumulative_count=2,
        estimated_remaining=0,
    )
    _write(sock, Opcode.RECALL_RESP, sid, encode_payload(second), eos=True)

    # FORGET: single frame.
    forget_frame = read_frame(sock, buf)
    assert forget_frame.opcode == Opcode.FORGET_REQ
    forget = decode_payload(ForgetRequest, forget_frame.payload)
    resp = ForgetResponse(memory_id=forget.memory_id, was_already_forgotten=False, edges_removed=3)
    _write(sock, Opcode.FORGET_RESP, forget_frame.stream_id, encode_payload(resp))

    # BYE.
    bye = read_frame(sock, buf)
    assert bye.opcode == Opcode.BYE


def _spawn_server(handler) -> tuple[str, int, threading.Thread, socket.socket]:
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


def test_recall_streams_and_flattens_then_forget() -> None:
    host, port, thread, listener = _spawn_server(_serve_recall_forget)
    try:
        client = BrainClient.connect(host, port, Auth.token(b"opaque-token"))

        answer = client.recall(RecallBuilder("dark mode").limit(5).build())
        assert answer.answer_kind == AnswerKind.MANY
        assert len(answer.memories) == 2
        assert answer.memories[0].text == "first hit"
        assert answer.memories[1].text == "second hit"

        resp = client.forget(ForgetBuilder(0xAA).build())
        assert resp.memory_id == 0xAA
        assert resp.edges_removed == 3

        client.close()
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        listener.close()


def test_builder_defaults_are_sane() -> None:
    recall = RecallBuilder("hi").build()
    assert recall.max_results == 10
    assert recall.subject_name == ""
    assert recall.include_text
    assert recall.include_edges
    assert recall.request_id is not None

    forget = ForgetBuilder(7).build()
    assert forget.memory_id == 7
    assert forget.mode == ForgetMode.SOFT
    assert ForgetBuilder(7).hard().build().mode == ForgetMode.HARD
