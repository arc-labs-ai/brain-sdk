"""Adversarial frame decoding: what the SDK does with bytes a hostile or buggy
peer sends.

Every SDK validates magic, version, reserved bytes, reserved flag bits, both
CRC32Cs and the payload-length bound. That code is written three times and was
exercised zero times — it is the layer standing between a client and a peer it
does not control, and a client SDK reads bytes it did not produce by definition.

Cases come from ``conformance/malformed.json`` so all three SDKs feed their
decoders byte-identical input, the same way the corpus works. A case this
runner cannot reproduce fails rather than skipping.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from brain_db_sdk.wire import frame as F
from brain_db_sdk.wire.cbor import from_cbor

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "conformance" / "malformed.json").read_text()
)

# The shared taxonomy name -> this SDK's exception class.
EXPECTED = {
    "BadMagic": F.BadMagic,
    "BadVersion": F.BadVersion,
    "BadHeaderCrc": F.BadHeaderCrc,
    "BadPayloadCrc": F.BadPayloadCrc,
    "OversizePayload": F.OversizePayload,
    "ReservedNonZero": F.ReservedNonZero,
    "Truncated": F.TruncatedFrame,
}


def _valid_frame() -> bytearray:
    base = VECTORS["base"]
    return bytearray(
        F.encode_frame(
            base["opcode"],
            base["stream_id"],
            base["flags"],
            bytes.fromhex(base["payload_hex"]),
        )
    )


def _recompute_header_crc(buf: bytearray) -> None:
    """Re-stamp header_crc32c so a case reaches the check it is actually about.

    Without this, any mutation inside the CRC's coverage is caught as
    BadHeaderCrc first and the case under test never runs.
    """
    buf[F.OFF_HEADER_CRC : F.OFF_HEADER_CRC + 4] = b"\x00\x00\x00\x00"
    crc = F._compute_header_crc(bytes(buf[: F.HEADER_SIZE]))
    buf[F.OFF_HEADER_CRC : F.OFF_HEADER_CRC + 4] = crc.to_bytes(4, "big")


def _apply(case) -> bytes:
    buf = _valid_frame()
    for m in case["mutate"]:
        if m["op"] == "set":
            buf[m["offset"]] = m["value"]
        elif m["op"] == "xor":
            buf[m["offset"]] ^= m["value"]
        elif m["op"] == "truncate":
            del buf[m["len"] :]
        else:  # pragma: no cover - a typo in the vector file must not pass
            raise AssertionError(f"unknown mutation op {m['op']!r}")
    if case["recrc"]:
        _recompute_header_crc(buf)
    return bytes(buf)


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_malformed_frame_is_rejected(case) -> None:
    want = EXPECTED[case["expect"]]
    with pytest.raises(want) as excinfo:
        F.decode_frame(_apply(case))
    # Every one of these is a FrameError; a stray IndexError or struct.error
    # would mean the decoder walked off the buffer before validating.
    assert isinstance(excinfo.value, F.FrameError), case["why"]


def test_a_valid_frame_still_decodes() -> None:
    """The mutations are what break these frames — not the harness."""
    frame, rest = F.decode_frame(bytes(_valid_frame()))
    assert frame.opcode == VECTORS["base"]["opcode"]
    assert frame.stream_id == VECTORS["base"]["stream_id"]
    assert rest == b""


def _cbor_payload(spec: str) -> bytes:
    kind, _, rest = spec.partition(":")
    if kind == "hex":
        return bytes.fromhex(rest)
    if kind == "repeat":
        byte_hex, _, count = rest.partition(":")
        return bytes.fromhex(byte_hex) * int(count) + b"\x00"
    raise AssertionError(f"unknown payload spec {spec!r}")


@pytest.mark.parametrize("case", VECTORS["cbor_cases"], ids=lambda c: c["name"])
def test_malformed_cbor_errors_rather_than_crashing(case) -> None:
    """The bar is 'raises', not 'raises a particular type'.

    What matters is that a hostile payload cannot take the process down or hang
    it — CVE-2026-26209 was exactly this, a sub-100KB nested payload driving
    cbor2 into unbounded recursion. `any` cases only assert no crash, because
    whether an implementation accepts a well-formed-but-unexpected encoding is
    a codec choice rather than a correctness one.
    """
    payload = _cbor_payload(case["payload"])
    try:
        from_cbor(payload)
    except Exception as e:  # noqa: BLE001 - asserting WHICH type escaped
        # PT017: `pytest.raises` cannot express "any exception EXCEPT this
        # subclass", which is exactly what this asserts.
        assert not isinstance(e, RecursionError), (  # noqa: PT017
            "a RecursionError means the depth cap is missing; cbor2 >= 5.9 "
            "raises CBORDecodeError instead. See the pin in pyproject.toml."
        )
        return
    if case["expect"] == "error_not_crash":
        pytest.fail(f"{case['name']}: decoded without error — {case['why']}")
