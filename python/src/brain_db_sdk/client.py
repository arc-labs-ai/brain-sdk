"""The high-level client: connect, handshake, and hold the negotiated
session.

:meth:`BrainClient.connect` opens a TCP connection, runs the handshake,
and returns a client bound to the session the server granted. This phase
establishes and describes the session; the ergonomic verb builders
(``recall`` streaming, retries) arrive in later phases. A minimal typed
:meth:`BrainClient.encode` proves an end-to-end round-trip. The API is
synchronous; an ``asyncio`` client is a later phase.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from .errors import ProtocolError
from .mux import MuxConnection
from .wire.opcode import Opcode
from .wire.types import (
    AgentPermissions,
    AuthCredentials,
    AuthMethod,
    AuthPayload,
    EncodeRequest,
    EncodeResponse,
    EntityCreateRequest,
    EntityCreateResponse,
    ForgetRequest,
    ForgetResponse,
    HelloCapabilities,
    HelloPayload,
    MaterializeProceduralRequest,
    MaterializeProceduralResponse,
    MemoryResult,
    MtlsClaim,
    QueryRequest,
    QueryResponse,
    RecallRequest,
    RecallResponseFrame,
    RelationCreateRequest,
    RelationCreateResponse,
    SchemaUploadRequest,
    SchemaUploadResponse,
    ServerFeatures,
    StatementCreateRequest,
    StatementCreateResponse,
    decode_payload,
    encode_payload,
)

# Default ``client_id`` advertised in HELLO.
DEFAULT_CLIENT_ID = "brain-db-sdk-python"


def new_id() -> bytes:
    """Mint a fresh 16-byte identifier (a random UUID's bytes)."""
    return uuid.uuid4().bytes


@dataclass(frozen=True)
class Auth:
    """How the client authenticates after WELCOME."""

    method: AuthMethod
    credentials: AuthCredentials

    @staticmethod
    def anonymous() -> "Auth":
        """Anonymous — only succeeds when the server allows it (dev/local)."""
        return Auth(AuthMethod.NONE, AuthCredentials.none())

    @staticmethod
    def token(token: bytes) -> "Auth":
        """A shared bearer token."""
        return Auth(AuthMethod.TOKEN, AuthCredentials.token(token))

    @staticmethod
    def mtls(claim: MtlsClaim) -> "Auth":
        """An mTLS subject claim."""
        return Auth(AuthMethod.MTLS, AuthCredentials.mtls(claim))


@dataclass
class ClientConfig:
    """Connection configuration. The defaults suit a local/dev server:
    anonymous auth, wire version 1, streaming advertised."""

    client_id: str = DEFAULT_CLIENT_ID
    agent_id: bytes = field(default_factory=new_id)
    supported_versions: list[int] = field(default_factory=lambda: [1])
    capabilities: HelloCapabilities = field(
        default_factory=lambda: HelloCapabilities(
            streaming=True, compression_zstd=False, server_push=False
        )
    )
    auth: Auth = field(default_factory=Auth.anonymous)
    connect_timeout: float | None = 10.0
    request_timeout: float | None = 30.0


@dataclass(frozen=True)
class SessionInfo:
    """The session the server granted at handshake time."""

    agent_id: bytes
    server_id: str
    chosen_version: int
    session_id: bytes
    bound_shard_id: int
    permissions: AgentPermissions
    server_features: ServerFeatures


class BrainClient:
    """A connected, handshaken Brain client over a multiplexed connection.

    Verbs are served on a :class:`~brain_db_sdk.mux.MuxConnection`, whose
    background reader thread demultiplexes responses by ``stream_id`` — so a
    single client serves many requests in flight at once from multiple threads.
    """

    def __init__(self, conn: MuxConnection, session: SessionInfo) -> None:
        self._conn = conn
        self._session = session

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        config: ClientConfig | None = None,
    ) -> "BrainClient":
        """Connect to ``host:port``, run the handshake, and return the
        bound client."""
        config = config or ClientConfig()
        hello = HelloPayload(
            client_id=config.client_id,
            supported_versions=list(config.supported_versions),
            capabilities=config.capabilities,
            client_session_token=None,
        )
        auth = AuthPayload(
            method=config.auth.method,
            agent_id=config.agent_id,
            credentials=config.auth.credentials,
        )
        conn, outcome = MuxConnection.connect(
            host,
            port,
            hello,
            auth,
            connect_timeout=config.connect_timeout,
            request_timeout=config.request_timeout,
        )
        # AUTH_OK decodes ``permissions`` as a raw map; lift it to the typed
        # form so callers get attribute access.
        permissions = outcome.auth_ok.permissions
        if isinstance(permissions, dict):
            permissions = AgentPermissions.from_map(permissions)
        session = SessionInfo(
            agent_id=outcome.auth_ok.agent_id,
            server_id=outcome.welcome.server_id,
            chosen_version=outcome.welcome.chosen_version,
            session_id=outcome.welcome.session_id,
            bound_shard_id=outcome.auth_ok.bound_shard_id,
            permissions=permissions,
            server_features=outcome.welcome.server_features,
        )
        return cls(conn, session)

    @property
    def session(self) -> SessionInfo:
        """The negotiated session."""
        return self._session

    @property
    def agent_id(self) -> bytes:
        """The agent id this connection acts as."""
        return self._session.agent_id

    def encode(self, request: EncodeRequest) -> EncodeResponse:
        """Store a memory from text. A minimal typed round-trip over the
        connection; the ergonomic request builder lands in a later phase."""
        frame = self._conn.request_one(Opcode.ENCODE_REQ, encode_payload(request))
        if frame.opcode != int(Opcode.ENCODE_RESP):
            raise ProtocolError(
                f"expected ENCODE_RESP ({int(Opcode.ENCODE_RESP):#06x}), got "
                f"{frame.opcode:#06x}"
            )
        return decode_payload(EncodeResponse, frame.payload)

    def recall(self, request: RecallRequest) -> list[MemoryResult]:
        """Retrieve memories by cue. RECALL streams one or more ``RECALL_RESP``
        frames terminated by EOS; this collects them and flattens every frame's
        ``results`` into one ordered list. For the raw streamed frames
        (cumulative counts, ``estimated_remaining``), use :meth:`recall_frames`.
        """
        results: list[MemoryResult] = []
        for frame in self.recall_frames(request):
            results.extend(frame.results)
        return results

    def recall_frames(self, request: RecallRequest) -> list[RecallResponseFrame]:
        """Retrieve memories by cue, returning each decoded ``RECALL_RESP``
        frame as streamed (preserving ``is_final`` / ``cumulative_count`` /
        ``estimated_remaining``). The last frame carries the EOS flag."""
        frames = self._conn.request(Opcode.RECALL_REQ, encode_payload(request))
        out: list[RecallResponseFrame] = []
        for frame in frames:
            if frame.opcode != int(Opcode.RECALL_RESP):
                raise ProtocolError(
                    f"expected RECALL_RESP ({int(Opcode.RECALL_RESP):#06x}), got "
                    f"{frame.opcode:#06x}"
                )
            out.append(decode_payload(RecallResponseFrame, frame.payload))
        return out

    def forget(self, request: ForgetRequest) -> ForgetResponse:
        """Forget a memory (soft tombstone or hard zeroing, per the request)."""
        frame = self._conn.request_one(Opcode.FORGET_REQ, encode_payload(request))
        if frame.opcode != int(Opcode.FORGET_RESP):
            raise ProtocolError(
                f"expected FORGET_RESP ({int(Opcode.FORGET_RESP):#06x}), got "
                f"{frame.opcode:#06x}"
            )
        return decode_payload(ForgetResponse, frame.payload)

    def create_entity(self, request: EntityCreateRequest) -> EntityCreateResponse:
        """Create a typed entity (ENTITY_CREATE)."""
        return self._unary(
            Opcode.ENTITY_CREATE_REQ, Opcode.ENTITY_CREATE_RESP, EntityCreateResponse, request
        )

    def create_statement(self, request: StatementCreateRequest) -> StatementCreateResponse:
        """Create a statement (STATEMENT_CREATE). The response reports any
        auto-superseded prior statement and the supersession chain root."""
        return self._unary(
            Opcode.STATEMENT_CREATE_REQ,
            Opcode.STATEMENT_CREATE_RESP,
            StatementCreateResponse,
            request,
        )

    def create_relation(self, request: RelationCreateRequest) -> RelationCreateResponse:
        """Create a relation between two entities (RELATION_CREATE)."""
        return self._unary(
            Opcode.RELATION_CREATE_REQ,
            Opcode.RELATION_CREATE_RESP,
            RelationCreateResponse,
            request,
        )

    def upload_schema(self, request: SchemaUploadRequest) -> SchemaUploadResponse:
        """Upload a schema document (SCHEMA_UPLOAD). With ``dry_run`` set the
        server validates without applying; the response carries any validation
        errors and a backward-compatibility verdict."""
        return self._unary(
            Opcode.SCHEMA_UPLOAD_REQ, Opcode.SCHEMA_UPLOAD_RESP, SchemaUploadResponse, request
        )

    def query(self, request: QueryRequest) -> QueryResponse:
        """Run a hybrid typed-graph query (QUERY). Returns fused, ranked results
        with per-retriever contributions and outcome diagnostics."""
        return self._unary(Opcode.QUERY_REQ, Opcode.QUERY_RESP, QueryResponse, request)

    def materialize_procedural(
        self, request: MaterializeProceduralRequest
    ) -> MaterializeProceduralResponse:
        """Materialize a procedural-memory system block (MATERIALIZE_PROCEDURAL)."""
        return self._unary(
            Opcode.MATERIALIZE_PROCEDURAL_REQ,
            Opcode.MATERIALIZE_PROCEDURAL_RESP,
            MaterializeProceduralResponse,
            request,
        )

    def _unary(self, req_opcode: Opcode, resp_opcode: Opcode, resp_type, request):
        """Send one request and decode a single typed response frame, asserting
        the response opcode. The shape every single-shot typed-graph verb shares.
        """
        frame = self._conn.request_one(req_opcode, encode_payload(request))
        if frame.opcode != int(resp_opcode):
            raise ProtocolError(
                f"expected {resp_opcode.name} ({int(resp_opcode):#06x}), got "
                f"{frame.opcode:#06x}"
            )
        return decode_payload(resp_type, frame.payload)

    def close(self) -> None:
        """Send BYE and close the socket."""
        try:
            self._conn.send_bye()
        finally:
            self._conn.close()

    def __enter__(self) -> "BrainClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


__all__ = [
    "BrainClient",
    "ClientConfig",
    "SessionInfo",
    "Auth",
    "new_id",
]
