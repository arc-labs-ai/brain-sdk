"""Brain wire-protocol frame codec (the 32-byte BRN0 header).

Layout — all multi-byte integers big-endian::

    byte  0..4   magic b"BRN0"
    byte  4      version (= 1)
    byte  5..7   opcode (u16 BE; high byte = namespace 0x00 / 0x01)
    byte  7      flags (EOS=0x80, MPL=0x40, CMP=0x20)
    byte  8..12  header_crc32c (u32 BE) — CRC32C over header bytes 0..8 ++ 12..32
    byte 12..16  stream_id (u32 BE)
    byte 16..19  payload_len (u24 BE)
    byte 19      reserved_a (= 0)
    byte 20..24  payload_crc32c (u32 BE; 0 when payload empty)
    byte 24..32  reserved_b (8 bytes, = 0)

Payload (not part of this header) = CBOR map + optional trailing raw
little-endian f32 vector section.

A CRC or structural mismatch is fail-stop for the connection: a corrupt
frame desynchronizes the byte stream, so it must never be skipped.
"""

from __future__ import annotations

from dataclasses import dataclass

from .crc32c import crc32c

MAGIC = b"BRN0"
WIRE_VERSION = 1
HEADER_SIZE = 32
MAX_PAYLOAD_BYTES = (1 << 24) - 1

# Frame flag bits (header byte 7).
FLAG_EOS = 0x80
FLAG_MPL = 0x40
FLAG_CMP = 0x20
# Flag bits that are defined; everything else MUST be zero on the wire.
FLAGS_DEFINED_MASK = FLAG_EOS | FLAG_MPL | FLAG_CMP

# Opcode namespaces (high byte of the u16 opcode).
OPCODE_NS_SUBSTRATE = 0x00
OPCODE_NS_TYPED_GRAPH = 0x01

# Field byte offsets within the 32-byte header.
OFF_MAGIC = 0
OFF_VERSION = 4
OFF_OPCODE = 5
OFF_FLAGS = 7
OFF_HEADER_CRC = 8
OFF_STREAM_ID = 12
OFF_PAYLOAD_LEN = 16
OFF_RESERVED_A = 19
OFF_PAYLOAD_CRC = 20
OFF_RESERVED_B = 24


class FrameError(Exception):
    """Base for errors raised while decoding a frame off the wire."""


class BadMagic(FrameError):
    """First four bytes were not b"BRN0"."""


class BadVersion(FrameError):
    """Version byte did not match WIRE_VERSION."""

    def __init__(self, got: int) -> None:
        super().__init__(f"unsupported wire version: got {got}, expected {WIRE_VERSION}")
        self.got = got


class BadHeaderCrc(FrameError):
    """header_crc32c did not match the recomputed CRC."""


class BadPayloadCrc(FrameError):
    """payload_crc32c did not match the CRC of the payload bytes."""


class OversizePayload(FrameError):
    """payload_len exceeded the maximum — rejected before any buffer is sliced."""

    def __init__(self, length: int) -> None:
        super().__init__(f"payload length {length} exceeds maximum {MAX_PAYLOAD_BYTES}")
        self.length = length


class ReservedNonZero(FrameError):
    """A reserved header byte or reserved flag bit was non-zero."""


class TruncatedFrame(FrameError):
    """Not enough bytes buffered yet; the caller should read more and retry."""

    def __init__(self, have: int, need: int) -> None:
        super().__init__(f"truncated frame: have {have} bytes, need {need}")
        self.have = have
        self.need = need


@dataclass(frozen=True)
class Frame:
    """A decoded BRN0 frame: header fields + raw payload bytes.

    The payload is the CBOR section plus any trailing raw-vector section,
    undivided at this layer.
    """

    opcode: int
    flags: int
    stream_id: int
    payload: bytes


def _compute_header_crc(header: bytes) -> int:
    """CRC32C over header bytes 0..8 ++ 12..32 (excludes the CRC field itself)."""
    return crc32c(header[:OFF_HEADER_CRC] + header[OFF_STREAM_ID:HEADER_SIZE])


