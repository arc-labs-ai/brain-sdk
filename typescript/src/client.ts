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
import { MuxConnection } from "./mux.js";
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
  type ForgetRequest,
  type ForgetResponse,
  type HelloCapabilities,
  type HelloPayload,
  type MaterializeProceduralRequest,
  type MaterializeProceduralResponse,
  type MemoryResult,
  type QueryRequest,
  type QueryResponse,
  type RecallRequest,
  type RecallResponseFrame,
  type RelationCreateRequest,
  type RelationCreateResponse,
  type SchemaUploadRequest,
  type SchemaUploadResponse,
  type ServerFeatures,
  type StatementCreateRequest,
  type StatementCreateResponse,
  decodeEncodeResponse,
  decodeEntityCreateResponse,
  decodeForgetResponse,
  decodeMaterializeProceduralResponse,
  decodeQueryResponse,
  decodeRecallResponse,
  decodeRelationCreateResponse,
  decodeSchemaUploadResponse,
  decodeStatementCreateResponse,
  encodeEncode,
  encodeEntityCreate,
  encodeForget,
  encodeMaterializeProcedural,
  encodeQuery,
  encodeRecall,
  encodeRelationCreate,
  encodeSchemaUpload,
  encodeStatementCreate,
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
