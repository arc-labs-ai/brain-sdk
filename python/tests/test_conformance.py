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
    "req_recall": t.RecallRequest,
    "req_forget": t.ForgetRequest,
    "resp_encode": t.EncodeResponse,
    "resp_recall": t.RecallResponseFrame,
    "resp_forget": t.ForgetResponse,
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
    "resp_reason": t.ReasonResponseFrame,
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


def test_all_38_cases_present():
    """The corpus has 54 .bin/.json pairs; every one must be covered."""
    index = _load_index()
    assert len(index) == 54, f"expected 54 corpus cases, index has {len(index)}"
    covered = set(PAYLOAD_TYPES) | set(FRAME_PAYLOAD_TYPES)
    names = {c["name"] for c in index}
    missing = names - covered
    assert not missing, f"corpus cases not covered by the test: {sorted(missing)}"
