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

import { randomBytes } from "node:crypto";

import { ProtocolError } from "./errors.js";
import { MuxConnection, type Subscription } from "./mux.js";
import type { Frame } from "./wire/frame.js";
import { Opcode } from "./wire/opcode.js";
import {
  type AgentPermissions,
  type AuthCredentials,
  AuthMethod,
  type AuthPayload,
  type EncodeRequest,
  type EncodeResponse,
  type EntityCreateRequest,
  type EntityCreateResponse,
  type EntityGetRequest,
  type EntityGetResponse,
  type EntityListItem,
  type EntityListRequest,
  type EntityListResponseFrame,
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
  type MemoryResult,
  type PlanRequest,
  type PlanResponseFrame,
  type PlanStep,
  type QueryRequest,
  type QueryResponse,
  type ReasonRequest,
  type ReasonResponseFrame,
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
  decodeForgetResponse,
  decodeGetCapabilitiesResponse,
  decodeLinkResponse,
  decodeMaterializeProceduralResponse,
  decodePlanResponse,
  decodeQueryResponse,
  decodeReasonResponse,
  decodeRecallResponse,
  decodeRelationCreateResponse,
  decodeRelationListFromResponse,
  decodeRelationListToResponse,
  decodeSchemaGetResponse,
  decodeSchemaListResponse,
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
  encodeEntityGet,
  encodeEntityList,
  encodeForget,
  encodeGetCapabilities,
  encodeLink,
  encodeMaterializeProcedural,
  encodePlan,
  encodeQuery,
  encodeReason,
  encodeRecall,
  encodeRelationCreate,
  encodeRelationListFrom,
  encodeRelationListTo,
  encodeSchemaGet,
  encodeSchemaList,
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

/** How the client authenticates after WELCOME. */
export type Auth =
  | { kind: "anonymous" }
  | { kind: "token"; token: Uint8Array }
  | { kind: "mtls"; certFingerprint: Uint8Array; assertedSubject: string };

function authToWire(auth: Auth): { method: AuthMethod; credentials: AuthCredentials } {
  switch (auth.kind) {
    case "anonymous":
      return { method: AuthMethod.None, credentials: { kind: "None" } };
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

/** Connection configuration; every field has a local/dev-friendly default. */
export interface ClientConfig {
  clientId?: string;
  /** The agent this connection acts as. Defaults to a fresh random id. */
  agentId?: Uint8Array;
  supportedVersions?: number[];
  capabilities?: HelloCapabilities;
  auth?: Auth;
  /** Deadline for the TCP connect. Omit to wait indefinitely. */
  connectTimeoutMs?: number;
  /** Per-response read deadline. Omit to wait indefinitely. */
  requestTimeoutMs?: number;
}

interface ResolvedConfig {
  clientId: string;
  agentId: Uint8Array;
  supportedVersions: number[];
  capabilities: HelloCapabilities;
  auth: Auth;
  connectTimeoutMs: number | undefined;
  requestTimeoutMs: number | undefined;
}

function withDefaults(config: ClientConfig): ResolvedConfig {
  return {
    clientId: config.clientId ?? DEFAULT_CLIENT_ID,
    agentId: config.agentId ?? newId(),
    supportedVersions: config.supportedVersions ?? [1],
    capabilities:
      config.capabilities ?? { streaming: true, compressionZstd: false, serverPush: false },
    auth: config.auth ?? { kind: "anonymous" },
    connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
  };
}

/** The session the server granted at handshake time. */
export interface SessionInfo {
  agentId: Uint8Array;
  serverId: string;
  chosenVersion: number;
  sessionId: Uint8Array;
  boundShardId: number;
  permissions: AgentPermissions;
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
    public readonly session: SessionInfo,
  ) {}

  /** Connect to `host:port`, run the handshake, and resolve the bound client. */
  static async connect(
    host: string,
    port: number,
    config: ClientConfig = {},
  ): Promise<BrainClient> {
    const cfg = withDefaults(config);
    const hello: HelloPayload = {
      clientId: cfg.clientId,
      supportedVersions: cfg.supportedVersions,
      capabilities: cfg.capabilities,
      clientSessionToken: null,
    };
    const { method, credentials } = authToWire(cfg.auth);
    const auth: AuthPayload = { method, agentId: cfg.agentId, credentials };

    const { conn, outcome } = await MuxConnection.connect(host, port, hello, auth, {
      connectTimeoutMs: cfg.connectTimeoutMs,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    const { welcome, authOk } = outcome;
    const session: SessionInfo = {
      agentId: authOk.agentId,
      serverId: welcome.serverId,
      chosenVersion: welcome.chosenVersion,
      sessionId: welcome.sessionId,
      boundShardId: authOk.boundShardId,
      permissions: authOk.permissions,
      serverFeatures: welcome.serverFeatures,
    };
    return new BrainClient(conn, session);
  }

  /** The agent id this connection acts as. */
  get agentId(): Uint8Array {
    return this.session.agentId;
  }

  /**
   * Store a memory from text. A minimal typed round-trip over the connection;
   * the ergonomic request builder lands in a later phase.
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
   * Retrieve memories by cue. RECALL streams one or more `RECALL_RESP` frames
   * terminated by EOS; this collects them and flattens every frame's `results`
   * into one ordered list. For the raw streamed frames (cumulative counts,
   * `estimatedRemaining`), use {@link recallFrames}.
   */
  async recall(request: RecallRequest): Promise<MemoryResult[]> {
    const frames = await this.recallFrames(request);
    return frames.flatMap((f) => f.results);
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
   * Upload a schema document (SCHEMA_UPLOAD). With `dryRun` set the server
   * validates without applying; the response carries any validation errors and
   * a backward-compatibility verdict.
   */
  async uploadSchema(request: SchemaUploadRequest): Promise<SchemaUploadResponse> {
    const frame = await this.conn.requestOne(Opcode.SchemaUploadReq, encodeSchemaUpload(request));
    this.expect(frame.opcode, Opcode.SchemaUploadResp, "SCHEMA_UPLOAD_RESP");
    return decodeSchemaUploadResponse(frame.payload);
  }

  /**
   * Run a hybrid typed-graph query (QUERY). Returns fused, ranked results with
   * per-retriever contributions and outcome diagnostics.
   */
  async query(request: QueryRequest): Promise<QueryResponse> {
    const frame = await this.conn.requestOne(Opcode.QueryReq, encodeQuery(request));
    this.expect(frame.opcode, Opcode.QueryResp, "QUERY_RESP");
    return decodeQueryResponse(frame.payload);
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
    const frame = await this.conn.requestOne(
      Opcode.GetCapabilitiesReq,
      encodeGetCapabilities({}),
    );
    this.expect(frame.opcode, Opcode.GetCapabilitiesResp, "GET_CAPABILITIES_RESP");
    return decodeGetCapabilitiesResponse(frame.payload);
  }

  /** Fetch one entity by id (ENTITY_GET). */
  async getEntity(request: EntityGetRequest): Promise<EntityGetResponse> {
    const frame = await this.conn.requestOne(Opcode.EntityGetReq, encodeEntityGet(request));
    this.expect(frame.opcode, Opcode.EntityGetResp, "ENTITY_GET_RESP");
    return decodeEntityGetResponse(frame.payload);
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
  async listStatementsFrames(
    request: StatementListRequest,
  ): Promise<StatementListResponseFrame[]> {
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
