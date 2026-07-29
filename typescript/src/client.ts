/**
 * The high-level client: connect, handshake, and serve the v1 + typed-graph
 * verbs over a multiplexed connection.
 *
 * `BrainClient.connect` opens a TCP connection, runs the handshake, and
 * resolves to a client bound to the session the server granted. The client
 * sits on a `MuxConnection`, whose single `data` pump demultiplexes responses
 * by `streamId` — so many requests run in flight at once over the one
 * connection. To add retry, wrap a verb call in `withRetry`; the stable
 * `requestId` each builder mints makes the resend idempotent.
 */

import { createHash, randomBytes } from "node:crypto";

import { ProtocolError } from "./errors.js";
import { MuxConnection, type Subscription } from "./mux.js";
import type { Frame } from "./wire/frame.js";
import { Opcode } from "./wire/opcode.js";
import {
  type SpacePermissions,
  type SpaceCreateRequest,
  type SpaceCreateResponse,
  type SpaceListRequest,
  type SpaceListResponse,
  type SpaceDeleteRequest,
  type SpaceDeleteResponse,
  type SessionCreateRequest,
  type SessionCreateResponse,
  type SessionListRequest,
  type SessionListResponse,
  type SessionDeleteRequest,
  type SessionDeleteResponse,
  encodeSpaceCreate,
  decodeSpaceCreateResponse,
  encodeSpaceList,
  decodeSpaceListResponse,
  encodeSpaceDelete,
  decodeSpaceDeleteResponse,
  encodeSessionCreate,
  decodeSessionCreateResponse,
  encodeSessionList,
  decodeSessionListResponse,
  encodeSessionDelete,
  decodeSessionDeleteResponse,
  type AuthCredentials,
  AuthMethod,
  type AuthPayload,
  type EncodeRequest,
  type EncodeResponse,
  type EncodeVectorDirectRequest,
  encodeEncodeVectorDirect,
  type EntityCreateRequest,
  type EntityCreateResponse,
  type EntityGetRequest,
  type EntityGetResponse,
  type EntityListItem,
  type EntityListRequest,
  type EntityListResponseFrame,
  type EntityResolveRequest,
  type EntityResolveResponse,
  type ExtractorListRequest,
  type ExtractorListResponseFrame,
  type ForgetRequest,
  type ForgetResponse,
  type GetCapabilitiesResponse,
  type HelloCapabilities,
  type HelloPayload,
  type InferenceStep,
  type LinkRequest,
  type LinkResponse,
  type MaterializeProceduralRequest,
  type MaterializeProceduralResponse,
  type MemoryInspectRequest,
  type MemoryInspectResponse,
  type MemoryListItem,
  type MemoryListRequest,
  type MemoryListResponseFrame,
  type GraphNode,
  type GraphEdge,
  type GraphFetchRequest,
  type GraphFetchResponseFrame,
  type PlanRequest,
  type PlanResponseFrame,
  type PlanStep,
  type ReasonRequest,
  type ReasonResponseFrame,
  type RecallAnswer,
  type RecallRequest,
  type RecallResponseFrame,
  type RelationCreateRequest,
  type RelationCreateResponse,
  type RelationListFromRequest,
  type RelationListFromResponseFrame,
  type RelationListToRequest,
  type RelationListToResponseFrame,
  type RelationView,
  type SchemaGetRequest,
  type SchemaGetResponse,
  type SchemaListItemWire,
  type SchemaListRequest,
  type SchemaListResponseFrame,
  type CancelStreamAck,
  type CancellationReason,
  type SchemaReplaceRequest,
  type SchemaReplaceResponse,
  type SchemaUploadRequest,
  type SchemaUploadResponse,
  type SchemaValidateRequest,
  type SchemaValidateResponse,
  type ServerFeatures,
  type StatementCreateRequest,
  type StatementCreateResponse,
  type StatementGetRequest,
  type StatementGetResponse,
  type StatementListRequest,
  type StatementListResponseFrame,
  type StatementView,
  type SubscribeRequest,
  type TxnAbortRequest,
  type TxnAbortResponse,
  type TxnBeginRequest,
  type TxnBeginResponse,
  type TxnCommitRequest,
  type TxnCommitResponse,
  type UnlinkRequest,
  type UnlinkResponse,
  decodeEncodeResponse,
  decodeEntityCreateResponse,
  decodeEntityGetResponse,
  decodeEntityListResponse,
  decodeEntityResolveResponse,
  decodeExtractorListResponse,
  decodeForgetResponse,
  decodeGetCapabilitiesResponse,
  decodeLinkResponse,
  decodeMaterializeProceduralResponse,
  decodeMemoryInspectResponse,
  decodeMemoryListResponse,
  decodeGraphFetchResponse,
  decodePlanResponse,
  decodeReasonResponse,
  decodeRecallResponse,
  decodeRelationCreateResponse,
  decodeRelationListFromResponse,
  decodeRelationListToResponse,
  decodeSchemaGetResponse,
  decodeSchemaListResponse,
  decodeCancelStreamAck,
  decodeSchemaReplaceResponse,
  decodeSchemaUploadResponse,
  decodeSchemaValidateResponse,
  decodeStatementCreateResponse,
  decodeStatementGetResponse,
  decodeStatementListResponse,
  decodeTxnAbortResponse,
  decodeTxnBeginResponse,
  decodeTxnCommitResponse,
  decodeUnlinkResponse,
  encodeEncode,
  encodeEntityCreate,
  type EntityUpdateRequest,
  encodeEntityUpdate,
  type EntityRenameRequest,
  encodeEntityRename,
  type EntityViewResponse,
  decodeEntityViewResponse,
  type EntityMergeRequest,
  type EntityMergeResponse,
  encodeEntityMerge,
  decodeEntityMergeResponse,
  type EntityUnmergeRequest,
  type EntityUnmergeResponse,
  encodeEntityUnmerge,
  decodeEntityUnmergeResponse,
  type EntityTombstoneRequest,
  type EntityTombstoneResponse,
  encodeEntityTombstone,
  decodeEntityTombstoneResponse,
  type StatementSupersedeRequest,
  type StatementSupersedeResponse,
  encodeStatementSupersede,
  decodeStatementSupersedeResponse,
  type StatementReasonRequest,
  type StatementTombstoneResponse,
  type StatementRetractResponse,
  encodeStatementReason,
  decodeStatementTombstoneResponse,
  decodeStatementRetractResponse,
  type StatementHistoryRequest,
  type StatementHistoryResponseFrame,
  encodeStatementHistory,
  decodeStatementHistoryResponseFrame,
  type RelationGetRequest,
  type RelationGetResponse,
  encodeRelationGet,
  decodeRelationGetResponse,
  type RelationSupersedeRequest,
  type RelationSupersedeResponse,
  encodeRelationSupersede,
  decodeRelationSupersedeResponse,
  type RelationTombstoneRequest,
  type RelationTombstoneResponse,
  encodeRelationTombstone,
  decodeRelationTombstoneResponse,
  type RelationTraverseRequest,
  type RelationTraverseResponseFrame,
  type TraversalPathWire,
  encodeRelationTraverse,
  decodeRelationTraverseResponse,
  type QueryExplainRequest,
  type QueryExplainResponse,
  encodeQueryExplain,
  decodeQueryExplainResponse,
  type QueryTraceRequest,
  type QueryTraceResponse,
  encodeQueryTrace,
  decodeQueryTraceResponse,
  encodeEntityGet,
  encodeEntityList,
  encodeEntityResolve,
  encodeExtractorList,
  encodeForget,
  encodeGetCapabilities,
  encodeLink,
  encodeMaterializeProcedural,
  encodeMemoryInspect,
  encodeMemoryList,
  encodeGraphFetch,
  encodePlan,
  encodeReason,
  encodeRecall,
  encodeRelationCreate,
  encodeRelationListFrom,
  encodeRelationListTo,
  encodeSchemaGet,
  encodeSchemaList,
  encodeCancelStream,
  encodeSchemaReplace,
  encodeSchemaUpload,
  encodeSchemaValidate,
  encodeStatementCreate,
  encodeStatementGet,
  encodeStatementList,
  encodeTxnAbort,
  encodeTxnBegin,
  encodeTxnCommit,
  encodeUnlink,
} from "./wire/types.js";

