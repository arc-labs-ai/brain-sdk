"""Regression + property tests for the CBOR prefix decoder.

cbor2 6.x's incremental ``CBORDecoder(fileobj).decode()`` panics
("buffer size mismatch") on valid multi-item payloads — e.g. a RECALL_RESP
carrying ten result maps. The SDK no longer uses that path; ``from_cbor`` /
``from_cbor_prefix`` decode via ``cbor2.loads`` plus a structural
length-scanner. These tests pin that behavior so a future refactor can't
reintroduce the streaming decoder.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest

from brain_db_sdk.wire.cbor import (
    TrailingBytesError,
    _cbor_item_end,
    from_cbor,
    from_cbor_prefix,
    mark_f64,
    round_f32,
    to_cbor,
)

FIXTURE = Path(__file__).parent / "fixtures" / "recall_resp_10_results.hex"


def test_real_recall_response_decodes() -> None:
    """The exact RECALL_RESP bytes that panicked the streaming decoder must
    now decode fully via ``from_cbor``."""
    data = bytes.fromhex(FIXTURE.read_text().strip())
    value = from_cbor(data)
    assert isinstance(value, dict)
    assert len(value["results"]) == 10
    assert value["is_final"] is True
    # Spot-check a result carries the expected fields.
    first = value["results"][0]
    assert "memory_id" in first and "text" in first and "similarity_score" in first


def test_prefix_consumes_exactly_and_splits_trailing_vector() -> None:
    data = bytes.fromhex(FIXTURE.read_text().strip())
    value, consumed = from_cbor_prefix(data)
    assert consumed == len(data)
    assert len(value["results"]) == 10

    # Simulate a vector-bearing payload: CBOR item + trailing f32 block.
    vec = struct.pack("<3f", 1.0, 2.0, 0.5)
    payload = to_cbor({"k": 1}) + vec
    val, n = from_cbor_prefix(payload)
    assert val == {"k": 1}
    assert payload[n:] == vec


def test_from_cbor_rejects_trailing_bytes() -> None:
    with pytest.raises(TrailingBytesError):
        from_cbor(to_cbor({"a": 1}) + b"\x00\x01\x02")


@pytest.mark.parametrize(
    "value",
    [
        0,
        1,
        -1,
        2**53,
        b"\xde\xad\xbe\xef",
        "hello world",
        [],
        [1, 2, 3],
        {"a": 1, "b": [1, 2], "c": {"d": "e"}},
        {"floats": [round_f32(0.867), mark_f64(0.5), round_f32(0.0)]},
        # A bignum-tagged big integer like the server's memory_id encoding.
        2**70,
        # Nested + mixed, resembling a result row.
        {
            "results": [
                {"id": 2**64 + i, "score": round_f32(0.1 * i), "txt": "x" * i} for i in range(5)
            ],
            "final": True,
        },
    ],
)
def test_scanner_length_matches_encoded_length(value: object) -> None:
    """The structural scanner must measure exactly what the SDK encoded —
    no more, no less — for arbitrary values."""
    encoded = to_cbor(value)
    assert _cbor_item_end(encoded, 0) == len(encoded)


def test_scanner_handles_indefinite_length_containers() -> None:
    # Indefinite array: 0x9f ... 0xff
    indef_array = b"\x9f\x01\x02\x03\xff"
    assert _cbor_item_end(indef_array, 0) == len(indef_array)
    # Indefinite map: 0xbf "a":1 0xff
    indef_map = b"\xbf\x61\x61\x01\xff"
    assert _cbor_item_end(indef_map, 0) == len(indef_map)
    # Indefinite text string of two chunks.
    indef_str = b"\x7f\x62hi\x61!\xff"
    assert _cbor_item_end(indef_str, 0) == len(indef_str)
