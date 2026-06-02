"""Wire-protocol layer: the 32-byte BRN0 frame codec (L1), the CBOR
payload codec + trailing raw-vector section (L2), the opcode table, and
the typed request/response payloads the bytes decode to.

Brain ships no client library; its contract is the wire protocol. This
package re-implements that protocol independently and is verified
byte-for-byte against Brain's conformance corpus.
"""

from __future__ import annotations

from . import cbor, frame, opcode, types
from .frame import (
    FLAG_CMP,
    FLAG_EOS,
    FLAG_MPL,
    FLAGS_DEFINED_MASK,
    HEADER_SIZE,
    MAGIC,
    MAX_PAYLOAD_BYTES,
    OPCODE_NS_SUBSTRATE,
    OPCODE_NS_TYPED_GRAPH,
    WIRE_VERSION,
    BadHeaderCrc,
    BadMagic,
    BadPayloadCrc,
    BadVersion,
    Frame,
    FrameError,
    OversizePayload,
    ReservedNonZero,
    TruncatedFrame,
    decode_frame,
    encode_frame,
)
from .opcode import Opcode

__all__ = [
    "cbor",
    "frame",
    "opcode",
    "types",
    "Frame",
    "FrameError",
    "BadMagic",
    "BadVersion",
    "BadHeaderCrc",
    "BadPayloadCrc",
    "OversizePayload",
    "ReservedNonZero",
    "TruncatedFrame",
    "encode_frame",
    "decode_frame",
    "Opcode",
    "MAGIC",
    "WIRE_VERSION",
    "HEADER_SIZE",
    "MAX_PAYLOAD_BYTES",
    "FLAG_EOS",
    "FLAG_MPL",
    "FLAG_CMP",
    "FLAGS_DEFINED_MASK",
    "OPCODE_NS_SUBSTRATE",
    "OPCODE_NS_TYPED_GRAPH",
]