/** Default `clientId` advertised in HELLO. */
const DEFAULT_CLIENT_ID = "brain-db-sdk-typescript";

/** Mint a fresh 16-byte identifier. */
export function newId(): Uint8Array {
  return new Uint8Array(randomBytes(16));
}

/** Root namespace UUID for space-id derivation: the 16 bytes of the ASCII
 * string `"brain-space-root"`. Must match the server's frozen seed. */
const BRAIN_ROOT_NAMESPACE_UUID = new Uint8Array([
  0x6b, 0x72, 0x61, 0x69, 0x6e, 0x2d, 0x73, 0x70, 0x61, 0x63, 0x65, 0x2d, 0x72, 0x6f, 0x6f, 0x74,
]);

/** RFC-4122 name-based UUIDv5 (SHA-1) of `name` under 16-byte `namespace`. */
function uuidV5(namespace: Uint8Array, name: Uint8Array): Uint8Array {
  const h = createHash("sha1");
  h.update(namespace);
  h.update(name);
  const d = new Uint8Array(h.digest()).subarray(0, 16);
  const out = new Uint8Array(d);
  // `noUncheckedIndexedAccess` types every index read as `T | undefined`, so
  // `out[6] & 0x0f` does not compile even though SHA-1 always yields 20 bytes
  // and this slice is always 16. Read through a non-null assertion rather than
  // widening the tsconfig — the length is a property of the digest, not
  // something the type system can see.
  out[6] = (out[6]! & 0x0f) | 0x50; // version 5
  out[8] = (out[8]! & 0x3f) | 0x80; // RFC-4122 variant
  return out;
}

/** Derive the 16-byte storage space id from a structured space string, exactly
 * as the server does at ingress: `UUIDv5(UUIDv5(ROOT, namespace), space)`.
 * Folding the namespace makes equal strings under different namespaces diverge.
 * Clients only ever *send* the space string; this is for the rare cases that
 * need the resolved id locally — e.g. a subscription filter naming the effective
 * space by its resolved id. The seed is frozen and pinned by a golden test on
 * both sides. */
export function deriveSpaceId(namespace: string, space: string): Uint8Array {
  const enc = new TextEncoder();
  const ns = uuidV5(BRAIN_ROOT_NAMESPACE_UUID, enc.encode(namespace));
  return uuidV5(ns, enc.encode(space));
}

/**
 * How the client authenticates after WELCOME. Auth is mandatory: there is no
 * anonymous mode. The credential is the connection's whole identity — the
 * server resolves `(namespace, space, permissions)` from it and refuses any
 * connection it cannot resolve.
 */
export type Auth =
  | { kind: "token"; token: Uint8Array }
  | { kind: "mtls"; certFingerprint: Uint8Array; assertedSubject: string };

function authToWire(auth: Auth): { method: AuthMethod; credentials: AuthCredentials } {
  switch (auth.kind) {
    case "token":
      return { method: AuthMethod.Token, credentials: { kind: "Token", token: auth.token } };
    case "mtls":
      return {
        method: AuthMethod.Mtls,
        credentials: {
          kind: "Mtls",
          certFingerprint: auth.certFingerprint,
          assertedSubject: auth.assertedSubject,
        },
      };
  }
}

/**
 * Connection configuration. `auth` is mandatory — the credential is the
 * connection's identity; the server assigns the agent and namespace. Every
 * other field has a local/dev-friendly default.
 */
export interface ClientConfig {
  /** How to authenticate after WELCOME. Mandatory: a connection with no
   * credential cannot exist. */
  auth: Auth;
  clientId?: string;
  supportedVersions?: number[];
  capabilities?: HelloCapabilities;
  /** Deadline for the TCP connect. Omit to wait indefinitely. */
  connectTimeoutMs?: number;
  /** Per-response read deadline. Omit to wait indefinitely. */
  requestTimeoutMs?: number;
}

interface ResolvedConfig {
  clientId: string;
  supportedVersions: number[];
  capabilities: HelloCapabilities;
  auth: Auth;
  connectTimeoutMs: number | undefined;
  requestTimeoutMs: number | undefined;
}

