"""Wire-protocol opcodes (u16, big-endian on the wire).

High byte is the namespace (0x00 substrate / connection / admin, 0x01
typed-graph). Within a namespace the low byte's high bit selects
direction: < 0x80 server-bound request, >= 0x80 client-bound response.
This phase covers the handshake, the three v1 verbs, BYE, ERROR, and the
typed-graph ops the conformance corpus exercises.
"""

from __future__ import annotations

from enum import IntEnum


class Opcode(IntEnum):
    # Connection management.
    HELLO = 0x0001
    WELCOME = 0x0081
    AUTH = 0x0002
    AUTH_OK = 0x0082
    BYE = 0x001F

    # v1 cognitive verbs.
    ENCODE_REQ = 0x0020
    ENCODE_RESP = 0x00A0
    RECALL_REQ = 0x0021
    RECALL_RESP = 0x00A1
    FORGET_REQ = 0x0024
    FORGET_RESP = 0x00A4
    ENCODE_VECTOR_DIRECT_REQ = 0x002A
    ENCODE_VECTOR_DIRECT_RESP = 0x00AA

    # Error.
    ERROR = 0x00FF

    # Typed-graph ops exercised by the corpus.
    SCHEMA_UPLOAD_REQ = 0x0120
    SCHEMA_UPLOAD_RESP = 0x01A0
    ENTITY_CREATE_REQ = 0x0130
    ENTITY_CREATE_RESP = 0x01B0
    STATEMENT_CREATE_REQ = 0x0140
    STATEMENT_CREATE_RESP = 0x01C0
    RELATION_CREATE_REQ = 0x0150
    RELATION_CREATE_RESP = 0x01D0
    QUERY_REQ = 0x0160
    QUERY_RESP = 0x01E0
    MATERIALIZE_PROCEDURAL_REQ = 0x0164
    MATERIALIZE_PROCEDURAL_RESP = 0x01E4
