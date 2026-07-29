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
    "FLAGS_DEFINED_MASK",
    "FLAG_CMP",
    "FLAG_EOS",
    "FLAG_MPL",
    "HEADER_SIZE",
    "MAGIC",
    "MAX_PAYLOAD_BYTES",
    "OPCODE_NS_SUBSTRATE",
    "OPCODE_NS_TYPED_GRAPH",
    "WIRE_VERSION",
    "BadHeaderCrc",
    "BadMagic",
    "BadPayloadCrc",
    "BadVersion",
    "Frame",
    "FrameError",
    "Opcode",
    "OversizePayload",
    "ReservedNonZero",
    "TruncatedFrame",
    "cbor",
    "decode_frame",
    "encode_frame",
    "frame",
    "opcode",
    "types",
]