function withDefaults(config: ClientConfig): ResolvedConfig {
  return {
    clientId: config.clientId ?? DEFAULT_CLIENT_ID,
    supportedVersions: config.supportedVersions ?? [1],
    capabilities: config.capabilities ?? {
      streaming: true,
      compressionZstd: false,
      serverPush: false,
    },
    auth: config.auth,
    connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
  };
}

/** The connection grant the server issued at handshake time. */
export interface ConnectionInfo {
  /** 16-byte resolved space id the server assigned to this connection. */
  spaceId: Uint8Array;
  serverId: string;
  chosenVersion: number;
  /** 16-byte connection id the server minted for this handshake. */
  connectionId: Uint8Array;
  boundShardId: number;
  permissions: SpacePermissions;
  /** Owning tenant the server bound this connection to (server-derived from
   * auth). Empty when the connection resolves to the reserved `brain` system
   * namespace. Read-only — the client never sends a namespace. */
  namespace: string;
  serverFeatures: ServerFeatures;
}

/**
 * A connected, handshaken Brain client over a multiplexed connection. Verb
 * calls are concurrency-safe: many can be in flight at once over the one
 * connection.
 */
export class BrainClient {
  private constructor(
    private readonly conn: MuxConnection,
    public readonly connection: ConnectionInfo,
  ) {}