def encode_frame(opcode: int, stream_id: int, flags: int, payload: bytes) -> bytes:
    """Encode a complete BRN0 frame: 32-byte header (both CRCs computed) ++ payload."""
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise OversizePayload(len(payload))

    header = bytearray(HEADER_SIZE)
    header[OFF_MAGIC : OFF_MAGIC + 4] = MAGIC
    header[OFF_VERSION] = WIRE_VERSION
    header[OFF_OPCODE : OFF_OPCODE + 2] = opcode.to_bytes(2, "big")
    header[OFF_FLAGS] = flags
    # header_crc32c (8..12) stays zero until computed below.
    header[OFF_STREAM_ID : OFF_STREAM_ID + 4] = stream_id.to_bytes(4, "big")
    header[OFF_PAYLOAD_LEN : OFF_PAYLOAD_LEN + 3] = len(payload).to_bytes(3, "big")
    # reserved_a (19) and reserved_b (24..32) stay zero.
    # An empty payload carries a zero CRC, which crc32c(b"") already yields.
    header[OFF_PAYLOAD_CRC : OFF_PAYLOAD_CRC + 4] = crc32c(payload).to_bytes(4, "big")

    header_crc = _compute_header_crc(bytes(header))
    header[OFF_HEADER_CRC : OFF_HEADER_CRC + 4] = header_crc.to_bytes(4, "big")

    return bytes(header) + payload


def decode_frame(buf: bytes) -> tuple[Frame, bytes]:
    """Decode one BRN0 frame from the front of ``buf``; return (frame, rest).

    Validates magic / version / reserved bytes / reserved flag bits,
    verifies the header CRC, checks payload_len against the maximum
    *before* slicing the payload (so a hostile length cannot drive a large
    allocation), then verifies the payload CRC.
    """
    if len(buf) < HEADER_SIZE:
        raise TruncatedFrame(len(buf), HEADER_SIZE)

    header = buf[:HEADER_SIZE]

    if header[OFF_MAGIC : OFF_MAGIC + 4] != MAGIC:
        raise BadMagic("bad frame magic")
    if header[OFF_VERSION] != WIRE_VERSION:
        raise BadVersion(header[OFF_VERSION])
    if header[OFF_RESERVED_A] != 0 or header[OFF_RESERVED_B:HEADER_SIZE] != bytes(8):
        raise ReservedNonZero("reserved header byte was non-zero")
    flags = header[OFF_FLAGS]
    if flags & ~FLAGS_DEFINED_MASK != 0:
        raise ReservedNonZero("reserved flag bit was non-zero")

    stored_header_crc = int.from_bytes(header[OFF_HEADER_CRC : OFF_HEADER_CRC + 4], "big")
    if stored_header_crc != _compute_header_crc(header):
        raise BadHeaderCrc("header CRC mismatch")

    payload_len = int.from_bytes(header[OFF_PAYLOAD_LEN : OFF_PAYLOAD_LEN + 3], "big")
    if payload_len > MAX_PAYLOAD_BYTES:
        raise OversizePayload(payload_len)

    need = HEADER_SIZE + payload_len
    if len(buf) < need:
        raise TruncatedFrame(len(buf), need)
    payload = buf[HEADER_SIZE:need]

    stored_payload_crc = int.from_bytes(header[OFF_PAYLOAD_CRC : OFF_PAYLOAD_CRC + 4], "big")
    if stored_payload_crc != crc32c(payload):
        raise BadPayloadCrc("payload CRC mismatch")

    frame = Frame(
        opcode=int.from_bytes(header[OFF_OPCODE : OFF_OPCODE + 2], "big"),
        flags=flags,
        stream_id=int.from_bytes(header[OFF_STREAM_ID : OFF_STREAM_ID + 4], "big"),
        payload=payload,
    )
    return frame, buf[need:]
