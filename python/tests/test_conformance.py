"""Corpus drift-guard: every vendored ``.bin`` must

  (a) decode to a value whose structural projection matches its ``.json``
      mirror, and
  (b) re-encode to the exact same bytes.

The re-encode == bytes check (b) is the load-bearing proof that this
SDK's codec puts the same bytes on the wire as the server and the Rust
reference SDK.

Two case shapes (per ``index.json`` ``kind``):
  * ``frame`` cases mirror a full ``Frame`` (header + payload); the
    ``.json`` carries ``opcode_hex / flags / stream_id / payload_len /
    payload_hex``.
  * every other case is a payload-only ``.bin``; the ``.json`` is the
    serde mirror of the decoded payload struct.

The ``.json`` mirror represents 16-byte ids as JSON arrays of ints and
``u128`` ids as big integers, and it omits the ``vector`` field (the
server skips it from CBOR). The structural comparison normalizes this
SDK's value the same way and compares floats with a tolerance, since an
``f32`` round-trip is not bit-identical to the JSON decimal. Byte-exact
re-encoding is the precise check.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from brain_db_sdk.wire import types as t
from brain_db_sdk.wire.cbor import _FloatField
from brain_db_sdk.wire.frame import decode_frame, encode_frame
from brain_db_sdk.wire.types import decode_payload, encode_payload

CORPUS = Path(__file__).resolve().parents[2] / "conformance" / "corpus"

# Map each payload-only corpus case name to its payload type.
PAYLOAD_TYPES = {
    # Handshake.
    "req_hello": t.HelloPayload,
    "req_auth": t.AuthPayload,
    "resp_welcome": t.WelcomePayload,
    "resp_auth_ok": t.AuthOkPayload,
    # v1 verbs.
    "req_encode": t.EncodeRequest,
    "req_encode_trace": t.EncodeRequest,
    "req_encode_allow_duplicates": t.EncodeRequest,
    "req_recall": t.RecallRequest,
    "req_forget": t.ForgetRequest,
    "resp_encode": t.EncodeResponse,
    "resp_encode_trace": t.EncodeResponse,
    "resp_recall": t.RecallResponseFrame,
    "resp_recall_trace": t.RecallResponseFrame,
    "req_memory_list": t.MemoryListRequest,
    "resp_memory_list": t.MemoryListResponseFrame,
    "req_memory_inspect": t.MemoryInspectRequest,
    "resp_memory_inspect": t.MemoryInspectResponse,
    "req_graph_fetch": t.GraphFetchRequest,
    "resp_graph_fetch": t.GraphFetchResponseFrame,
    "resp_forget": t.ForgetResponse,
    # Per-request effective identity (act_as) variants.
    "req_encode_act_as": t.EncodeRequest,
    "req_recall_act_as": t.RecallRequest,
    "req_forget_act_as": t.ForgetRequest,
    "req_plan_act_as": t.PlanRequest,
    "req_reason_act_as": t.ReasonRequest,
    "req_entity_create_act_as": t.EntityCreateRequest,
    "resp_auth_ok_act_as": t.AuthOkPayload,
    "resp_error_act_as_denied": t.ErrorResponse,
    # Typed-graph ops.
    "req_entity_create": t.EntityCreateRequest,
    "resp_entity_create": t.EntityCreateResponse,
    "req_statement_create": t.StatementCreateRequest,
    "resp_statement_create": t.StatementCreateResponse,
    "req_relation_create": t.RelationCreateRequest,
    "resp_relation_create": t.RelationCreateResponse,
    "req_schema_upload": t.SchemaUploadRequest,
    "resp_schema_upload": t.SchemaUploadResponse,
    "req_materialize_procedural": t.MaterializeProceduralRequest,
    "req_entity_get": t.EntityGetRequest,
    "req_entity_update": t.EntityUpdateRequest,
    "req_entity_rename": t.EntityRenameRequest,
    "req_entity_merge": t.EntityMergeRequest,
    "req_entity_unmerge": t.EntityUnmergeRequest,
    "req_entity_resolve": t.EntityResolveRequest,
    "req_entity_list": t.EntityListRequest,
    "req_entity_tombstone": t.EntityTombstoneRequest,
    "resp_entity_update": t.EntityUpdateResponse,
    "resp_entity_rename": t.EntityRenameResponse,
    "resp_entity_merge": t.EntityMergeResponse,
    "resp_entity_unmerge": t.EntityUnmergeResponse,
    "resp_entity_tombstone": t.EntityTombstoneResponse,
    "resp_entity_get_merged": t.EntityGetResponse,
    "req_relation_get": t.RelationGetRequest,
    "req_relation_supersede": t.RelationSupersedeRequest,
    "req_relation_tombstone": t.RelationTombstoneRequest,
    "req_relation_list_from": t.RelationListFromRequest,
    "req_relation_list_to": t.RelationListToRequest,
    "req_relation_traverse": t.RelationTraverseRequest,
    "resp_relation_get": t.RelationGetResponse,
    "resp_relation_supersede": t.RelationSupersedeResponse,
    "resp_relation_tombstone": t.RelationTombstoneResponse,
    "resp_relation_list_to": t.RelationListToResponseFrame,
    "resp_relation_traverse": t.RelationTraverseResponseFrame,
    "req_statement_get": t.StatementGetRequest,
    "req_statement_supersede": t.StatementSupersedeRequest,
    "req_statement_tombstone": t.StatementTombstoneRequest,
    "req_statement_retract": t.StatementRetractRequest,
    "req_statement_history": t.StatementHistoryRequest,
    "req_statement_list": t.StatementListRequest,
    "resp_statement_supersede": t.StatementSupersedeResponse,
    "resp_statement_tombstone": t.StatementTombstoneResponse,
    "resp_statement_retract": t.StatementRetractResponse,
    "resp_statement_history": t.StatementHistoryResponseFrame,
    "req_schema_get": t.SchemaGetRequest,
    "req_schema_list": t.SchemaListRequest,
    "req_schema_validate": t.SchemaValidateRequest,
    "req_schema_replace": t.SchemaReplaceRequest,
    "resp_schema_get": t.SchemaGetResponse,
    "resp_schema_list": t.SchemaListResponseFrame,
    "resp_schema_validate": t.SchemaValidateResponse,
    "resp_schema_replace": t.SchemaReplaceResponse,
    "req_txn_begin": t.TxnBeginRequest,
    "req_txn_commit": t.TxnCommitRequest,
    "req_txn_abort": t.TxnAbortRequest,
    "req_subscribe": t.SubscribeRequest,
    "req_unsubscribe": t.UnsubscribeRequest,
    "resp_unsubscribe": t.UnsubscribeResponse,
    "req_ping": t.PingRequest,
    "req_client_pong": t.ClientPongRequest,
    "req_bye": t.ByeRequest,
    "req_cancel_stream": t.CancelStreamRequest,
    "req_get_capabilities": t.GetCapabilitiesRequest,
    "req_link": t.LinkRequest,
    "req_unlink": t.UnlinkRequest,
    "resp_unlink": t.UnlinkResponse,
    "resp_encode_vector_direct": t.EncodeResponse,
    "resp_cancel_stream_ack": t.CancelStreamAck,
    "req_query_explain": t.QueryExplainRequest,
    "req_query_trace": t.QueryTraceRequest,
    "resp_query_explain": t.QueryExplainResponse,
    "resp_query_trace": t.QueryTraceResponse,
    "resp_materialize_procedural": t.MaterializeProceduralResponse,
    # Read-side typed-graph responses.
    "resp_entity_get": t.EntityGetResponse,
    "resp_entity_list": t.EntityListResponseFrame,
    "resp_entity_resolve": t.EntityResolveResponse,
    "resp_statement_get": t.StatementGetResponse,
    "resp_statement_list": t.StatementListResponseFrame,
    "resp_relation_list": t.RelationListFromResponseFrame,
    # Cognitive read-side responses.
    "resp_plan": t.PlanResponseFrame,
    "resp_plan_trace": t.PlanResponseFrame,
    "resp_reason": t.ReasonResponseFrame,
    "resp_reason_trace": t.ReasonResponseFrame,
    "resp_link": t.LinkResponse,
    # Transaction responses.
    "resp_txn_begin": t.TxnBeginResponse,
    "resp_txn_commit": t.TxnCommitResponse,
    "resp_txn_abort": t.TxnAbortResponse,
    # Capabilities + subscription event.
    "resp_get_capabilities": t.GetCapabilitiesResponse,
    "resp_subscribe_event": t.SubscriptionEvent,
    # Extractor introspection (read-only; empty request).
    "req_extractor_list": t.ExtractorListRequest,
    "resp_extractor_list": t.ExtractorListResponseFrame,
    # Space registry.
    "req_space_create": t.SpaceCreateRequest,
    "resp_space_create": t.SpaceCreateResponse,
    "req_space_list": t.SpaceListRequest,
    "resp_space_list": t.SpaceListResponse,
    "req_space_delete": t.SpaceDeleteRequest,
    "resp_space_delete": t.SpaceDeleteResponse,
    # Session registry.
    "req_session_create": t.SessionCreateRequest,
    "resp_session_create": t.SessionCreateResponse,
    "req_session_list": t.SessionListRequest,
    "resp_session_list": t.SessionListResponse,
    "req_session_delete": t.SessionDeleteRequest,
    "resp_session_delete": t.SessionDeleteResponse,
    # Keepalive responses.
    "resp_pong": t.PongResponse,
    "resp_server_ping": t.ServerPingResponse,
    # ERROR body, one per category.
    "resp_error_protocol": t.ErrorResponse,
    "resp_error_authentication": t.ErrorResponse,
    "resp_error_authorization": t.ErrorResponse,
    "resp_error_validation": t.ErrorResponse,
    "resp_error_not_found": t.ErrorResponse,
    "resp_error_conflict": t.ErrorResponse,
    "resp_error_resource_exhausted": t.ErrorResponse,
    "resp_error_internal": t.ErrorResponse,
    "resp_error_unavailable": t.ErrorResponse,
    # Vector-bearing payload (CBOR prefix + raw f32 trailer).
    "req_encode_vector_direct": t.EncodeVectorDirectRequest,
}

# frame_* cases map to the payload type carried in their frame body.
FRAME_PAYLOAD_TYPES = {
    "frame_hello": t.HelloPayload,
    "frame_welcome": t.WelcomePayload,
    "frame_encode": t.EncodeRequest,
    "frame_error": t.ErrorResponse,
    "frame_recall_eos": t.RecallResponseFrame,
    "frame_encode_vector_direct": t.EncodeVectorDirectRequest,
}


def _read_bin(name: str) -> bytes:
    return (CORPUS / f"{name}.bin").read_bytes()


def _read_json(name: str):
    return json.loads((CORPUS / f"{name}.json").read_text())


def _load_index():
    return _read_json("index")


# --- structural normalization for the .json-mirror comparison --------------


def _normalize(value):
    """Project a decoded value's map to the shape the .json mirror uses.

    ``bytes`` (16-byte ids) -> list of ints, matching the mirror. f32 wire
    markers collapse to plain floats; floats are compared with a tolerance
    by ``_json_equal``.
    """
    if isinstance(value, _FloatField):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def _to_mirror(value):
    """Normalize a typed payload to a JSON-mirror-shaped structure."""
    return _normalize(value.to_map())


def _json_equal(a, b) -> bool:
    """Deep equality with f32 tolerance for floats.

    The .json mirror carries decimal floats; an f32 round-trip differs in
    the low bits, so floats are compared by 32-bit-rounded value.
    """
    if isinstance(a, float) or isinstance(b, float):
        fa = struct.unpack("<f", struct.pack("<f", float(a)))[0]
        fb = struct.unpack("<f", struct.pack("<f", float(b)))[0]
        return fa == fb
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return False
        return all(_json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b))
    return a == b


# --- cases ----------------------------------------------------------------


def _payload_cases():
    return [
        c["name"]
        for c in _load_index()
        if c["kind"] in ("request", "response") and c["name"] in PAYLOAD_TYPES
    ]


def _frame_cases():
    return [c["name"] for c in _load_index() if c["kind"] == "frame"]


@pytest.mark.parametrize("name", _payload_cases())
def test_payload_round_trip(name):
    payload_type = PAYLOAD_TYPES[name]
    bin_ = _read_bin(name)

    value = decode_payload(payload_type, bin_)

    mirror = _read_json(name)
    got = _to_mirror(value)
    assert _json_equal(got, mirror), f"{name}: decoded value != .json mirror\n got: {got}\n exp: {mirror}"

    reencoded = encode_payload(value)
    assert reencoded == bin_, (
        f"{name}: re-encoded bytes != .bin\n got: {reencoded.hex()}\n exp: {bin_.hex()}"
    )


@pytest.mark.parametrize("name", _frame_cases())
def test_frame_round_trip(name):
    bin_ = _read_bin(name)
    expected = _read_json(name)

    frame, rest = decode_frame(bin_)
    assert rest == b"", f"{name}: trailing bytes after frame"

    expected_opcode = int(expected["opcode_hex"], 16)
    assert frame.opcode == expected_opcode, f"{name}: opcode"
    assert frame.flags == expected["flags"], f"{name}: flags"
    assert frame.stream_id == expected["stream_id"], f"{name}: stream_id"
    assert len(frame.payload) == expected["payload_len"], f"{name}: payload_len"
    assert frame.payload == bytes.fromhex(expected["payload_hex"]), f"{name}: frame payload bytes"

    # The decoded payload must itself round-trip to the same payload bytes,
    # then the whole frame must re-encode byte-exact.
    payload_type = FRAME_PAYLOAD_TYPES[name]
    value = decode_payload(payload_type, frame.payload)
    payload = encode_payload(value)
    assert payload == frame.payload, f"{name}: re-encoded payload != original"

    rebuilt = encode_frame(frame.opcode, frame.stream_id, frame.flags, payload)
    assert rebuilt == bin_, f"{name}: re-encoded frame != .bin"


def test_all_cases_present():
    """The corpus has 86 .bin/.json pairs; every one must be covered."""
    index = _load_index()
    assert len(index) > 50, f"index.json produced only {len(index)} cases — is it truncated?"
    covered = set(PAYLOAD_TYPES) | set(FRAME_PAYLOAD_TYPES)
    names = {c["name"] for c in index}
    missing = names - covered
    assert not missing, f"corpus cases not covered by the test: {sorted(missing)}"
