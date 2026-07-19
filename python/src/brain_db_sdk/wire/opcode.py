"""Wire-protocol opcodes (u16, big-endian on the wire).

High byte is the namespace (0x00 substrate / connection / admin, 0x01
typed-graph). Within a namespace the low byte's high bit selects
direction: < 0x80 server-bound request, >= 0x80 client-bound response.
Covers the handshake, keepalive, the v1 cognitive verbs, subscriptions,
transactions, capability introspection, ERROR, and the full typed-graph
op surface (schema, entity, statement, relation, and query families).
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

    # Keepalive. SERVER_PING is the server's idle-timer heartbeat; the client
    # MUST answer it with CLIENT_PONG or the server closes the connection.
    PING = 0x0010
    PONG = 0x0090
    CLIENT_PONG = 0x0011
    SERVER_PING = 0x0091

    # v1 cognitive verbs.
    ENCODE_REQ = 0x0020
    ENCODE_RESP = 0x00A0
    RECALL_REQ = 0x0021
    RECALL_RESP = 0x00A1
    PLAN_REQ = 0x0022
    PLAN_RESP = 0x00A2
    REASON_REQ = 0x0023
    REASON_RESP = 0x00A3
    FORGET_REQ = 0x0024
    FORGET_RESP = 0x00A4
    LINK_REQ = 0x0025
    LINK_RESP = 0x00A5
    UNLINK_REQ = 0x0026
    UNLINK_RESP = 0x00A6
    MEMORY_LIST_REQ = 0x0027
    MEMORY_LIST_RESP = 0x00A7
    MEMORY_INSPECT_REQ = 0x0028
    MEMORY_INSPECT_RESP = 0x00A8
    ENCODE_VECTOR_DIRECT_REQ = 0x002A
    ENCODE_VECTOR_DIRECT_RESP = 0x00AA

    # Subscriptions (server push).
    SUBSCRIBE_REQ = 0x0030
    SUBSCRIBE_EVENT = 0x00B0
    UNSUBSCRIBE_REQ = 0x0031
    UNSUBSCRIBE_RESP = 0x00B1

    # Capability introspection.
    GET_CAPABILITIES_REQ = 0x0032
    GET_CAPABILITIES_RESP = 0x00B2

    # Transactions.
    TXN_BEGIN = 0x0040
    TXN_BEGIN_RESP = 0x00C0
    TXN_COMMIT = 0x0041
    TXN_COMMIT_RESP = 0x00C1
    TXN_ABORT = 0x0042
    TXN_ABORT_RESP = 0x00C2

    # Error.
    ERROR = 0x00FF

    # Typed-graph ops exercised by the corpus.
    SCHEMA_UPLOAD_REQ = 0x0120
    SCHEMA_UPLOAD_RESP = 0x01A0
    SCHEMA_GET_REQ = 0x0121
    SCHEMA_GET_RESP = 0x01A1
    SCHEMA_LIST_REQ = 0x0122
    SCHEMA_LIST_RESP = 0x01A2
    SCHEMA_VALIDATE_REQ = 0x0123
    SCHEMA_VALIDATE_RESP = 0x01A3
    # Extractor introspection. Read-only: extraction is always-on, so the
    # only extractor wire op lists the registered (always-on) extractors.
    EXTRACTOR_LIST_REQ = 0x0124
    EXTRACTOR_LIST_RESP = 0x01A4
    ENTITY_CREATE_REQ = 0x0130
    ENTITY_CREATE_RESP = 0x01B0
    ENTITY_GET_REQ = 0x0131
    ENTITY_GET_RESP = 0x01B1
    ENTITY_RESOLVE_REQ = 0x0136
    ENTITY_RESOLVE_RESP = 0x01B6
    ENTITY_LIST_REQ = 0x0137
    ENTITY_LIST_RESP = 0x01B7
    ENTITY_UPDATE_REQ = 0x0132
    ENTITY_UPDATE_RESP = 0x01B2
    ENTITY_RENAME_REQ = 0x0133
    ENTITY_RENAME_RESP = 0x01B3
    ENTITY_MERGE_REQ = 0x0134
    ENTITY_MERGE_RESP = 0x01B4
    ENTITY_UNMERGE_REQ = 0x0135
    ENTITY_UNMERGE_RESP = 0x01B5
    ENTITY_TOMBSTONE_REQ = 0x0138
    ENTITY_TOMBSTONE_RESP = 0x01B8
    STATEMENT_CREATE_REQ = 0x0140
    STATEMENT_CREATE_RESP = 0x01C0
    STATEMENT_GET_REQ = 0x0141
    STATEMENT_GET_RESP = 0x01C1
    STATEMENT_LIST_REQ = 0x0146
    STATEMENT_LIST_RESP = 0x01C6
    STATEMENT_SUPERSEDE_REQ = 0x0142
    STATEMENT_SUPERSEDE_RESP = 0x01C2
    STATEMENT_TOMBSTONE_REQ = 0x0143
    STATEMENT_TOMBSTONE_RESP = 0x01C3
    STATEMENT_RETRACT_REQ = 0x0144
    STATEMENT_RETRACT_RESP = 0x01C4
    STATEMENT_HISTORY_REQ = 0x0145
    STATEMENT_HISTORY_RESP = 0x01C5
    RELATION_CREATE_REQ = 0x0150
    RELATION_CREATE_RESP = 0x01D0
    RELATION_LIST_FROM_REQ = 0x0154
    RELATION_LIST_FROM_RESP = 0x01D4
    RELATION_LIST_TO_REQ = 0x0155
    RELATION_LIST_TO_RESP = 0x01D5
    # Relation lifecycle + traversal: fetch one (get), revise (supersede),
    # retire (tombstone), or walk the graph from an entity (traverse).
    RELATION_GET_REQ = 0x0151
    RELATION_GET_RESP = 0x01D1
    RELATION_SUPERSEDE_REQ = 0x0152
    RELATION_SUPERSEDE_RESP = 0x01D2
    RELATION_TOMBSTONE_REQ = 0x0153
    RELATION_TOMBSTONE_RESP = 0x01D3
    RELATION_TRAVERSE_REQ = 0x0156
    RELATION_TRAVERSE_RESP = 0x01D6
    # Query introspection: the plan (explain) and execution trace, a debug
    # surface. RECALL is the sole primary read verb.
    QUERY_EXPLAIN_REQ = 0x0161
    QUERY_EXPLAIN_RESP = 0x01E1
    QUERY_TRACE_REQ = 0x0162
    QUERY_TRACE_RESP = 0x01E2
    # Full-agent typed-graph export (paginated, streamed like MEMORY_LIST).
    GRAPH_FETCH_REQ = 0x0163
    GRAPH_FETCH_RESP = 0x01E3
    MATERIALIZE_PROCEDURAL_REQ = 0x0164
    MATERIALIZE_PROCEDURAL_RESP = 0x01E4