  /**
   * Connect to `host:port`, run the handshake, and resolve the bound client.
   * The `auth` credential in `config` is mandatory — the server resolves the
   * connection's identity (agent, namespace, permissions) from it.
   */
  static async connect(host: string, port: number, config: ClientConfig): Promise<BrainClient> {
    const cfg = withDefaults(config);
    const hello: HelloPayload = {
      clientId: cfg.clientId,
      supportedVersions: cfg.supportedVersions,
      capabilities: cfg.capabilities,
      clientConnectionToken: null,
    };
    const { method, credentials } = authToWire(cfg.auth);
    const auth: AuthPayload = { method, credentials };

    const { conn, outcome } = await MuxConnection.connect(host, port, hello, auth, {
      connectTimeoutMs: cfg.connectTimeoutMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    const { welcome, authOk } = outcome;
    const connection: ConnectionInfo = {
      spaceId: authOk.spaceId,
      serverId: welcome.serverId,
      chosenVersion: welcome.chosenVersion,
      connectionId: welcome.connectionId,
      boundShardId: authOk.boundShardId,
      permissions: authOk.permissions,
      namespace: authOk.namespace,
      serverFeatures: welcome.serverFeatures,
    };
    return new BrainClient(conn, connection);
  }

  /** The resolved space id this connection acts as, as the server assigned it. */
  get spaceId(): Uint8Array {
    return this.connection.spaceId;
  }

  /**
   * The owning tenant the server bound this connection to (server-derived from
   * auth). Empty string means the reserved `brain` system namespace. Read-only
   * — the client never sends a namespace.
   */
  get namespace(): string {
    return this.connection.namespace;
  }

  /**
   * Store a memory from text (ENCODE). Build the request by hand or with the
   * {@link EncodeBuilder}, which fills defaults and mints the `requestId`.
   */
  async encode(request: EncodeRequest): Promise<EncodeResponse> {
    const frame = await this.conn.requestOne(Opcode.EncodeReq, encodeEncode(request));
    if (frame.opcode !== Opcode.EncodeResp) {
      throw new ProtocolError(
        `expected ENCODE_RESP (0x${Opcode.EncodeResp.toString(16)}), got ` +
          `0x${frame.opcode.toString(16)}`,
      );
    }
    return decodeEncodeResponse(frame.payload);
  }

  /**
   * Write a pre-computed embedding directly (ENCODE_VECTOR_DIRECT), bypassing
   * the server's owned embedding model. The vector rides the trailing raw f32
   * section of the frame, not the CBOR map; the reply is an ordinary
   * {@link EncodeResponse}.
   */
  async encodeVectorDirect(request: EncodeVectorDirectRequest): Promise<EncodeResponse> {
    const frame = await this.conn.requestOne(
      Opcode.EncodeVectorDirectReq,
      encodeEncodeVectorDirect(request),
    );
    this.expect(frame.opcode, Opcode.EncodeVectorDirectResp, "ENCODE_VECTOR_DIRECT_RESP");
    return decodeEncodeResponse(frame.payload);
  }

  /**
   * Retrieve the answer for a cue. RECALL resolves to memories: `Single` for one
   * memory, `Many` for several ranked, or `None` for a "don't know" outcome.
   * RECALL streams one or more `RECALL_RESP` frames terminated by EOS; this
   * drains them, takes `answerKind` from the final frame, and concatenates every
   * frame's `memories`. For the raw streamed frames (cumulative counts,
   * `estimatedRemaining`), use {@link recallFrames}.
   */
  async recall(request: RecallRequest): Promise<RecallAnswer> {
    const frames = await this.recallFrames(request);
    const last = frames[frames.length - 1];
    return {
      answerKind: last ? last.answerKind : "None",
      memories: frames.flatMap((f) => f.memories),
    };
  }

  /**
   * Retrieve memories by cue, returning each decoded `RECALL_RESP` frame as
   * streamed (preserving `isFinal` / `cumulativeCount` / `estimatedRemaining`).
   * The last frame carries the EOS flag.
   */
  async recallFrames(request: RecallRequest): Promise<RecallResponseFrame[]> {
    const frames = await this.conn.request(Opcode.RecallReq, encodeRecall(request));
    return frames.map((frame) => {
      if (frame.opcode !== Opcode.RecallResp) {
        throw new ProtocolError(
          `expected RECALL_RESP (0x${Opcode.RecallResp.toString(16)}), got ` +
            `0x${frame.opcode.toString(16)}`,
        );
      }
      return decodeRecallResponse(frame.payload);
    });
  }

  /**
   * List memories (MEMORY_LIST), flattening every streamed frame's `items` into
   * one ordered list. A pure paginated enumeration of the caller's
   * `(namespace, agent)` memories — no query, no ranking. For the raw streamed
   * frames (cursors, cumulative counts, `isFinal`), use {@link memoryListFrames}.
   */
  async memoryList(request: MemoryListRequest): Promise<MemoryListItem[]> {
    const frames = await this.memoryListFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /**
   * List memories, returning each decoded MEMORY_LIST_RESP frame as streamed
   * (preserving `nextCursor` / `cumulativeCount` / `isFinal`).
   */
  async memoryListFrames(request: MemoryListRequest): Promise<MemoryListResponseFrame[]> {
    return this.streamed(
      Opcode.MemoryListReq,
      Opcode.MemoryListResp,
      "MEMORY_LIST_RESP",
      encodeMemoryList(request),
      decodeMemoryListResponse,
    );
  }

  /**
   * Inspect one memory's durable write-artifact bundle (MEMORY_INSPECT):
   * the embedding vector, redb record, analyzed keyword terms, write-time HyPE
   * questions, and the extracted knowledge graph. Single-shot — the reply
   * carries the whole bundle. `found = false` (with an empty `artifact`) when no
   * memory / no bundle exists for the id.
   */
  async memoryInspect(request: MemoryInspectRequest): Promise<MemoryInspectResponse> {
    const frame = await this.conn.requestOne(Opcode.MemoryInspectReq, encodeMemoryInspect(request));
    this.expect(frame.opcode, Opcode.MemoryInspectResp, "MEMORY_INSPECT_RESP");
    return decodeMemoryInspectResponse(frame.payload);
  }

  /**
   * Provision the caller's effective space explicitly (SPACE_CREATE).
   * Idempotent: a create for an existing space returns the existing row with
   * `created = false`.
   */
  async createSpace(request: SpaceCreateRequest): Promise<SpaceCreateResponse> {
    const frame = await this.conn.requestOne(Opcode.SpaceCreateReq, encodeSpaceCreate(request));
    this.expect(frame.opcode, Opcode.SpaceCreateResp, "SPACE_CREATE_RESP");
    return decodeSpaceCreateResponse(frame.payload);
  }

  /**
   * List the caller's namespace's spaces (SPACE_LIST). `crossShardComplete` is
   * `false` while the listing covers only the caller shard — treat it as a
   * partial result.
   */
  async listSpaces(request: SpaceListRequest): Promise<SpaceListResponse> {
    const frame = await this.conn.requestOne(Opcode.SpaceListReq, encodeSpaceList(request));
    this.expect(frame.opcode, Opcode.SpaceListResp, "SPACE_LIST_RESP");
    return decodeSpaceListResponse(frame.payload);
  }

  /**
   * GDPR-erase the caller's effective space (SPACE_DELETE): remove every row
   * under `(namespace, space)`. Hard and immediate.
   */
  async deleteSpace(request: SpaceDeleteRequest): Promise<SpaceDeleteResponse> {
    const frame = await this.conn.requestOne(Opcode.SpaceDeleteReq, encodeSpaceDelete(request));
    this.expect(frame.opcode, Opcode.SpaceDeleteResp, "SPACE_DELETE_RESP");
    return decodeSpaceDeleteResponse(frame.payload);
  }

  /**
   * Provision a session under the caller's effective space (SESSION_CREATE).
   * Idempotent: a create for an existing session returns the existing row with
   * `created = false`.
   */
  async createSession(request: SessionCreateRequest): Promise<SessionCreateResponse> {
    const frame = await this.conn.requestOne(Opcode.SessionCreateReq, encodeSessionCreate(request));
    this.expect(frame.opcode, Opcode.SessionCreateResp, "SESSION_CREATE_RESP");
    return decodeSessionCreateResponse(frame.payload);
  }

  /**
   * List one `(namespace, space)`'s sessions newest-first (SESSION_LIST).
   * A first-class end-user feature for enumerating a space's conversations/runs.
   */
  async listSessions(request: SessionListRequest): Promise<SessionListResponse> {
    const frame = await this.conn.requestOne(Opcode.SessionListReq, encodeSessionList(request));
    this.expect(frame.opcode, Opcode.SessionListResp, "SESSION_LIST_RESP");
    return decodeSessionListResponse(frame.payload);
  }

  /**
   * Remove a session's memories + graph rows (SESSION_DELETE). Defaults to soft
   * (7-day grace); set `hard = true` to zero immediately. The default session
   * (`sessionId = 0`) is non-deletable.
   */
  async deleteSession(request: SessionDeleteRequest): Promise<SessionDeleteResponse> {
    const frame = await this.conn.requestOne(Opcode.SessionDeleteReq, encodeSessionDelete(request));
    this.expect(frame.opcode, Opcode.SessionDeleteResp, "SESSION_DELETE_RESP");
    return decodeSessionDeleteResponse(frame.payload);
  }

  /**
   * Export the caller's typed graph (GRAPH_FETCH), flattening every streamed
   * frame's nodes + edges into two ordered lists. Nodes/edges may repeat across
   * pages (completeness, not disjointness) — dedup by id if needed. For the raw
   * streamed frames (cursors, `isFinal`), use {@link graphFetchFrames}.
   */
  async graphFetch(
    request: GraphFetchRequest,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const frames = await this.graphFetchFrames(request);
    return {
      nodes: frames.flatMap((f) => f.nodes),
      edges: frames.flatMap((f) => f.edges),
    };
  }

  /**
   * Export the typed graph, returning each decoded GRAPH_FETCH_RESP frame as
   * streamed (preserving `nextCursor` / `isFinal`).
   */
  async graphFetchFrames(request: GraphFetchRequest): Promise<GraphFetchResponseFrame[]> {
    return this.streamed(
      Opcode.GraphFetchReq,
      Opcode.GraphFetchResp,
      "GRAPH_FETCH_RESP",
      encodeGraphFetch(request),
      decodeGraphFetchResponse,
    );
  }

  /** Forget a memory (soft tombstone or hard zeroing, per the request). */
  async forget(request: ForgetRequest): Promise<ForgetResponse> {
    const frame = await this.conn.requestOne(Opcode.ForgetReq, encodeForget(request));
    if (frame.opcode !== Opcode.ForgetResp) {
      throw new ProtocolError(
        `expected FORGET_RESP (0x${Opcode.ForgetResp.toString(16)}), got ` +
          `0x${frame.opcode.toString(16)}`,
      );
    }
    return decodeForgetResponse(frame.payload);
  }

  /** Create a typed entity (ENTITY_CREATE). */
  async createEntity(request: EntityCreateRequest): Promise<EntityCreateResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityCreateReq, encodeEntityCreate(request));
    this.expect(frame.opcode, Opcode.EntityCreateResp, "ENTITY_CREATE_RESP");
    return decodeEntityCreateResponse(frame.payload);
  }

  /**
   * Create a statement (STATEMENT_CREATE). The response reports any
   * auto-superseded prior statement and the supersession chain root.
   */
  async createStatement(request: StatementCreateRequest): Promise<StatementCreateResponse> {
    const frame = await this.conn.requestOne(
      Opcode.StatementCreateReq,
      encodeStatementCreate(request),
    );
    this.expect(frame.opcode, Opcode.StatementCreateResp, "STATEMENT_CREATE_RESP");
    return decodeStatementCreateResponse(frame.payload);
  }

  /** Replace an entity's name, aliases, and attributes (ENTITY_UPDATE). */
  async updateEntity(request: EntityUpdateRequest): Promise<EntityViewResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityUpdateReq, encodeEntityUpdate(request));
    this.expect(frame.opcode, Opcode.EntityUpdateResp, "ENTITY_UPDATE_RESP");
    return decodeEntityViewResponse(frame.payload);
  }

  /** Rename an entity, optionally keeping the old name as an alias (ENTITY_RENAME). */
  async renameEntity(request: EntityRenameRequest): Promise<EntityViewResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityRenameReq, encodeEntityRename(request));
    this.expect(frame.opcode, Opcode.EntityRenameResp, "ENTITY_RENAME_RESP");
    return decodeEntityViewResponse(frame.payload);
  }

  /**
   * Merge two entities that are the same real-world thing (ENTITY_MERGE).
   * Reversible within the returned grace window via {@link unmergeEntity}.
   */
  async mergeEntities(request: EntityMergeRequest): Promise<EntityMergeResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityMergeReq, encodeEntityMerge(request));
    this.expect(frame.opcode, Opcode.EntityMergeResp, "ENTITY_MERGE_RESP");
    return decodeEntityMergeResponse(frame.payload);
  }

  /** Undo a merge within its grace window (ENTITY_UNMERGE). */
  async unmergeEntity(request: EntityUnmergeRequest): Promise<EntityUnmergeResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityUnmergeReq, encodeEntityUnmerge(request));
    this.expect(frame.opcode, Opcode.EntityUnmergeResp, "ENTITY_UNMERGE_RESP");
    return decodeEntityUnmergeResponse(frame.payload);
  }

  /**
   * Retire an entity with an audit reason (ENTITY_TOMBSTONE). Soft: the row
   * survives but drops out of resolution and traversal.
   */
  async tombstoneEntity(request: EntityTombstoneRequest): Promise<EntityTombstoneResponse> {
    const frame = await this.conn.requestOne(
      Opcode.EntityTombstoneReq,
      encodeEntityTombstone(request),
    );
    this.expect(frame.opcode, Opcode.EntityTombstoneResp, "ENTITY_TOMBSTONE_RESP");
    return decodeEntityTombstoneResponse(frame.payload);
  }

  /**
   * Replace a statement with a revised one (STATEMENT_SUPERSEDE), keeping both
   * on the same chain so history is preserved.
   */
  async supersedeStatement(
    request: StatementSupersedeRequest,
  ): Promise<StatementSupersedeResponse> {
    const frame = await this.conn.requestOne(
      Opcode.StatementSupersedeReq,
      encodeStatementSupersede(request),
    );
    this.expect(frame.opcode, Opcode.StatementSupersedeResp, "STATEMENT_SUPERSEDE_RESP");
    return decodeStatementSupersedeResponse(frame.payload);
  }

  /** Retire a statement with a coded reason (STATEMENT_TOMBSTONE). Recoverable. */
  async tombstoneStatement(request: StatementReasonRequest): Promise<StatementTombstoneResponse> {
    const frame = await this.conn.requestOne(
      Opcode.StatementTombstoneReq,
      encodeStatementReason(request),
    );
    this.expect(frame.opcode, Opcode.StatementTombstoneResp, "STATEMENT_TOMBSTONE_RESP");
    return decodeStatementTombstoneResponse(frame.payload);
  }

  /**
   * Assert a statement was wrong (STATEMENT_RETRACT). Unlike a tombstone,
   * retraction schedules a hard-zero so a genuine mistake gets scrubbed.
   */
  async retractStatement(request: StatementReasonRequest): Promise<StatementRetractResponse> {
    const frame = await this.conn.requestOne(
      Opcode.StatementRetractReq,
      encodeStatementReason(request),
    );
    this.expect(frame.opcode, Opcode.StatementRetractResp, "STATEMENT_RETRACT_RESP");
    return decodeStatementRetractResponse(frame.payload);
  }

  /**
   * Walk a claim's full version chain (STATEMENT_HISTORY), flattening every
   * streamed frame's `items`. For the raw frames, use {@link statementHistoryFrames}.
   */
  async statementHistory(request: StatementHistoryRequest): Promise<StatementView[]> {
    const frames = await this.statementHistoryFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** Walk a claim's version chain, returning each decoded STATEMENT_HISTORY frame. */
  async statementHistoryFrames(
    request: StatementHistoryRequest,
  ): Promise<StatementHistoryResponseFrame[]> {
    return this.streamed(
      Opcode.StatementHistoryReq,
      Opcode.StatementHistoryResp,
      "STATEMENT_HISTORY_RESP",
      encodeStatementHistory(request),
      decodeStatementHistoryResponseFrame,
    );
  }

  /** Create a relation between two entities (RELATION_CREATE). */
  async createRelation(request: RelationCreateRequest): Promise<RelationCreateResponse> {
    const frame = await this.conn.requestOne(
      Opcode.RelationCreateReq,
      encodeRelationCreate(request),
    );
    this.expect(frame.opcode, Opcode.RelationCreateResp, "RELATION_CREATE_RESP");
    return decodeRelationCreateResponse(frame.payload);
  }

  /**
   * Fetch one relation by id (RELATION_GET). With `followSupersession` set, the
   * server returns the current chain head when the id has been superseded.
   */
  async getRelation(request: RelationGetRequest): Promise<RelationGetResponse> {
    const frame = await this.conn.requestOne(Opcode.RelationGetReq, encodeRelationGet(request));
    this.expect(frame.opcode, Opcode.RelationGetResp, "RELATION_GET_RESP");
    return decodeRelationGetResponse(frame.payload);
  }

  /**
   * Revise a relation with a new one (RELATION_SUPERSEDE), keeping both on the
   * same chain so history is preserved.
   */
  async supersedeRelation(request: RelationSupersedeRequest): Promise<RelationSupersedeResponse> {
    const frame = await this.conn.requestOne(
      Opcode.RelationSupersedeReq,
      encodeRelationSupersede(request),
    );
    this.expect(frame.opcode, Opcode.RelationSupersedeResp, "RELATION_SUPERSEDE_RESP");
    return decodeRelationSupersedeResponse(frame.payload);
  }

  /**
   * Soft-retire a relation with an audit reason (RELATION_TOMBSTONE). The row
   * survives but drops out of traversal.
   */
  async tombstoneRelation(request: RelationTombstoneRequest): Promise<RelationTombstoneResponse> {
    const frame = await this.conn.requestOne(
      Opcode.RelationTombstoneReq,
      encodeRelationTombstone(request),
    );
    this.expect(frame.opcode, Opcode.RelationTombstoneResp, "RELATION_TOMBSTONE_RESP");
    return decodeRelationTombstoneResponse(frame.payload);
  }

  /**
   * Multi-hop walk of the relation graph from an entity (RELATION_TRAVERSE),
   * flattening every streamed frame's `paths`. For the raw frames (with
   * `truncated` / `totalPaths`), use {@link traverseRelationsFrames}.
   */
  async traverseRelations(request: RelationTraverseRequest): Promise<TraversalPathWire[]> {
    const frames = await this.traverseRelationsFrames(request);
    return frames.flatMap((f) => f.paths);
  }

  /** Traverse the relation graph, returning each decoded RELATION_TRAVERSE frame. */
  async traverseRelationsFrames(
    request: RelationTraverseRequest,
  ): Promise<RelationTraverseResponseFrame[]> {
    return this.streamed(
      Opcode.RelationTraverseReq,
      Opcode.RelationTraverseResp,
      "RELATION_TRAVERSE_RESP",
      encodeRelationTraverse(request),
      decodeRelationTraverseResponse,
    );
  }

  /**
   * Upload a schema document (SCHEMA_UPLOAD). With `dryRun` set the server
   * validates without applying; the response carries any validation errors and
   * a backward-compatibility verdict.
   */
  async uploadSchema(request: SchemaUploadRequest): Promise<SchemaUploadResponse> {
    const frame = await this.conn.requestOne(Opcode.SchemaUploadReq, encodeSchemaUpload(request));
    this.expect(frame.opcode, Opcode.SchemaUploadResp, "SCHEMA_UPLOAD_RESP");
    return decodeSchemaUploadResponse(frame.payload);
  }

  /** Return a query's plan without running it (QUERY_EXPLAIN). */
  async queryExplain(request: QueryExplainRequest): Promise<QueryExplainResponse> {
    const frame = await this.conn.requestOne(Opcode.QueryExplainReq, encodeQueryExplain(request));
    this.expect(frame.opcode, Opcode.QueryExplainResp, "QUERY_EXPLAIN_RESP");
    return decodeQueryExplainResponse(frame.payload);
  }

  /** Run a query and return its per-stage execution trace (QUERY_TRACE). */
  async queryTrace(request: QueryTraceRequest): Promise<QueryTraceResponse> {
    const frame = await this.conn.requestOne(Opcode.QueryTraceReq, encodeQueryTrace(request));
    this.expect(frame.opcode, Opcode.QueryTraceResp, "QUERY_TRACE_RESP");
    return decodeQueryTraceResponse(frame.payload);
  }

  /** Materialize a procedural-memory system block (MATERIALIZE_PROCEDURAL). */
  async materializeProcedural(
    request: MaterializeProceduralRequest,
  ): Promise<MaterializeProceduralResponse> {
    const frame = await this.conn.requestOne(
      Opcode.MaterializeProceduralReq,
      encodeMaterializeProcedural(request),
    );
    this.expect(frame.opcode, Opcode.MaterializeProceduralResp, "MATERIALIZE_PROCEDURAL_RESP");
    return decodeMaterializeProceduralResponse(frame.payload);
  }

  /** Create or reweight an edge between two memories (LINK). */
  async link(request: LinkRequest): Promise<LinkResponse> {
    const frame = await this.conn.requestOne(Opcode.LinkReq, encodeLink(request));
    this.expect(frame.opcode, Opcode.LinkResp, "LINK_RESP");
    return decodeLinkResponse(frame.payload);
  }

  /** Remove an edge identified by `(source, kind, target)` (UNLINK). Idempotent. */
  async unlink(request: UnlinkRequest): Promise<UnlinkResponse> {
    const frame = await this.conn.requestOne(Opcode.UnlinkReq, encodeUnlink(request));
    this.expect(frame.opcode, Opcode.UnlinkResp, "UNLINK_RESP");
    return decodeUnlinkResponse(frame.payload);
  }

  /**
   * Introspect the connected shard's live capabilities (GET_CAPABILITIES):
   * whether the reranker is loaded, which extractor tiers are enabled, the
   * active user schema namespaces, and the embedding dimensionality.
   */
  async capabilities(): Promise<GetCapabilitiesResponse> {
    const frame = await this.conn.requestOne(Opcode.GetCapabilitiesReq, encodeGetCapabilities({}));
    this.expect(frame.opcode, Opcode.GetCapabilitiesResp, "GET_CAPABILITIES_RESP");
    return decodeGetCapabilitiesResponse(frame.payload);
  }

  /**
   * List the always-on extractors registered on the connected shard
   * (EXTRACTOR_LIST). Read-only introspection: extraction is always-on, so
   * there is no enable/disable and the request takes no arguments. Each row
   * carries the extractor's id, namespace, name, tier kind, schema version, and
   * creation timestamp.
   */
  async extractorList(request: ExtractorListRequest = {}): Promise<ExtractorListResponseFrame> {
    const frame = await this.conn.requestOne(Opcode.ExtractorListReq, encodeExtractorList(request));
    this.expect(frame.opcode, Opcode.ExtractorListResp, "EXTRACTOR_LIST_RESP");
    return decodeExtractorListResponse(frame.payload);
  }

  /** Fetch one entity by id (ENTITY_GET). */
  async getEntity(request: EntityGetRequest): Promise<EntityGetResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityGetReq, encodeEntityGet(request));
    this.expect(frame.opcode, Opcode.EntityGetResp, "ENTITY_GET_RESP");
    return decodeEntityGetResponse(frame.payload);
  }

  /**
   * Resolve a candidate name to an entity (ENTITY_RESOLVE). The server
   * currently requires `entityTypeHint !== 0` and resolves by exact canonical
   * name; `allowCreate` lets it mint a new entity on a miss.
   */
  async resolveEntity(request: EntityResolveRequest): Promise<EntityResolveResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityResolveReq, encodeEntityResolve(request));
    this.expect(frame.opcode, Opcode.EntityResolveResp, "ENTITY_RESOLVE_RESP");
    return decodeEntityResolveResponse(frame.payload);
  }

  /**
   * Fetch one statement by id (STATEMENT_GET). With `followSupersession` set,
   * the server may redirect to the current entry in the chain.
   */
  async getStatement(request: StatementGetRequest): Promise<StatementGetResponse> {
    const frame = await this.conn.requestOne(Opcode.StatementGetReq, encodeStatementGet(request));
    this.expect(frame.opcode, Opcode.StatementGetResp, "STATEMENT_GET_RESP");
    return decodeStatementGetResponse(frame.payload);
  }

  /** Fetch one schema version (SCHEMA_GET). `version === 0` selects the active. */
  async getSchema(request: SchemaGetRequest): Promise<SchemaGetResponse> {
    const frame = await this.conn.requestOne(Opcode.SchemaGetReq, encodeSchemaGet(request));
    this.expect(frame.opcode, Opcode.SchemaGetResp, "SCHEMA_GET_RESP");
    return decodeSchemaGetResponse(frame.payload);
  }

  /** Validate a schema document without persisting it (SCHEMA_VALIDATE). */
  async validateSchema(request: SchemaValidateRequest): Promise<SchemaValidateResponse> {
    const frame = await this.conn.requestOne(
      Opcode.SchemaValidateReq,
      encodeSchemaValidate(request),
    );
    this.expect(frame.opcode, Opcode.SchemaValidateResp, "SCHEMA_VALIDATE_RESP");
    return decodeSchemaValidateResponse(frame.payload);
  }

  /**
   * Replace a namespace's schema wholesale (SCHEMA_REPLACE).
   *
   * DESTRUCTIVE. Every declared row in the namespace is dropped before the new
   * document lands; entities whose type disappears survive as orphans,
   * readable as plain memories but no longer enriched from the typed-graph
   * tables. Use {@link uploadSchema} for the additive, versioned path — this is
   * for when the shape itself is wrong.
   *
   * `forceDropExisting` must be `true`; the server rejects `false` with
   * `InvalidRequest`.
   */
  async replaceSchema(request: SchemaReplaceRequest): Promise<SchemaReplaceResponse> {
    const frame = await this.conn.requestOne(Opcode.SchemaReplaceReq, encodeSchemaReplace(request));
    this.expect(frame.opcode, Opcode.SchemaReplaceResp, "SCHEMA_REPLACE_RESP");
    return decodeSchemaReplaceResponse(frame.payload);
  }

  /**
   * Cancel an in-flight stream (CANCEL_STREAM).
   *
   * `targetStreamId` is the id of the stream to stop — the `*Frames` methods
   * expose it. The request travels on its OWN stream id, so it does not queue
   * behind the frames it is cancelling; the server replies CANCEL_STREAM_ACK
   * and stops emitting for the target.
   *
   * Without this, a consumer that abandons a streamed `recall` leaves the
   * server producing frames nobody reads.
   *
   * Cancelling a stream that already finished is not an error — the server
   * acknowledges regardless, so a racing consumer needn't coordinate with the
   * reader loop.
   */
  async cancelStream(
    targetStreamId: number,
    reason: CancellationReason = "ClientUnneeded",
  ): Promise<CancelStreamAck> {
    const frame = await this.conn.requestOne(
      Opcode.CancelStream,
      encodeCancelStream({ targetStreamId, reason }),
    );
    this.expect(frame.opcode, Opcode.CancelStreamAck, "CANCEL_STREAM_ACK");
    return decodeCancelStreamAck(frame.payload);
  }

  /** Begin a transaction (TXN_BEGIN). The client mints `txnId`. */
  async txnBegin(request: TxnBeginRequest): Promise<TxnBeginResponse> {
    const frame = await this.conn.requestOne(Opcode.TxnBegin, encodeTxnBegin(request));
    this.expect(frame.opcode, Opcode.TxnBeginResp, "TXN_BEGIN_RESP");
    return decodeTxnBeginResponse(frame.payload);
  }

  /** Commit a transaction (TXN_COMMIT). */
  async txnCommit(request: TxnCommitRequest): Promise<TxnCommitResponse> {
    const frame = await this.conn.requestOne(Opcode.TxnCommit, encodeTxnCommit(request));
    this.expect(frame.opcode, Opcode.TxnCommitResp, "TXN_COMMIT_RESP");
    return decodeTxnCommitResponse(frame.payload);
  }

  /** Abort a transaction (TXN_ABORT), discarding its buffered operations. */
  async txnAbort(request: TxnAbortRequest): Promise<TxnAbortResponse> {
    const frame = await this.conn.requestOne(Opcode.TxnAbort, encodeTxnAbort(request));
    this.expect(frame.opcode, Opcode.TxnAbortResp, "TXN_ABORT_RESP");
    return decodeTxnAbortResponse(frame.payload);
  }

  /**
   * Plan a path from `start` to `goal` (PLAN), flattening every streamed
   * frame's `steps` into one ordered list. For the raw frames (`isFinal`,
   * terminal `planStatus`), use {@link planFrames}.
   */
  async plan(request: PlanRequest): Promise<PlanStep[]> {
    const frames = await this.planFrames(request);
    return frames.flatMap((f) => f.steps);
  }

  /** Plan a path, returning each decoded PLAN_RESP frame. */
  async planFrames(request: PlanRequest): Promise<PlanResponseFrame[]> {
    return this.streamed(
      Opcode.PlanReq,
      Opcode.PlanResp,
      "PLAN_RESP",
      encodePlan(request),
      decodePlanResponse,
    );
  }

  /**
   * Reason about an observation (REASON), flattening every streamed frame's
   * `inferences`. For the raw frames, use {@link reasonFrames}.
   */
  async reason(request: ReasonRequest): Promise<InferenceStep[]> {
    const frames = await this.reasonFrames(request);
    return frames.flatMap((f) => f.inferences);
  }

  /** Reason about an observation, returning each decoded REASON_RESP frame. */
  async reasonFrames(request: ReasonRequest): Promise<ReasonResponseFrame[]> {
    return this.streamed(
      Opcode.ReasonReq,
      Opcode.ReasonResp,
      "REASON_RESP",
      encodeReason(request),
      decodeReasonResponse,
    );
  }

  /**
   * List entities (ENTITY_LIST), flattening every streamed frame's `items`.
   * For the raw frames (cursors, cumulative counts), use {@link listEntitiesFrames}.
   */
  async listEntities(request: EntityListRequest): Promise<EntityListItem[]> {
    const frames = await this.listEntitiesFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** List entities, returning each decoded ENTITY_LIST_RESP frame. */
  async listEntitiesFrames(request: EntityListRequest): Promise<EntityListResponseFrame[]> {
    return this.streamed(
      Opcode.EntityListReq,
      Opcode.EntityListResp,
      "ENTITY_LIST_RESP",
      encodeEntityList(request),
      decodeEntityListResponse,
    );
  }

  /** List statements (STATEMENT_LIST), flattening every frame's `items`. */
  async listStatements(request: StatementListRequest): Promise<StatementView[]> {
    const frames = await this.listStatementsFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** List statements, returning each decoded STATEMENT_LIST_RESP frame. */
  async listStatementsFrames(request: StatementListRequest): Promise<StatementListResponseFrame[]> {
    return this.streamed(
      Opcode.StatementListReq,
      Opcode.StatementListResp,
      "STATEMENT_LIST_RESP",
      encodeStatementList(request),
      decodeStatementListResponse,
    );
  }

  /** List relations from an entity (RELATION_LIST_FROM), flattening `items`. */
  async listRelationsFrom(request: RelationListFromRequest): Promise<RelationView[]> {
    const frames = await this.listRelationsFromFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** List relations from an entity, returning each decoded frame. */
  async listRelationsFromFrames(
    request: RelationListFromRequest,
  ): Promise<RelationListFromResponseFrame[]> {
    return this.streamed(
      Opcode.RelationListFromReq,
      Opcode.RelationListFromResp,
      "RELATION_LIST_FROM_RESP",
      encodeRelationListFrom(request),
      decodeRelationListFromResponse,
    );
  }

  /** List relations to an entity (RELATION_LIST_TO), flattening `items`. */
  async listRelationsTo(request: RelationListToRequest): Promise<RelationView[]> {
    const frames = await this.listRelationsToFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** List relations to an entity, returning each decoded frame. */
  async listRelationsToFrames(
    request: RelationListToRequest,
  ): Promise<RelationListToResponseFrame[]> {
    return this.streamed(
      Opcode.RelationListToReq,
      Opcode.RelationListToResp,
      "RELATION_LIST_TO_RESP",
      encodeRelationListTo(request),
      decodeRelationListToResponse,
    );
  }

  /** List schema versions in a namespace (SCHEMA_LIST), flattening `items`. */
  async listSchemas(request: SchemaListRequest): Promise<SchemaListItemWire[]> {
    const frames = await this.listSchemasFrames(request);
    return frames.flatMap((f) => f.items);
  }

  /** List schema versions, returning each decoded SCHEMA_LIST_RESP frame. */
  async listSchemasFrames(request: SchemaListRequest): Promise<SchemaListResponseFrame[]> {
    return this.streamed(
      Opcode.SchemaListReq,
      Opcode.SchemaListResp,
      "SCHEMA_LIST_RESP",
      encodeSchemaList(request),
      decodeSchemaListResponse,
    );
  }

  /**
   * Open a long-lived change-feed subscription (SUBSCRIBE). Returns a
   * {@link Subscription} the caller drains with `nextEvent()` (or `for await`);
   * call `unsubscribe()` for a clean teardown.
   */
  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    return this.conn.subscribe(request);
  }

  /**
   * Send a request and decode every streamed response frame up to and including
   * EOS, asserting each frame's opcode. The shape every LIST/streamed verb's
   * `*Frames` method shares (mirrors {@link recallFrames}).
   */
  private async streamed<T>(
    reqOpcode: number,
    respOpcode: number,
    respName: string,
    payload: Uint8Array,
    decode: (b: Uint8Array) => T,
  ): Promise<T[]> {
    const frames = await this.conn.request(reqOpcode, payload);
    return frames.map((frame: Frame) => {
      this.expect(frame.opcode, respOpcode, respName);
      return decode(frame.payload);
    });
  }

  /** Assert a response carried the expected opcode, else a protocol error. */
  private expect(got: number, want: number, name: string): void {
    if (got !== want) {
      throw new ProtocolError(
        `expected ${name} (0x${want.toString(16)}), got 0x${got.toString(16)}`,
      );
    }
  }

  /** Send BYE and close the socket. */
  async close(): Promise<void> {
    try {
      await this.conn.sendBye();
    } finally {
      this.conn.close();
    }
  }
}
