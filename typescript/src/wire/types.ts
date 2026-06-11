/**
 * Typed wire payloads for the handshake, the v1 verbs, and the typed-graph ops
 * the conformance corpus exercises.
 *
 * Each payload has an explicit encoder that emits CBOR map fields in
 * declaration order, because CBOR struct encoding is field-order sensitive and
 * the corpus pins it byte-for-byte. The encoders build the value-model tree
 * (ordered Map, Uint8Array for ids, F32/F64 for floats, BigInt for u128 and
 * wide u64 fields); the decoders read a `cborg`-decoded object back into the
 * typed shape.
 *
 * Field conventions on the wire:
 *   - 16-byte ids are CBOR byte strings -> `Uint8Array`.
 *   - enums are integer discriminants, except `StatementKind`, which is a
 *     variant-name text string.
 *   - the embedding vector rides a trailing raw f32 section, never the CBOR.
 */

import {
  f32,
  f64,
  toCbor,
  fromCbor,
  fromCborPrefix,
  f32ToLeBytes,
  leBytesToF32,
  CborError,
} from "./cbor.js";

// ---------------------------------------------------------------------------
// Wire id helpers.
// ---------------------------------------------------------------------------

/** 16-byte UUID-shaped identifier (agent id, request id, statement id, ...). */
export type WireUuid = Uint8Array;

function field(map: Map<string, unknown>, name: string): unknown {
  if (!map.has(name)) throw new CborError(`missing field: ${name}`);
  return map.get(name);
}

function asMap(value: unknown): Map<string, unknown> {
  if (value instanceof Map) return value;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    return new Map(Object.entries(value as object));
  }
  throw new CborError("expected a CBOR map");
}

function asBytes(value: unknown): Uint8Array {
  // The CBOR reader hands back byte strings as views into the single frame
  // buffer. Copy so a decoded id owns its bytes and never aliases the transient
  // input — the same discipline the Rust SDK applies with `to_vec()`.
  if (value instanceof Uint8Array) return value.slice();
  throw new CborError("expected a CBOR byte string");
}

function asOptBytes(value: unknown): Uint8Array | null {
  return value === null || value === undefined ? null : asBytes(value);
}

function asNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new CborError("expected a number");
}

function asBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  throw new CborError("expected an integer");
}

function asStr(value: unknown): string {
  if (typeof value === "string") return value;
  throw new CborError("expected a text string");
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new CborError("expected a boolean");
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new CborError("expected an array");
}

function asOpt<T>(value: unknown, f: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : f(value);
}

// ---------------------------------------------------------------------------
// Shared enums (integer discriminants on the wire).
// ---------------------------------------------------------------------------

export enum MemoryKindWire {
  Episodic = 0,
  Semantic = 1,
  Consolidated = 2,
}

export enum EdgeKindWire {
  Caused = 0,
  FollowedBy = 1,
  DerivedFrom = 2,
  SimilarTo = 3,
  Contradicts = 4,
  Supports = 5,
  References = 6,
  PartOf = 7,
}

export enum ForgetMode {
  Soft = 0,
  Hard = 1,
}

export enum StageKind {
  AutoEdge = 0,
  TemporalEdge = 1,
  Extractor = 2,
}

export enum AuthMethod {
  Token = 0,
  Mtls = 1,
  None = 2,
}

export enum RetrieverNameWire {
  Semantic = 0,
  Lexical = 1,
  Graph = 2,
}

/** Resolution outcome discriminant (integer on the wire, 1-based). */
export enum ResolutionOutcomeWire {
  Resolved = 1,
  Created = 2,
  Ambiguous = 3,
  NotFound = 4,
}

export enum RetrieverWire {
  Semantic = 0,
  Lexical = 1,
  Graph = 2,
}

export enum ErrorCategoryWire {
  Protocol = 0,
  Authentication = 1,
  Authorization = 2,
  Validation = 3,
  NotFound = 4,
  Conflict = 5,
  ResourceExhausted = 6,
  Internal = 7,
  Unavailable = 8,
}

// ---------------------------------------------------------------------------
// Handshake.
// ---------------------------------------------------------------------------

export interface HelloCapabilities {
  streaming: boolean;
  compressionZstd: boolean;
  serverPush: boolean;
}

function encodeCapabilities(c: HelloCapabilities): Map<string, unknown> {
  return new Map<string, unknown>([
    ["streaming", c.streaming],
    ["compression_zstd", c.compressionZstd],
    ["server_push", c.serverPush],
  ]);
}

function decodeCapabilities(value: unknown): HelloCapabilities {
  const m = asMap(value);
  return {
    streaming: asBool(field(m, "streaming")),
    compressionZstd: asBool(field(m, "compression_zstd")),
    serverPush: asBool(field(m, "server_push")),
  };
}

export interface HelloPayload {
  clientId: string;
  supportedVersions: number[];
  capabilities: HelloCapabilities;
  /** Reserved for session resumption; null encodes as CBOR null. */
  clientSessionToken: Uint8Array | null;
}

export function encodeHello(p: HelloPayload): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["client_id", p.clientId],
      ["supported_versions", p.supportedVersions],
      ["capabilities", encodeCapabilities(p.capabilities)],
      ["client_session_token", p.clientSessionToken],
    ]),
  );
}

export function decodeHello(bytes: Uint8Array): HelloPayload {
  const m = asMap(fromCbor(bytes));
  return {
    clientId: asStr(field(m, "client_id")),
    supportedVersions: asArray(field(m, "supported_versions")).map(asNum),
    capabilities: decodeCapabilities(field(m, "capabilities")),
    clientSessionToken: asOptBytes(field(m, "client_session_token")),
  };
}

export interface ServerFeatures {
  maxPayloadSize: number;
  maxConcurrentStreams: number;
  idleTimeoutSeconds: number;
  authMethods: AuthMethod[];
}

export interface WelcomePayload {
  serverId: string;
  chosenVersion: number;
  sessionId: Uint8Array;
  capabilities: HelloCapabilities;
  serverFeatures: ServerFeatures;
}

export function encodeWelcome(p: WelcomePayload): Uint8Array {
  const sf = p.serverFeatures;
  return toCbor(
    new Map<string, unknown>([
      ["server_id", p.serverId],
      ["chosen_version", p.chosenVersion],
      ["session_id", p.sessionId],
      ["capabilities", encodeCapabilities(p.capabilities)],
      [
        "server_features",
        new Map<string, unknown>([
          ["max_payload_size", sf.maxPayloadSize],
          ["max_concurrent_streams", sf.maxConcurrentStreams],
          ["idle_timeout_seconds", sf.idleTimeoutSeconds],
          ["auth_methods", sf.authMethods.map((m) => m as number)],
        ]),
      ],
    ]),
  );
}

export function decodeWelcome(bytes: Uint8Array): WelcomePayload {
  const m = asMap(fromCbor(bytes));
  const sf = asMap(field(m, "server_features"));
  return {
    serverId: asStr(field(m, "server_id")),
    chosenVersion: asNum(field(m, "chosen_version")),
    sessionId: asBytes(field(m, "session_id")),
    capabilities: decodeCapabilities(field(m, "capabilities")),
    serverFeatures: {
      maxPayloadSize: asNum(field(sf, "max_payload_size")),
      maxConcurrentStreams: asNum(field(sf, "max_concurrent_streams")),
      idleTimeoutSeconds: asNum(field(sf, "idle_timeout_seconds")),
      authMethods: asArray(field(sf, "auth_methods")).map((v) => asNum(v) as AuthMethod),
    },
  };
}

/**
 * Credentials carried in an AUTH frame. Externally tagged: a CBOR map keyed by
 * the variant name, matching the server's serde enum.
 */
export type AuthCredentials =
  | { kind: "Token"; token: Uint8Array }
  | { kind: "Mtls"; certFingerprint: Uint8Array; assertedSubject: string }
  | { kind: "None" };

function encodeCredentials(c: AuthCredentials): unknown {
  switch (c.kind) {
    case "Token":
      // A newtype variant `Token(Vec<u8>)` serializes as a one-entry map whose
      // value is the inner Vec<u8> — a CBOR array of ints, not a byte string.
      return new Map<string, unknown>([["Token", Array.from(c.token)]]);
    case "Mtls":
      return new Map<string, unknown>([
        [
          "Mtls",
          new Map<string, unknown>([
            ["cert_fingerprint", c.certFingerprint],
            ["asserted_subject", c.assertedSubject],
          ]),
        ],
      ]);
    case "None":
      // A unit variant serializes as the bare variant-name string.
      return "None";
  }
}

function decodeCredentials(value: unknown): AuthCredentials {
  if (value === "None") return { kind: "None" };
  const m = asMap(value);
  if (m.has("Token")) {
    return { kind: "Token", token: Uint8Array.from(asArray(m.get("Token")).map(asNum)) };
  }
  if (m.has("Mtls")) {
    const inner = asMap(m.get("Mtls"));
    return {
      kind: "Mtls",
      certFingerprint: asBytes(field(inner, "cert_fingerprint")),
      assertedSubject: asStr(field(inner, "asserted_subject")),
    };
  }
  throw new CborError("unknown AuthCredentials variant");
}

export interface AuthPayload {
  method: AuthMethod;
  agentId: WireUuid;
  credentials: AuthCredentials;
}

export function encodeAuth(p: AuthPayload): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["method", p.method as number],
      ["agent_id", p.agentId],
      ["credentials", encodeCredentials(p.credentials)],
    ]),
  );
}

export function decodeAuth(bytes: Uint8Array): AuthPayload {
  const m = asMap(fromCbor(bytes));
  return {
    method: asNum(field(m, "method")) as AuthMethod,
    agentId: asBytes(field(m, "agent_id")),
    credentials: decodeCredentials(field(m, "credentials")),
  };
}

export interface AgentPermissions {
  canEncode: boolean;
  canRecall: boolean;
  canPlan: boolean;
  canReason: boolean;
  canForget: boolean;
  canAdmin: boolean;
}

export interface AuthOkPayload {
  agentId: WireUuid;
  boundShardId: number;
  permissions: AgentPermissions;
  serverTimeUnixNanos: bigint;
}

export function encodeAuthOk(p: AuthOkPayload): Uint8Array {
  const perm = p.permissions;
  return toCbor(
    new Map<string, unknown>([
      ["agent_id", p.agentId],
      ["bound_shard_id", p.boundShardId],
      [
        "permissions",
        new Map<string, unknown>([
          ["can_encode", perm.canEncode],
          ["can_recall", perm.canRecall],
          ["can_plan", perm.canPlan],
          ["can_reason", perm.canReason],
          ["can_forget", perm.canForget],
          ["can_admin", perm.canAdmin],
        ]),
      ],
      ["server_time_unix_nanos", p.serverTimeUnixNanos],
    ]),
  );
}

export function decodeAuthOk(bytes: Uint8Array): AuthOkPayload {
  const m = asMap(fromCbor(bytes));
  const perm = asMap(field(m, "permissions"));
  return {
    agentId: asBytes(field(m, "agent_id")),
    boundShardId: asNum(field(m, "bound_shard_id")),
    permissions: {
      canEncode: asBool(field(perm, "can_encode")),
      canRecall: asBool(field(perm, "can_recall")),
      canPlan: asBool(field(perm, "can_plan")),
      canReason: asBool(field(perm, "can_reason")),
      canForget: asBool(field(perm, "can_forget")),
      canAdmin: asBool(field(perm, "can_admin")),
    },
    serverTimeUnixNanos: asBig(field(m, "server_time_unix_nanos")),
  };
}

// ===========================================================================
// Keepalive (PING / PONG / SERVER_PING / CLIENT_PONG).
//
// Map keys are the CBOR field names on the wire and must match the server's
// brain-protocol definitions byte-for-byte. Timestamps are u64 → bigint.
// ===========================================================================

export interface PingRequest {
  clientTimestampUnixNanos: bigint;
}

export function encodePing(p: PingRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([["client_timestamp_unix_nanos", p.clientTimestampUnixNanos]]),
  );
}

export interface PongResponse {
  clientTimestampUnixNanos: bigint;
  serverTimestampUnixNanos: bigint;
}

export function decodePong(bytes: Uint8Array): PongResponse {
  const m = asMap(fromCbor(bytes));
  return {
    clientTimestampUnixNanos: asBig(field(m, "client_timestamp_unix_nanos")),
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
  };
}

export interface ServerPingResponse {
  serverTimestampUnixNanos: bigint;
}

export function encodeServerPing(p: ServerPingResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([["server_timestamp_unix_nanos", p.serverTimestampUnixNanos]]),
  );
}

export function decodeServerPing(bytes: Uint8Array): ServerPingResponse {
  const m = asMap(fromCbor(bytes));
  return {
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
  };
}

export interface ClientPongRequest {
  serverTimestampUnixNanos: bigint;
  clientTimestampUnixNanos: bigint;
}

export function encodeClientPong(p: ClientPongRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["server_timestamp_unix_nanos", p.serverTimestampUnixNanos],
      ["client_timestamp_unix_nanos", p.clientTimestampUnixNanos],
    ]),
  );
}

export function decodeClientPong(bytes: Uint8Array): ClientPongRequest {
  const m = asMap(fromCbor(bytes));
  return {
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
    clientTimestampUnixNanos: asBig(field(m, "client_timestamp_unix_nanos")),
  };
}

// ---------------------------------------------------------------------------
// ENCODE / ENCODE_VECTOR_DIRECT.
// ---------------------------------------------------------------------------

export interface EdgeRequest {
  target: bigint;
  kind: EdgeKindWire;
  weight: number;
}

function encodeEdge(e: EdgeRequest): Map<string, unknown> {
  return new Map<string, unknown>([
    ["target", e.target],
    ["kind", e.kind as number],
    ["weight", f32(e.weight)],
  ]);
}

function decodeEdge(value: unknown): EdgeRequest {
  const m = asMap(value);
  return {
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    weight: asNum(field(m, "weight")),
  };
}

export interface EncodeRequest {
  text: string;
  contextId: bigint;
  kind: MemoryKindWire;
  salienceHint: number;
  edges: EdgeRequest[];
  requestId: WireUuid;
  txnId: WireUuid | null;
  deduplicate: boolean;
}

export function encodeEncode(p: EncodeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["text", p.text],
      ["context_id", p.contextId],
      ["kind", p.kind as number],
      ["salience_hint", f32(p.salienceHint)],
      ["edges", p.edges.map(encodeEdge)],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
      ["deduplicate", p.deduplicate],
    ]),
  );
}

export function decodeEncode(bytes: Uint8Array): EncodeRequest {
  const m = asMap(fromCbor(bytes));
  return {
    text: asStr(field(m, "text")),
    contextId: asBig(field(m, "context_id")),
    kind: asNum(field(m, "kind")) as MemoryKindWire,
    salienceHint: asNum(field(m, "salience_hint")),
    edges: asArray(field(m, "edges")).map(decodeEdge),
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    deduplicate: asBool(field(m, "deduplicate")),
  };
}

export interface EncodeVectorDirectRequest {
  text: string;
  /** Carried in the trailing raw f32 section, not the CBOR map. */
  vector: number[];
  modelFingerprint: Uint8Array;
  contextId: bigint;
  kind: MemoryKindWire;
  salienceHint: number;
  edges: EdgeRequest[];
  requestId: WireUuid;
  txnId: WireUuid | null;
  deduplicate: boolean;
}

export function encodeEncodeVectorDirect(p: EncodeVectorDirectRequest): Uint8Array {
  const cbor = toCbor(
    new Map<string, unknown>([
      ["text", p.text],
      ["model_fingerprint", p.modelFingerprint],
      ["context_id", p.contextId],
      ["kind", p.kind as number],
      ["salience_hint", f32(p.salienceHint)],
      ["edges", p.edges.map(encodeEdge)],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
      ["deduplicate", p.deduplicate],
    ]),
  );
  const vec = f32ToLeBytes(p.vector);
  const out = new Uint8Array(cbor.length + vec.length);
  out.set(cbor, 0);
  out.set(vec, cbor.length);
  return out;
}

export function decodeEncodeVectorDirect(bytes: Uint8Array): EncodeVectorDirectRequest {
  const { value, consumed } = fromCborPrefix(bytes);
  const m = asMap(value);
  const vector = Array.from(leBytesToF32(bytes.subarray(consumed)));
  return {
    text: asStr(field(m, "text")),
    vector,
    modelFingerprint: asBytes(field(m, "model_fingerprint")),
    contextId: asBig(field(m, "context_id")),
    kind: asNum(field(m, "kind")) as MemoryKindWire,
    salienceHint: asNum(field(m, "salience_hint")),
    edges: asArray(field(m, "edges")).map(decodeEdge),
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    deduplicate: asBool(field(m, "deduplicate")),
  };
}

export interface EncodeResponse {
  memoryId: bigint;
  wasDeduplicated: boolean;
  salience: number;
  autoEdgesAdded: number;
  lsn: bigint;
  agentId: WireUuid;
  contextId: bigint;
  kind: MemoryKindWire;
  createdAtUnixNanos: bigint;
  edgesOutCount: number;
  embeddingModelFp: Uint8Array;
  pendingStages: StageKind[];
  hasActiveSchema: boolean;
}

export function encodeEncodeResponse(p: EncodeResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["memory_id", p.memoryId],
      ["was_deduplicated", p.wasDeduplicated],
      ["salience", f32(p.salience)],
      ["auto_edges_added", p.autoEdgesAdded],
      ["lsn", p.lsn],
      ["agent_id", p.agentId],
      ["context_id", p.contextId],
      ["kind", p.kind as number],
      ["created_at_unix_nanos", p.createdAtUnixNanos],
      ["edges_out_count", p.edgesOutCount],
      ["embedding_model_fp", p.embeddingModelFp],
      ["pending_stages", p.pendingStages.map((s) => s as number)],
      ["has_active_schema", p.hasActiveSchema],
    ]),
  );
}

export function decodeEncodeResponse(bytes: Uint8Array): EncodeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    memoryId: asBig(field(m, "memory_id")),
    wasDeduplicated: asBool(field(m, "was_deduplicated")),
    salience: asNum(field(m, "salience")),
    autoEdgesAdded: asNum(field(m, "auto_edges_added")),
    lsn: asBig(field(m, "lsn")),
    agentId: asBytes(field(m, "agent_id")),
    contextId: asBig(field(m, "context_id")),
    kind: asNum(field(m, "kind")) as MemoryKindWire,
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    edgesOutCount: asNum(field(m, "edges_out_count")),
    embeddingModelFp: asBytes(field(m, "embedding_model_fp")),
    pendingStages: asArray(field(m, "pending_stages")).map((v) => asNum(v) as StageKind),
    hasActiveSchema: asBool(field(m, "has_active_schema")),
  };
}

// ---------------------------------------------------------------------------
// RECALL.
// ---------------------------------------------------------------------------

export interface RecallRequest {
  cueText: string;
  topK: number;
  confidenceThreshold: number;
  contextFilter: bigint[] | null;
  ageBoundUnixNanos: bigint | null;
  kindFilter: MemoryKindWire[] | null;
  salienceFloor: number;
  includeEdges: boolean;
  includeGraph: boolean;
  includeText: boolean;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
  agentFilter: WireUuid[];
  includeOtherAgents: boolean;
}

export function encodeRecall(p: RecallRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["cue_text", p.cueText],
      ["top_k", p.topK],
      ["confidence_threshold", f32(p.confidenceThreshold)],
      ["context_filter", p.contextFilter === null ? null : p.contextFilter],
      ["age_bound_unix_nanos", p.ageBoundUnixNanos],
      ["kind_filter", p.kindFilter === null ? null : p.kindFilter.map((k) => k as number)],
      ["salience_floor", f32(p.salienceFloor)],
      ["include_edges", p.includeEdges],
      ["include_graph", p.includeGraph],
      ["include_text", p.includeText],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
      ["agent_filter", p.agentFilter],
      ["include_other_agents", p.includeOtherAgents],
    ]),
  );
}

export function decodeRecall(bytes: Uint8Array): RecallRequest {
  const m = asMap(fromCbor(bytes));
  return {
    cueText: asStr(field(m, "cue_text")),
    topK: asNum(field(m, "top_k")),
    confidenceThreshold: asNum(field(m, "confidence_threshold")),
    contextFilter: asOpt(field(m, "context_filter"), (v) => asArray(v).map(asBig)),
    ageBoundUnixNanos: asOpt(field(m, "age_bound_unix_nanos"), asBig),
    kindFilter: asOpt(field(m, "kind_filter"), (v) =>
      asArray(v).map((k) => asNum(k) as MemoryKindWire),
    ),
    salienceFloor: asNum(field(m, "salience_floor")),
    includeEdges: asBool(field(m, "include_edges")),
    includeGraph: asBool(field(m, "include_graph")),
    includeText: asBool(field(m, "include_text")),
    requestId: asOptBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    agentFilter: asArray(field(m, "agent_filter")).map(asBytes),
    includeOtherAgents: asBool(field(m, "include_other_agents")),
  };
}

export interface EdgeView {
  target: bigint;
  kind: EdgeKindWire;
  weight: number;
}

export interface EnrichedEntity {
  id: Uint8Array;
  name: string;
  typeQname: string;
}

export interface EnrichedStatement {
  id: Uint8Array;
  subjectName: string;
  predicate: string;
  objectLabel: string;
  confidence: number;
}

export interface EnrichedRelation {
  fromName: string;
  predicate: string;
  toName: string;
}

export interface GraphEnrichment {
  entities: EnrichedEntity[];
  statements: EnrichedStatement[];
  relations: EnrichedRelation[];
}

function encodeEdgeView(e: EdgeView): Map<string, unknown> {
  return new Map<string, unknown>([
    ["target", e.target],
    ["kind", e.kind as number],
    ["weight", f32(e.weight)],
  ]);
}

function encodeGraph(g: GraphEnrichment): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "entities",
      g.entities.map(
        (e) =>
          new Map<string, unknown>([
            ["id", e.id],
            ["name", e.name],
            ["type_qname", e.typeQname],
          ]),
      ),
    ],
    [
      "statements",
      g.statements.map(
        (s) =>
          new Map<string, unknown>([
            ["id", s.id],
            ["subject_name", s.subjectName],
            ["predicate", s.predicate],
            ["object_label", s.objectLabel],
            ["confidence", f32(s.confidence)],
          ]),
      ),
    ],
    [
      "relations",
      g.relations.map(
        (r) =>
          new Map<string, unknown>([
            ["from_name", r.fromName],
            ["predicate", r.predicate],
            ["to_name", r.toName],
          ]),
      ),
    ],
  ]);
}

export interface MemoryResult {
  memoryId: bigint;
  text: string;
  similarityScore: number;
  confidence: number;
  salience: number;
  kind: MemoryKindWire;
  agentId: WireUuid;
  contextId: bigint;
  createdAtUnixNanos: bigint;
  lastAccessedAtUnixNanos: bigint;
  edges: EdgeView[] | null;
  contributingRetrievers: RetrieverNameWire[];
  fusedScore: number;
  rerankScore: number | null;
  salienceInitial: number;
  accessCount: number;
  lsn: bigint;
  flags: number;
  consolidatedAtUnixNanos: bigint | null;
  edgesOutCount: number;
  edgesInCount: number;
  graph: GraphEnrichment | null;
}

function encodeMemoryResult(r: MemoryResult): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", r.memoryId],
    ["text", r.text],
    ["similarity_score", f32(r.similarityScore)],
    ["confidence", f32(r.confidence)],
    ["salience", f32(r.salience)],
    ["kind", r.kind as number],
    ["agent_id", r.agentId],
    ["context_id", r.contextId],
    ["created_at_unix_nanos", r.createdAtUnixNanos],
    ["last_accessed_at_unix_nanos", r.lastAccessedAtUnixNanos],
    ["edges", r.edges === null ? null : r.edges.map(encodeEdgeView)],
    ["contributing_retrievers", r.contributingRetrievers.map((x) => x as number)],
    ["fused_score", f32(r.fusedScore)],
    ["rerank_score", r.rerankScore === null ? null : f32(r.rerankScore)],
    ["salience_initial", f32(r.salienceInitial)],
    ["access_count", r.accessCount],
    ["lsn", r.lsn],
    ["flags", r.flags],
    ["consolidated_at_unix_nanos", r.consolidatedAtUnixNanos],
    ["edges_out_count", r.edgesOutCount],
    ["edges_in_count", r.edgesInCount],
    ["graph", r.graph === null ? null : encodeGraph(r.graph)],
  ]);
}

function decodeEdgeView(value: unknown): EdgeView {
  const m = asMap(value);
  return {
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    weight: asNum(field(m, "weight")),
  };
}

function decodeGraph(value: unknown): GraphEnrichment {
  const m = asMap(value);
  return {
    entities: asArray(field(m, "entities")).map((v) => {
      const e = asMap(v);
      return {
        id: asBytes(field(e, "id")),
        name: asStr(field(e, "name")),
        typeQname: asStr(field(e, "type_qname")),
      };
    }),
    statements: asArray(field(m, "statements")).map((v) => {
      const s = asMap(v);
      return {
        id: asBytes(field(s, "id")),
        subjectName: asStr(field(s, "subject_name")),
        predicate: asStr(field(s, "predicate")),
        objectLabel: asStr(field(s, "object_label")),
        confidence: asNum(field(s, "confidence")),
      };
    }),
    relations: asArray(field(m, "relations")).map((v) => {
      const r = asMap(v);
      return {
        fromName: asStr(field(r, "from_name")),
        predicate: asStr(field(r, "predicate")),
        toName: asStr(field(r, "to_name")),
      };
    }),
  };
}

function decodeMemoryResult(value: unknown): MemoryResult {
  const m = asMap(value);
  return {
    memoryId: asBig(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    similarityScore: asNum(field(m, "similarity_score")),
    confidence: asNum(field(m, "confidence")),
    salience: asNum(field(m, "salience")),
    kind: asNum(field(m, "kind")) as MemoryKindWire,
    agentId: asBytes(field(m, "agent_id")),
    contextId: asBig(field(m, "context_id")),
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    lastAccessedAtUnixNanos: asBig(field(m, "last_accessed_at_unix_nanos")),
    edges: asOpt(field(m, "edges"), (v) => asArray(v).map(decodeEdgeView)),
    contributingRetrievers: asArray(field(m, "contributing_retrievers")).map(
      (x) => asNum(x) as RetrieverNameWire,
    ),
    fusedScore: asNum(field(m, "fused_score")),
    rerankScore: asOpt(field(m, "rerank_score"), asNum),
    salienceInitial: asNum(field(m, "salience_initial")),
    accessCount: asNum(field(m, "access_count")),
    lsn: asBig(field(m, "lsn")),
    flags: asNum(field(m, "flags")),
    consolidatedAtUnixNanos: asOpt(field(m, "consolidated_at_unix_nanos"), asBig),
    edgesOutCount: asNum(field(m, "edges_out_count")),
    edgesInCount: asNum(field(m, "edges_in_count")),
    graph: asOpt(field(m, "graph"), decodeGraph),
  };
}

export interface RecallResponseFrame {
  results: MemoryResult[];
  isFinal: boolean;
  cumulativeCount: number;
  estimatedRemaining: number | null;
}

export function encodeRecallResponse(p: RecallResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["results", p.results.map(encodeMemoryResult)],
      ["is_final", p.isFinal],
      ["cumulative_count", p.cumulativeCount],
      ["estimated_remaining", p.estimatedRemaining],
    ]),
  );
}

export function decodeRecallResponse(bytes: Uint8Array): RecallResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    results: asArray(field(m, "results")).map(decodeMemoryResult),
    isFinal: asBool(field(m, "is_final")),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    estimatedRemaining: asOpt(field(m, "estimated_remaining"), asNum),
  };
}

// ---------------------------------------------------------------------------
// FORGET.
// ---------------------------------------------------------------------------

export interface ForgetRequest {
  memoryId: bigint;
  mode: ForgetMode;
  requestId: WireUuid;
  txnId: WireUuid | null;
}

export function encodeForget(p: ForgetRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["memory_id", p.memoryId],
      ["mode", p.mode as number],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
    ]),
  );
}

export function decodeForget(bytes: Uint8Array): ForgetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    memoryId: asBig(field(m, "memory_id")),
    mode: asNum(field(m, "mode")) as ForgetMode,
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
  };
}

export interface ForgetResponse {
  memoryId: bigint;
  wasAlreadyForgotten: boolean;
  edgesRemoved: number;
}

export function encodeForgetResponse(p: ForgetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["memory_id", p.memoryId],
      ["was_already_forgotten", p.wasAlreadyForgotten],
      ["edges_removed", p.edgesRemoved],
    ]),
  );
}

export function decodeForgetResponse(bytes: Uint8Array): ForgetResponse {
  const m = asMap(fromCbor(bytes));
  return {
    memoryId: asBig(field(m, "memory_id")),
    wasAlreadyForgotten: asBool(field(m, "was_already_forgotten")),
    edgesRemoved: asNum(field(m, "edges_removed")),
  };
}

// ---------------------------------------------------------------------------
// ERROR.
// ---------------------------------------------------------------------------

export interface ErrorDetails {
  field: string | null;
  expected: string | null;
  actual: string | null;
}

export interface ErrorResponse {
  code: number;
  category: ErrorCategoryWire;
  message: string;
  details: ErrorDetails | null;
  retryAfterMs: number | null;
}

export function encodeError(p: ErrorResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["code", p.code],
      ["category", p.category as number],
      ["message", p.message],
      [
        "details",
        p.details === null
          ? null
          : new Map<string, unknown>([
              ["field", p.details.field],
              ["expected", p.details.expected],
              ["actual", p.details.actual],
            ]),
      ],
      ["retry_after_ms", p.retryAfterMs],
    ]),
  );
}

export function decodeError(bytes: Uint8Array): ErrorResponse {
  const m = asMap(fromCbor(bytes));
  return {
    code: asNum(field(m, "code")),
    category: asNum(field(m, "category")) as ErrorCategoryWire,
    message: asStr(field(m, "message")),
    details: asOpt(field(m, "details"), (v) => {
      const d = asMap(v);
      return {
        field: asOpt(field(d, "field"), asStr),
        expected: asOpt(field(d, "expected"), asStr),
        actual: asOpt(field(d, "actual"), asStr),
      };
    }),
    retryAfterMs: asOpt(field(m, "retry_after_ms"), asNum),
  };
}

// ---------------------------------------------------------------------------
// Typed-graph payloads.
// ---------------------------------------------------------------------------

/** Statement kind. Encodes as a variant-name text string, not an integer. */
export type StatementKindWire = "Fact" | "Preference" | "Event";

/** Scalar object value. Externally tagged (one-entry map keyed by variant). */
export type StatementValueWire =
  | { kind: "Text"; value: string }
  | { kind: "Integer"; value: bigint }
  | { kind: "Float"; value: number }
  | { kind: "Bool"; value: boolean }
  | { kind: "UnixNanos"; value: bigint }
  | { kind: "Blob"; value: Uint8Array };

function encodeStatementValue(v: StatementValueWire): Map<string, unknown> {
  switch (v.kind) {
    case "Text":
      return new Map<string, unknown>([["Text", v.value]]);
    case "Integer":
      return new Map<string, unknown>([["Integer", v.value]]);
    case "Float":
      return new Map<string, unknown>([["Float", f64(v.value)]]);
    case "Bool":
      return new Map<string, unknown>([["Bool", v.value]]);
    case "UnixNanos":
      return new Map<string, unknown>([["UnixNanos", v.value]]);
    case "Blob":
      // A Vec<u8> is a CBOR array of ints, matching serde's default.
      return new Map<string, unknown>([["Blob", Array.from(v.value)]]);
  }
}

function decodeStatementValue(value: unknown): StatementValueWire {
  const m = asMap(value);
  if (m.has("Text")) return { kind: "Text", value: asStr(m.get("Text")) };
  if (m.has("Integer")) return { kind: "Integer", value: asBig(m.get("Integer")) };
  if (m.has("Float")) return { kind: "Float", value: asNum(m.get("Float")) };
  if (m.has("Bool")) return { kind: "Bool", value: asBool(m.get("Bool")) };
  if (m.has("UnixNanos")) return { kind: "UnixNanos", value: asBig(m.get("UnixNanos")) };
  if (m.has("Blob")) {
    return { kind: "Blob", value: Uint8Array.from(asArray(m.get("Blob")).map(asNum)) };
  }
  throw new CborError("unknown StatementValue variant");
}

/** Statement object. Externally tagged; each id variant is a byte string. */
export type StatementObjectWire =
  | { kind: "EntityRef"; id: WireUuid }
  | { kind: "Value"; value: StatementValueWire }
  | { kind: "MemoryRef"; id: Uint8Array }
  | { kind: "StatementRef"; id: WireUuid };

function encodeStatementObject(o: StatementObjectWire): Map<string, unknown> {
  switch (o.kind) {
    case "EntityRef":
      return new Map<string, unknown>([["EntityRef", o.id]]);
    case "Value":
      return new Map<string, unknown>([["Value", encodeStatementValue(o.value)]]);
    case "MemoryRef":
      return new Map<string, unknown>([["MemoryRef", o.id]]);
    case "StatementRef":
      return new Map<string, unknown>([["StatementRef", o.id]]);
  }
}

function decodeStatementObject(value: unknown): StatementObjectWire {
  const m = asMap(value);
  if (m.has("EntityRef")) return { kind: "EntityRef", id: asBytes(m.get("EntityRef")) };
  if (m.has("Value")) return { kind: "Value", value: decodeStatementValue(m.get("Value")) };
  if (m.has("MemoryRef")) return { kind: "MemoryRef", id: asBytes(m.get("MemoryRef")) };
  if (m.has("StatementRef")) return { kind: "StatementRef", id: asBytes(m.get("StatementRef")) };
  throw new CborError("unknown StatementObject variant");
}

/** Evidence reference. Externally tagged. */
export type EvidenceRefWire =
  | { kind: "Inline"; ids: WireUuid[] }
  | { kind: "Overflow"; id: WireUuid };

function encodeEvidence(e: EvidenceRefWire): Map<string, unknown> {
  if (e.kind === "Inline") return new Map<string, unknown>([["Inline", e.ids]]);
  return new Map<string, unknown>([["Overflow", e.id]]);
}

function decodeEvidence(value: unknown): EvidenceRefWire {
  const m = asMap(value);
  if (m.has("Inline")) return { kind: "Inline", ids: asArray(m.get("Inline")).map(asBytes) };
  if (m.has("Overflow")) return { kind: "Overflow", id: asBytes(m.get("Overflow")) };
  throw new CborError("unknown EvidenceRef variant");
}

export interface EntityCreateRequest {
  entityTypeId: number;
  canonicalName: string;
  aliases: string[];
  attributesBlob: Uint8Array;
  requestId: WireUuid;
}

export function encodeEntityCreate(p: EntityCreateRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["entity_type_id", p.entityTypeId],
      ["canonical_name", p.canonicalName],
      ["aliases", p.aliases],
      ["attributes_blob", Array.from(p.attributesBlob)],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeEntityCreate(bytes: Uint8Array): EntityCreateRequest {
  const m = asMap(fromCbor(bytes));
  return {
    entityTypeId: asNum(field(m, "entity_type_id")),
    canonicalName: asStr(field(m, "canonical_name")),
    aliases: asArray(field(m, "aliases")).map(asStr),
    attributesBlob: Uint8Array.from(asArray(field(m, "attributes_blob")).map(asNum)),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface EntityCreateResponse {
  entityId: WireUuid;
}

export function encodeEntityCreateResponse(p: EntityCreateResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["entity_id", p.entityId]]));
}

export function decodeEntityCreateResponse(bytes: Uint8Array): EntityCreateResponse {
  const m = asMap(fromCbor(bytes));
  return { entityId: asBytes(field(m, "entity_id")) };
}

export interface StatementCreateRequest {
  kind: StatementKindWire;
  subject: WireUuid;
  predicate: string;
  object: StatementObjectWire;
  confidence: number;
  evidence: EvidenceRefWire;
  extractorId: number;
  validFromUnixNanos: bigint;
  validToUnixNanos: bigint;
  eventAtUnixNanos: bigint;
  schemaVersion: number;
  requestId: WireUuid;
}

export function encodeStatementCreate(p: StatementCreateRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["kind", p.kind],
      ["subject", p.subject],
      ["predicate", p.predicate],
      ["object", encodeStatementObject(p.object)],
      ["confidence", f32(p.confidence)],
      ["evidence", encodeEvidence(p.evidence)],
      ["extractor_id", p.extractorId],
      ["valid_from_unix_nanos", p.validFromUnixNanos],
      ["valid_to_unix_nanos", p.validToUnixNanos],
      ["event_at_unix_nanos", p.eventAtUnixNanos],
      ["schema_version", p.schemaVersion],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeStatementCreate(bytes: Uint8Array): StatementCreateRequest {
  const m = asMap(fromCbor(bytes));
  return {
    kind: asStr(field(m, "kind")) as StatementKindWire,
    subject: asBytes(field(m, "subject")),
    predicate: asStr(field(m, "predicate")),
    object: decodeStatementObject(field(m, "object")),
    confidence: asNum(field(m, "confidence")),
    evidence: decodeEvidence(field(m, "evidence")),
    extractorId: asNum(field(m, "extractor_id")),
    validFromUnixNanos: asBig(field(m, "valid_from_unix_nanos")),
    validToUnixNanos: asBig(field(m, "valid_to_unix_nanos")),
    eventAtUnixNanos: asBig(field(m, "event_at_unix_nanos")),
    schemaVersion: asNum(field(m, "schema_version")),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface StatementCreateResponse {
  statementId: WireUuid;
  autoSuperseded: WireUuid;
  chainRoot: WireUuid;
}

export function encodeStatementCreateResponse(p: StatementCreateResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement_id", p.statementId],
      ["auto_superseded", p.autoSuperseded],
      ["chain_root", p.chainRoot],
    ]),
  );
}

export function decodeStatementCreateResponse(bytes: Uint8Array): StatementCreateResponse {
  const m = asMap(fromCbor(bytes));
  return {
    statementId: asBytes(field(m, "statement_id")),
    autoSuperseded: asBytes(field(m, "auto_superseded")),
    chainRoot: asBytes(field(m, "chain_root")),
  };
}

export interface RelationCreateRequest {
  relationType: string;
  fromEntity: WireUuid;
  toEntity: WireUuid;
  propertiesBlob: Uint8Array;
  evidence: EvidenceRefWire;
  extractorId: number;
  confidence: number;
  validFromUnixNanos: bigint;
  validToUnixNanos: bigint;
  requestId: WireUuid;
}

export function encodeRelationCreate(p: RelationCreateRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["relation_type", p.relationType],
      ["from_entity", p.fromEntity],
      ["to_entity", p.toEntity],
      ["properties_blob", Array.from(p.propertiesBlob)],
      ["evidence", encodeEvidence(p.evidence)],
      ["extractor_id", p.extractorId],
      ["confidence", f32(p.confidence)],
      ["valid_from_unix_nanos", p.validFromUnixNanos],
      ["valid_to_unix_nanos", p.validToUnixNanos],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeRelationCreate(bytes: Uint8Array): RelationCreateRequest {
  const m = asMap(fromCbor(bytes));
  return {
    relationType: asStr(field(m, "relation_type")),
    fromEntity: asBytes(field(m, "from_entity")),
    toEntity: asBytes(field(m, "to_entity")),
    propertiesBlob: Uint8Array.from(asArray(field(m, "properties_blob")).map(asNum)),
    evidence: decodeEvidence(field(m, "evidence")),
    extractorId: asNum(field(m, "extractor_id")),
    confidence: asNum(field(m, "confidence")),
    validFromUnixNanos: asBig(field(m, "valid_from_unix_nanos")),
    validToUnixNanos: asBig(field(m, "valid_to_unix_nanos")),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface RelationCreateResponse {
  relationId: WireUuid;
}

export function encodeRelationCreateResponse(p: RelationCreateResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["relation_id", p.relationId]]));
}

export function decodeRelationCreateResponse(bytes: Uint8Array): RelationCreateResponse {
  const m = asMap(fromCbor(bytes));
  return { relationId: asBytes(field(m, "relation_id")) };
}

export interface SchemaUploadRequest {
  schemaDocument: string;
  dryRun: boolean;
  allowBreaking: boolean;
  requestId: WireUuid;
}

export function encodeSchemaUpload(p: SchemaUploadRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["schema_document", p.schemaDocument],
      ["dry_run", p.dryRun],
      ["allow_breaking", p.allowBreaking],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeSchemaUpload(bytes: Uint8Array): SchemaUploadRequest {
  const m = asMap(fromCbor(bytes));
  return {
    schemaDocument: asStr(field(m, "schema_document")),
    dryRun: asBool(field(m, "dry_run")),
    allowBreaking: asBool(field(m, "allow_breaking")),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface SchemaValidationErrorWire {
  code: string;
  message: string;
  line: number;
  column: number;
  length: number;
  severity: number;
}

export interface SchemaUploadResponse {
  namespace: string;
  schemaVersion: number;
  validationErrors: SchemaValidationErrorWire[];
  backwardCompatible: boolean;
  migrationSummaryBlob: Uint8Array;
}

export function encodeSchemaUploadResponse(p: SchemaUploadResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["schema_version", p.schemaVersion],
      [
        "validation_errors",
        p.validationErrors.map(
          (e) =>
            new Map<string, unknown>([
              ["code", e.code],
              ["message", e.message],
              ["line", e.line],
              ["column", e.column],
              ["length", e.length],
              ["severity", e.severity],
            ]),
        ),
      ],
      ["backward_compatible", p.backwardCompatible],
      ["migration_summary_blob", Array.from(p.migrationSummaryBlob)],
    ]),
  );
}

export function decodeSchemaUploadResponse(bytes: Uint8Array): SchemaUploadResponse {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    schemaVersion: asNum(field(m, "schema_version")),
    validationErrors: asArray(field(m, "validation_errors")).map((v) => {
      const e = asMap(v);
      return {
        code: asStr(field(e, "code")),
        message: asStr(field(e, "message")),
        line: asNum(field(e, "line")),
        column: asNum(field(e, "column")),
        length: asNum(field(e, "length")),
        severity: asNum(field(e, "severity")),
      };
    }),
    backwardCompatible: asBool(field(m, "backward_compatible")),
    migrationSummaryBlob: Uint8Array.from(asArray(field(m, "migration_summary_blob")).map(asNum)),
  };
}

export interface TimeRangeWire {
  fromUnixMs: bigint | null;
  toUnixMs: bigint | null;
}

/** Auto-routing vs explicit retriever list. Externally tagged. */
export type RetrieverSelectionWire =
  | { kind: "Auto" }
  | { kind: "Explicit"; retrievers: RetrieverWire[] };

function encodeRetrieverSelection(s: RetrieverSelectionWire): unknown {
  if (s.kind === "Auto") return "Auto";
  return new Map<string, unknown>([["Explicit", s.retrievers.map((r) => r as number)]]);
}

function decodeRetrieverSelection(value: unknown): RetrieverSelectionWire {
  if (value === "Auto") return { kind: "Auto" };
  const m = asMap(value);
  if (m.has("Explicit")) {
    return {
      kind: "Explicit",
      retrievers: asArray(m.get("Explicit")).map((r) => asNum(r) as RetrieverWire),
    };
  }
  throw new CborError("unknown RetrieverSelection variant");
}

export interface FusionConfigWire {
  k: number;
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
}

export interface QueryRequest {
  text: string;
  entityAnchor: WireUuid | null;
  kindFilter: number[];
  predicateFilter: string[];
  timeFilter: TimeRangeWire | null;
  confidenceMin: number | null;
  includeTombstoned: boolean;
  includeSuperseded: boolean;
  limit: number;
  retrievers: RetrieverSelectionWire;
  fusionConfig: FusionConfigWire | null;
  requestId: WireUuid;
}

export function encodeQuery(p: QueryRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["text", p.text],
      ["entity_anchor", p.entityAnchor],
      ["kind_filter", p.kindFilter],
      ["predicate_filter", p.predicateFilter],
      [
        "time_filter",
        p.timeFilter === null
          ? null
          : new Map<string, unknown>([
              ["from_unix_ms", p.timeFilter.fromUnixMs],
              ["to_unix_ms", p.timeFilter.toUnixMs],
            ]),
      ],
      ["confidence_min", p.confidenceMin === null ? null : f32(p.confidenceMin)],
      ["include_tombstoned", p.includeTombstoned],
      ["include_superseded", p.includeSuperseded],
      ["limit", p.limit],
      ["retrievers", encodeRetrieverSelection(p.retrievers)],
      [
        "fusion_config",
        p.fusionConfig === null
          ? null
          : new Map<string, unknown>([
              ["k", p.fusionConfig.k],
              ["semantic_weight", f32(p.fusionConfig.semanticWeight)],
              ["lexical_weight", f32(p.fusionConfig.lexicalWeight)],
              ["graph_weight", f32(p.fusionConfig.graphWeight)],
            ]),
      ],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeQuery(bytes: Uint8Array): QueryRequest {
  const m = asMap(fromCbor(bytes));
  return {
    text: asStr(field(m, "text")),
    entityAnchor: asOptBytes(field(m, "entity_anchor")),
    kindFilter: asArray(field(m, "kind_filter")).map(asNum),
    predicateFilter: asArray(field(m, "predicate_filter")).map(asStr),
    timeFilter: asOpt(field(m, "time_filter"), (v) => {
      const ti = asMap(v);
      return {
        fromUnixMs: asOpt(field(ti, "from_unix_ms"), asBig),
        toUnixMs: asOpt(field(ti, "to_unix_ms"), asBig),
      };
    }),
    confidenceMin: asOpt(field(m, "confidence_min"), asNum),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    includeSuperseded: asBool(field(m, "include_superseded")),
    limit: asNum(field(m, "limit")),
    retrievers: decodeRetrieverSelection(field(m, "retrievers")),
    fusionConfig: asOpt(field(m, "fusion_config"), (v) => {
      const fc = asMap(v);
      return {
        k: asNum(field(fc, "k")),
        semanticWeight: asNum(field(fc, "semantic_weight")),
        lexicalWeight: asNum(field(fc, "lexical_weight")),
        graphWeight: asNum(field(fc, "graph_weight")),
      };
    }),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface ItemIdWire {
  kind: number;
  bytes: Uint8Array;
}

export interface RetrieverContributionWire {
  retriever: RetrieverWire;
  rank: number;
  rawScore: number;
}

export interface RetrieverOutcomeWire {
  retriever: RetrieverWire;
  status: number;
  message: string;
  latencyMs: number;
  resultCount: number;
}

export interface QueryResultItem {
  id: ItemIdWire;
  fusedScore: number;
  contributing: RetrieverContributionWire[];
}

export interface QueryResponse {
  items: QueryResultItem[];
  totalLatencyMs: number;
  retrieverOutcomes: RetrieverOutcomeWire[];
}

export function encodeQueryResponse(p: QueryResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      [
        "items",
        p.items.map(
          (item) =>
            new Map<string, unknown>([
              [
                "id",
                new Map<string, unknown>([
                  ["kind", item.id.kind],
                  ["bytes", item.id.bytes],
                ]),
              ],
              ["fused_score", f64(item.fusedScore)],
              [
                "contributing",
                item.contributing.map(
                  (c) =>
                    new Map<string, unknown>([
                      ["retriever", c.retriever as number],
                      ["rank", c.rank],
                      ["raw_score", f32(c.rawScore)],
                    ]),
                ),
              ],
            ]),
        ),
      ],
      ["total_latency_ms", f64(p.totalLatencyMs)],
      [
        "retriever_outcomes",
        p.retrieverOutcomes.map(
          (o) =>
            new Map<string, unknown>([
              ["retriever", o.retriever as number],
              ["status", o.status],
              ["message", o.message],
              ["latency_ms", f64(o.latencyMs)],
              ["result_count", o.resultCount],
            ]),
        ),
      ],
    ]),
  );
}

export function decodeQueryResponse(bytes: Uint8Array): QueryResponse {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map((v) => {
      const it = asMap(v);
      const id = asMap(field(it, "id"));
      return {
        id: { kind: asNum(field(id, "kind")), bytes: asBytes(field(id, "bytes")) },
        fusedScore: asNum(field(it, "fused_score")),
        contributing: asArray(field(it, "contributing")).map((cv) => {
          const c = asMap(cv);
          return {
            retriever: asNum(field(c, "retriever")) as RetrieverWire,
            rank: asNum(field(c, "rank")),
            rawScore: asNum(field(c, "raw_score")),
          };
        }),
      };
    }),
    totalLatencyMs: asNum(field(m, "total_latency_ms")),
    retrieverOutcomes: asArray(field(m, "retriever_outcomes")).map((v) => {
      const o = asMap(v);
      return {
        retriever: asNum(field(o, "retriever")) as RetrieverWire,
        status: asNum(field(o, "status")),
        message: asStr(field(o, "message")),
        latencyMs: asNum(field(o, "latency_ms")),
        resultCount: asNum(field(o, "result_count")),
      };
    }),
  };
}

export interface MaterializeProceduralRequest {
  agentId: WireUuid;
  contextFilter: bigint;
  topK: number;
  minConfidence: number;
  categories: string[];
  requestId: WireUuid;
}

export function encodeMaterializeProcedural(p: MaterializeProceduralRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["agent_id", p.agentId],
      ["context_filter", p.contextFilter],
      ["top_k", p.topK],
      ["min_confidence", f32(p.minConfidence)],
      ["categories", p.categories],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeMaterializeProcedural(bytes: Uint8Array): MaterializeProceduralRequest {
  const m = asMap(fromCbor(bytes));
  return {
    agentId: asBytes(field(m, "agent_id")),
    contextFilter: asBig(field(m, "context_filter")),
    topK: asNum(field(m, "top_k")),
    minConfidence: asNum(field(m, "min_confidence")),
    categories: asArray(field(m, "categories")).map(asStr),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface MaterializeProceduralResponse {
  systemBlock: string;
  statementIds: WireUuid[];
  totalCandidates: number;
  trimmedByBudget: boolean;
}

export function encodeMaterializeProceduralResponse(
  p: MaterializeProceduralResponse,
): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["system_block", p.systemBlock],
      ["statement_ids", p.statementIds],
      ["total_candidates", p.totalCandidates],
      ["trimmed_by_budget", p.trimmedByBudget],
    ]),
  );
}

export function decodeMaterializeProceduralResponse(
  bytes: Uint8Array,
): MaterializeProceduralResponse {
  const m = asMap(fromCbor(bytes));
  return {
    systemBlock: asStr(field(m, "system_block")),
    statementIds: asArray(field(m, "statement_ids")).map(asBytes),
    totalCandidates: asNum(field(m, "total_candidates")),
    trimmedByBudget: asBool(field(m, "trimmed_by_budget")),
  };
}

// ---------------------------------------------------------------------------
// LINK / UNLINK.
//
// Memory ids ride the wire as u128 → `bigint`, like every other MemoryId field.
// ---------------------------------------------------------------------------

export interface LinkRequest {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  /** `[0, 1]` for most kinds; `[-1, 1]` for Contradicts. */
  weight: number;
  requestId: WireUuid;
  txnId: WireUuid | null;
}

export function encodeLink(p: LinkRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["source", p.source],
      ["target", p.target],
      ["kind", p.kind as number],
      ["weight", f32(p.weight)],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
    ]),
  );
}

export function decodeLink(bytes: Uint8Array): LinkRequest {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    weight: asNum(field(m, "weight")),
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
  };
}

export interface LinkResponse {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  weight: number;
  createdAtUnixNanos: bigint;
  /** `true` if the edge already existed (LINK overwrote its weight). */
  alreadyExisted: boolean;
}

export function encodeLinkResponse(p: LinkResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["source", p.source],
      ["target", p.target],
      ["kind", p.kind as number],
      ["weight", f32(p.weight)],
      ["created_at_unix_nanos", p.createdAtUnixNanos],
      ["already_existed", p.alreadyExisted],
    ]),
  );
}

export function decodeLinkResponse(bytes: Uint8Array): LinkResponse {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    weight: asNum(field(m, "weight")),
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    alreadyExisted: asBool(field(m, "already_existed")),
  };
}

export interface UnlinkRequest {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  requestId: WireUuid;
  txnId: WireUuid | null;
}

export function encodeUnlink(p: UnlinkRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["source", p.source],
      ["target", p.target],
      ["kind", p.kind as number],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
    ]),
  );
}

export function decodeUnlink(bytes: Uint8Array): UnlinkRequest {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
  };
}

export interface UnlinkResponse {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  /** `true` if the edge existed and was removed; `false` if it didn't exist. */
  removed: boolean;
}

export function encodeUnlinkResponse(p: UnlinkResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["source", p.source],
      ["target", p.target],
      ["kind", p.kind as number],
      ["removed", p.removed],
    ]),
  );
}

export function decodeUnlinkResponse(bytes: Uint8Array): UnlinkResponse {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    removed: asBool(field(m, "removed")),
  };
}

// ---------------------------------------------------------------------------
// PLAN.
// ---------------------------------------------------------------------------

export enum PlanStrategy {
  Auto = 0,
  AStar = 1,
  Mcts = 2,
  AttractorRollout = 3,
}

/** Plan endpoint. Externally tagged (one-entry map keyed by variant). */
export type PlanState =
  | { kind: "ByMemoryId"; memoryId: bigint }
  | { kind: "ByText"; text: string }
  | { kind: "ByVector"; offset: number; dim: number };

function encodePlanState(s: PlanState): unknown {
  switch (s.kind) {
    case "ByMemoryId":
      return new Map<string, unknown>([["ByMemoryId", s.memoryId]]);
    case "ByText":
      return new Map<string, unknown>([["ByText", s.text]]);
    case "ByVector":
      return new Map<string, unknown>([
        [
          "ByVector",
          new Map<string, unknown>([
            ["offset", s.offset],
            ["dim", s.dim],
          ]),
        ],
      ]);
  }
}

function decodePlanState(value: unknown): PlanState {
  const m = asMap(value);
  if (m.has("ByMemoryId")) return { kind: "ByMemoryId", memoryId: asBig(m.get("ByMemoryId")) };
  if (m.has("ByText")) return { kind: "ByText", text: asStr(m.get("ByText")) };
  if (m.has("ByVector")) {
    const inner = asMap(m.get("ByVector"));
    return {
      kind: "ByVector",
      offset: asNum(field(inner, "offset")),
      dim: asNum(field(inner, "dim")),
    };
  }
  throw new CborError("unknown PlanState variant");
}

export interface PlanBudget {
  maxSteps: number;
  maxWallTimeMs: number;
  maxBranchesExplored: number;
}

function encodePlanBudget(b: PlanBudget): Map<string, unknown> {
  return new Map<string, unknown>([
    ["max_steps", b.maxSteps],
    ["max_wall_time_ms", b.maxWallTimeMs],
    ["max_branches_explored", b.maxBranchesExplored],
  ]);
}

function decodePlanBudget(value: unknown): PlanBudget {
  const m = asMap(value);
  return {
    maxSteps: asNum(field(m, "max_steps")),
    maxWallTimeMs: asNum(field(m, "max_wall_time_ms")),
    maxBranchesExplored: asNum(field(m, "max_branches_explored")),
  };
}

export interface PlanRequest {
  start: PlanState;
  goal: PlanState;
  budget: PlanBudget;
  strategyHint: PlanStrategy | null;
  contextFilter: bigint[] | null;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
}

export function encodePlan(p: PlanRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["start", encodePlanState(p.start)],
      ["goal", encodePlanState(p.goal)],
      ["budget", encodePlanBudget(p.budget)],
      ["strategy_hint", p.strategyHint === null ? null : (p.strategyHint as number)],
      ["context_filter", p.contextFilter === null ? null : p.contextFilter],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
    ]),
  );
}

export function decodePlan(bytes: Uint8Array): PlanRequest {
  const m = asMap(fromCbor(bytes));
  return {
    start: decodePlanState(field(m, "start")),
    goal: decodePlanState(field(m, "goal")),
    budget: decodePlanBudget(field(m, "budget")),
    strategyHint: asOpt(field(m, "strategy_hint"), (v) => asNum(v) as PlanStrategy),
    contextFilter: asOpt(field(m, "context_filter"), (v) => asArray(v).map(asBig)),
    requestId: asOptBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
  };
}

export enum PlanStatus {
  GoalReached = 0,
  BudgetExhausted = 1,
  NoPathFound = 2,
  Cancelled = 3,
}

/** Transition kind between plan steps. Externally tagged; `Other` carries text. */
export type TransitionKind =
  | { kind: "Initial" }
  | { kind: "Causal" }
  | { kind: "Temporal" }
  | { kind: "Similarity" }
  | { kind: "Other"; value: string };

function encodeTransitionKind(t: TransitionKind): unknown {
  if (t.kind === "Other") return new Map<string, unknown>([["Other", t.value]]);
  return t.kind;
}

function decodeTransitionKind(value: unknown): TransitionKind {
  if (value === "Initial") return { kind: "Initial" };
  if (value === "Causal") return { kind: "Causal" };
  if (value === "Temporal") return { kind: "Temporal" };
  if (value === "Similarity") return { kind: "Similarity" };
  const m = asMap(value);
  if (m.has("Other")) return { kind: "Other", value: asStr(m.get("Other")) };
  throw new CborError("unknown TransitionKind variant");
}

export interface PlanStep {
  stepIndex: number;
  memoryId: bigint;
  text: string;
  transitionKind: TransitionKind;
  confidence: number;
  estimatedDistanceToGoal: number;
}

function encodePlanStep(s: PlanStep): Map<string, unknown> {
  return new Map<string, unknown>([
    ["step_index", s.stepIndex],
    ["memory_id", s.memoryId],
    ["text", s.text],
    ["transition_kind", encodeTransitionKind(s.transitionKind)],
    ["confidence", f32(s.confidence)],
    ["estimated_distance_to_goal", f32(s.estimatedDistanceToGoal)],
  ]);
}

function decodePlanStep(value: unknown): PlanStep {
  const m = asMap(value);
  return {
    stepIndex: asNum(field(m, "step_index")),
    memoryId: asBig(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    transitionKind: decodeTransitionKind(field(m, "transition_kind")),
    confidence: asNum(field(m, "confidence")),
    estimatedDistanceToGoal: asNum(field(m, "estimated_distance_to_goal")),
  };
}

export interface PlanResponseFrame {
  steps: PlanStep[];
  isFinal: boolean;
  planStatus: PlanStatus | null;
}

export function encodePlanResponse(p: PlanResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["steps", p.steps.map(encodePlanStep)],
      ["is_final", p.isFinal],
      ["plan_status", p.planStatus === null ? null : (p.planStatus as number)],
    ]),
  );
}

export function decodePlanResponse(bytes: Uint8Array): PlanResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    steps: asArray(field(m, "steps")).map(decodePlanStep),
    isFinal: asBool(field(m, "is_final")),
    planStatus: asOpt(field(m, "plan_status"), (v) => asNum(v) as PlanStatus),
  };
}

// ---------------------------------------------------------------------------
// REASON.
// ---------------------------------------------------------------------------

/** What to reason about. Externally tagged. */
export type ObservationInput =
  | { kind: "ByMemoryId"; memoryId: bigint }
  | { kind: "ByText"; text: string };

function encodeObservationInput(o: ObservationInput): unknown {
  if (o.kind === "ByMemoryId") return new Map<string, unknown>([["ByMemoryId", o.memoryId]]);
  return new Map<string, unknown>([["ByText", o.text]]);
}

function decodeObservationInput(value: unknown): ObservationInput {
  const m = asMap(value);
  if (m.has("ByMemoryId")) return { kind: "ByMemoryId", memoryId: asBig(m.get("ByMemoryId")) };
  if (m.has("ByText")) return { kind: "ByText", text: asStr(m.get("ByText")) };
  throw new CborError("unknown ObservationInput variant");
}

export interface ReasonRequest {
  observation: ObservationInput;
  depth: number;
  confidenceThreshold: number;
  contextFilter: bigint[] | null;
  maxInferences: number;
  budgetWallTimeMs: number;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
}

export function encodeReason(p: ReasonRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["observation", encodeObservationInput(p.observation)],
      ["depth", p.depth],
      ["confidence_threshold", f32(p.confidenceThreshold)],
      ["context_filter", p.contextFilter === null ? null : p.contextFilter],
      ["max_inferences", p.maxInferences],
      ["budget_wall_time_ms", p.budgetWallTimeMs],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
    ]),
  );
}

export function decodeReason(bytes: Uint8Array): ReasonRequest {
  const m = asMap(fromCbor(bytes));
  return {
    observation: decodeObservationInput(field(m, "observation")),
    depth: asNum(field(m, "depth")),
    confidenceThreshold: asNum(field(m, "confidence_threshold")),
    contextFilter: asOpt(field(m, "context_filter"), (v) => asArray(v).map(asBig)),
    maxInferences: asNum(field(m, "max_inferences")),
    budgetWallTimeMs: asNum(field(m, "budget_wall_time_ms")),
    requestId: asOptBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
  };
}

export enum ReasonStatus {
  Complete = 0,
  BudgetExhausted = 1,
  DepthLimitReached = 2,
  Cancelled = 3,
}

/** Inference kind. Externally tagged; `Other` carries text. */
export type InferenceKind =
  | { kind: "CausalExplanation" }
  | { kind: "EvidenceAccumulation" }
  | { kind: "AnalogicalInference" }
  | { kind: "Other"; value: string };

function encodeInferenceKind(i: InferenceKind): unknown {
  if (i.kind === "Other") return new Map<string, unknown>([["Other", i.value]]);
  return i.kind;
}

function decodeInferenceKind(value: unknown): InferenceKind {
  if (value === "CausalExplanation") return { kind: "CausalExplanation" };
  if (value === "EvidenceAccumulation") return { kind: "EvidenceAccumulation" };
  if (value === "AnalogicalInference") return { kind: "AnalogicalInference" };
  const m = asMap(value);
  if (m.has("Other")) return { kind: "Other", value: asStr(m.get("Other")) };
  throw new CborError("unknown InferenceKind variant");
}

export interface InferenceStep {
  stepIndex: number;
  claim: string;
  supportingMemories: bigint[];
  contradictingMemories: bigint[];
  confidence: number;
  inferenceKind: InferenceKind;
}

function encodeInferenceStep(s: InferenceStep): Map<string, unknown> {
  return new Map<string, unknown>([
    ["step_index", s.stepIndex],
    ["claim", s.claim],
    ["supporting_memories", s.supportingMemories],
    ["contradicting_memories", s.contradictingMemories],
    ["confidence", f32(s.confidence)],
    ["inference_kind", encodeInferenceKind(s.inferenceKind)],
  ]);
}

function decodeInferenceStep(value: unknown): InferenceStep {
  const m = asMap(value);
  return {
    stepIndex: asNum(field(m, "step_index")),
    claim: asStr(field(m, "claim")),
    supportingMemories: asArray(field(m, "supporting_memories")).map(asBig),
    contradictingMemories: asArray(field(m, "contradicting_memories")).map(asBig),
    confidence: asNum(field(m, "confidence")),
    inferenceKind: decodeInferenceKind(field(m, "inference_kind")),
  };
}

export interface ReasonResponseFrame {
  inferences: InferenceStep[];
  isFinal: boolean;
  reasonStatus: ReasonStatus | null;
}

export function encodeReasonResponse(p: ReasonResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["inferences", p.inferences.map(encodeInferenceStep)],
      ["is_final", p.isFinal],
      ["reason_status", p.reasonStatus === null ? null : (p.reasonStatus as number)],
    ]),
  );
}

export function decodeReasonResponse(bytes: Uint8Array): ReasonResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    inferences: asArray(field(m, "inferences")).map(decodeInferenceStep),
    isFinal: asBool(field(m, "is_final")),
    reasonStatus: asOpt(field(m, "reason_status"), (v) => asNum(v) as ReasonStatus),
  };
}

// ---------------------------------------------------------------------------
// TXN_BEGIN / TXN_COMMIT / TXN_ABORT.
// ---------------------------------------------------------------------------

export interface TxnBeginRequest {
  txnId: WireUuid;
  timeoutSeconds: number;
}

export function encodeTxnBegin(p: TxnBeginRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["timeout_seconds", p.timeoutSeconds],
    ]),
  );
}

export function decodeTxnBegin(bytes: Uint8Array): TxnBeginRequest {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    timeoutSeconds: asNum(field(m, "timeout_seconds")),
  };
}

export interface TxnBeginResponse {
  txnId: WireUuid;
  timeoutSeconds: number;
  startedAtUnixNanos: bigint;
}

export function encodeTxnBeginResponse(p: TxnBeginResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["timeout_seconds", p.timeoutSeconds],
      ["started_at_unix_nanos", p.startedAtUnixNanos],
    ]),
  );
}

export function decodeTxnBeginResponse(bytes: Uint8Array): TxnBeginResponse {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    timeoutSeconds: asNum(field(m, "timeout_seconds")),
    startedAtUnixNanos: asBig(field(m, "started_at_unix_nanos")),
  };
}

export interface TxnCommitRequest {
  txnId: WireUuid;
}

export function encodeTxnCommit(p: TxnCommitRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["txn_id", p.txnId]]));
}

export function decodeTxnCommit(bytes: Uint8Array): TxnCommitRequest {
  const m = asMap(fromCbor(bytes));
  return { txnId: asBytes(field(m, "txn_id")) };
}

export interface TxnCommitResponse {
  txnId: WireUuid;
  committedAtUnixNanos: bigint;
  operationsApplied: number;
}

export function encodeTxnCommitResponse(p: TxnCommitResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["committed_at_unix_nanos", p.committedAtUnixNanos],
      ["operations_applied", p.operationsApplied],
    ]),
  );
}

export function decodeTxnCommitResponse(bytes: Uint8Array): TxnCommitResponse {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    committedAtUnixNanos: asBig(field(m, "committed_at_unix_nanos")),
    operationsApplied: asNum(field(m, "operations_applied")),
  };
}

export interface TxnAbortRequest {
  txnId: WireUuid;
}

export function encodeTxnAbort(p: TxnAbortRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["txn_id", p.txnId]]));
}

export function decodeTxnAbort(bytes: Uint8Array): TxnAbortRequest {
  const m = asMap(fromCbor(bytes));
  return { txnId: asBytes(field(m, "txn_id")) };
}

export interface TxnAbortResponse {
  txnId: WireUuid;
  operationsDiscarded: number;
}

export function encodeTxnAbortResponse(p: TxnAbortResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["operations_discarded", p.operationsDiscarded],
    ]),
  );
}

export function decodeTxnAbortResponse(bytes: Uint8Array): TxnAbortResponse {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    operationsDiscarded: asNum(field(m, "operations_discarded")),
  };
}

// ---------------------------------------------------------------------------
// GET_CAPABILITIES.
// ---------------------------------------------------------------------------

/** Empty request body — capabilities are server-side state. */
export interface GetCapabilitiesRequest {}

export function encodeGetCapabilities(_p: GetCapabilitiesRequest): Uint8Array {
  return toCbor(new Map<string, unknown>());
}

export function decodeGetCapabilities(_bytes: Uint8Array): GetCapabilitiesRequest {
  return {};
}

export interface Capabilities {
  rerank: boolean;
  llmExtractor: boolean;
  classifierExtractor: boolean;
  patternExtractor: boolean;
  schemaNamespaces: string[];
  vectorDim: number;
}

export interface GetCapabilitiesResponse {
  capabilities: Capabilities;
}

export function encodeGetCapabilitiesResponse(p: GetCapabilitiesResponse): Uint8Array {
  const c = p.capabilities;
  return toCbor(
    new Map<string, unknown>([
      [
        "capabilities",
        new Map<string, unknown>([
          ["rerank", c.rerank],
          ["llm_extractor", c.llmExtractor],
          ["classifier_extractor", c.classifierExtractor],
          ["pattern_extractor", c.patternExtractor],
          ["schema_namespaces", c.schemaNamespaces],
          ["vector_dim", c.vectorDim],
        ]),
      ],
    ]),
  );
}

export function decodeGetCapabilitiesResponse(bytes: Uint8Array): GetCapabilitiesResponse {
  const m = asMap(fromCbor(bytes));
  const c = asMap(field(m, "capabilities"));
  return {
    capabilities: {
      rerank: asBool(field(c, "rerank")),
      llmExtractor: asBool(field(c, "llm_extractor")),
      classifierExtractor: asBool(field(c, "classifier_extractor")),
      patternExtractor: asBool(field(c, "pattern_extractor")),
      schemaNamespaces: asArray(field(c, "schema_namespaces")).map(asStr),
      vectorDim: asNum(field(c, "vector_dim")),
    },
  };
}

// ---------------------------------------------------------------------------
// ENTITY_GET / ENTITY_LIST.
// ---------------------------------------------------------------------------

export interface EntityView {
  entityId: WireUuid;
  entityTypeId: number;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  attributesBlob: Uint8Array;
  mentionCount: number;
  createdAtUnixNanos: bigint;
  updatedAtUnixNanos: bigint;
  /** All-zero (16 bytes) means "not merged". */
  mergedInto: WireUuid;
  embeddingVersion: number;
  flags: number;
}

function encodeEntityView(e: EntityView): Map<string, unknown> {
  return new Map<string, unknown>([
    ["entity_id", e.entityId],
    ["entity_type_id", e.entityTypeId],
    ["canonical_name", e.canonicalName],
    ["normalized_name", e.normalizedName],
    ["aliases", e.aliases],
    ["attributes_blob", Array.from(e.attributesBlob)],
    ["mention_count", e.mentionCount],
    ["created_at_unix_nanos", e.createdAtUnixNanos],
    ["updated_at_unix_nanos", e.updatedAtUnixNanos],
    ["merged_into", e.mergedInto],
    ["embedding_version", e.embeddingVersion],
    ["flags", e.flags],
  ]);
}

function decodeEntityView(value: unknown): EntityView {
  const m = asMap(value);
  return {
    entityId: asBytes(field(m, "entity_id")),
    entityTypeId: asNum(field(m, "entity_type_id")),
    canonicalName: asStr(field(m, "canonical_name")),
    normalizedName: asStr(field(m, "normalized_name")),
    aliases: asArray(field(m, "aliases")).map(asStr),
    attributesBlob: Uint8Array.from(asArray(field(m, "attributes_blob")).map(asNum)),
    mentionCount: asNum(field(m, "mention_count")),
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    updatedAtUnixNanos: asBig(field(m, "updated_at_unix_nanos")),
    mergedInto: asBytes(field(m, "merged_into")),
    embeddingVersion: asNum(field(m, "embedding_version")),
    flags: asNum(field(m, "flags")),
  };
}

export interface EntityGetRequest {
  entityId: WireUuid;
}

export function encodeEntityGet(p: EntityGetRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["entity_id", p.entityId]]));
}

export function decodeEntityGet(bytes: Uint8Array): EntityGetRequest {
  const m = asMap(fromCbor(bytes));
  return { entityId: asBytes(field(m, "entity_id")) };
}

export interface EntityGetResponse {
  entity: EntityView;
}

export function encodeEntityGetResponse(p: EntityGetResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["entity", encodeEntityView(p.entity)]]));
}

export function decodeEntityGetResponse(bytes: Uint8Array): EntityGetResponse {
  const m = asMap(fromCbor(bytes));
  return { entity: decodeEntityView(field(m, "entity")) };
}

export interface EntityListRequest {
  /** `0` = no filter. */
  entityTypeId: number;
  /** Empty = no filter. */
  namePrefix: string;
  mentionCountMin: number;
  includeTombstoned: boolean;
  includeMerged: boolean;
  /** 1..=1000. */
  limit: number;
  /** Empty on first page; opaque continuation token otherwise. */
  cursor: Uint8Array;
}

export function encodeEntityList(p: EntityListRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["entity_type_id", p.entityTypeId],
      ["name_prefix", p.namePrefix],
      ["mention_count_min", p.mentionCountMin],
      ["include_tombstoned", p.includeTombstoned],
      ["include_merged", p.includeMerged],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

export function decodeEntityList(bytes: Uint8Array): EntityListRequest {
  const m = asMap(fromCbor(bytes));
  return {
    entityTypeId: asNum(field(m, "entity_type_id")),
    namePrefix: asStr(field(m, "name_prefix")),
    mentionCountMin: asNum(field(m, "mention_count_min")),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    includeMerged: asBool(field(m, "include_merged")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

export interface EntityListItem {
  entity: EntityView;
}

export interface EntityListResponseFrame {
  items: EntityListItem[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

export function encodeEntityListResponse(p: EntityListResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      [
        "items",
        p.items.map((it) => new Map<string, unknown>([["entity", encodeEntityView(it.entity)]])),
      ],
      ["next_cursor", Array.from(p.nextCursor)],
      ["cumulative_count", p.cumulativeCount],
      ["is_final", p.isFinal],
    ]),
  );
}

export function decodeEntityListResponse(bytes: Uint8Array): EntityListResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map((v) => ({
      entity: decodeEntityView(field(asMap(v), "entity")),
    })),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// ENTITY_RESOLVE.
// ---------------------------------------------------------------------------

export interface EntityResolveRequest {
  candidateName: string;
  context: string;
  /** `0` = no hint; otherwise an entity type id. */
  entityTypeHint: number;
  allowCreate: boolean;
  requestId: WireUuid;
}

export function encodeEntityResolve(p: EntityResolveRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["candidate_name", p.candidateName],
      ["context", p.context],
      ["entity_type_hint", p.entityTypeHint],
      ["allow_create", p.allowCreate],
      ["request_id", p.requestId],
    ]),
  );
}

export function decodeEntityResolve(bytes: Uint8Array): EntityResolveRequest {
  const m = asMap(fromCbor(bytes));
  return {
    candidateName: asStr(field(m, "candidate_name")),
    context: asStr(field(m, "context")),
    entityTypeHint: asNum(field(m, "entity_type_hint")),
    allowCreate: asBool(field(m, "allow_create")),
    requestId: asBytes(field(m, "request_id")),
  };
}

export interface EntityResolveResponse {
  outcome: ResolutionOutcomeWire;
  /** Which tier resolved (1..=5; 0 if unresolved). */
  tier: number;
  confidence: number;
  /** All-zero (16 bytes) for Ambiguous / NotFound. */
  resolvedEntity: WireUuid;
  /** Populated when `outcome === Ambiguous`; ranked by score. */
  candidateIds: WireUuid[];
  /** All-zero (16 bytes) unless an ambiguity audit was written. */
  auditId: WireUuid;
}

export function encodeEntityResolveResponse(p: EntityResolveResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["outcome", p.outcome],
      ["tier", p.tier],
      ["confidence", f32(p.confidence)],
      ["resolved_entity", p.resolvedEntity],
      ["candidate_ids", p.candidateIds],
      ["audit_id", p.auditId],
    ]),
  );
}

export function decodeEntityResolveResponse(bytes: Uint8Array): EntityResolveResponse {
  const m = asMap(fromCbor(bytes));
  return {
    outcome: asNum(field(m, "outcome")) as ResolutionOutcomeWire,
    tier: asNum(field(m, "tier")),
    confidence: asNum(field(m, "confidence")),
    resolvedEntity: asBytes(field(m, "resolved_entity")),
    candidateIds: asArray(field(m, "candidate_ids")).map(asBytes),
    auditId: asBytes(field(m, "audit_id")),
  };
}

// ---------------------------------------------------------------------------
// STATEMENT_GET / STATEMENT_LIST.
// ---------------------------------------------------------------------------

export interface StatementView {
  statementId: WireUuid;
  kind: StatementKindWire;
  subject: WireUuid;
  subjectPendingAuditId: WireUuid;
  predicate: string;
  object: StatementObjectWire;
  confidence: number;
  evidence: EvidenceRefWire;
  extractorId: number;
  extractedAtUnixNanos: bigint;
  schemaVersion: number;
  validFromUnixNanos: bigint;
  validToUnixNanos: bigint;
  eventAtUnixNanos: bigint;
  version: number;
  supersededBy: WireUuid;
  supersedes: WireUuid;
  chainRoot: WireUuid;
  tombstoned: boolean;
  tombstonedAtUnixNanos: bigint;
  tombstoneReason: number;
  flags: number;
  isStateful: boolean;
}

function encodeStatementView(s: StatementView): Map<string, unknown> {
  return new Map<string, unknown>([
    ["statement_id", s.statementId],
    ["kind", s.kind],
    ["subject", s.subject],
    ["subject_pending_audit_id", s.subjectPendingAuditId],
    ["predicate", s.predicate],
    ["object", encodeStatementObject(s.object)],
    ["confidence", f32(s.confidence)],
    ["evidence", encodeEvidence(s.evidence)],
    ["extractor_id", s.extractorId],
    ["extracted_at_unix_nanos", s.extractedAtUnixNanos],
    ["schema_version", s.schemaVersion],
    ["valid_from_unix_nanos", s.validFromUnixNanos],
    ["valid_to_unix_nanos", s.validToUnixNanos],
    ["event_at_unix_nanos", s.eventAtUnixNanos],
    ["version", s.version],
    ["superseded_by", s.supersededBy],
    ["supersedes", s.supersedes],
    ["chain_root", s.chainRoot],
    ["tombstoned", s.tombstoned],
    ["tombstoned_at_unix_nanos", s.tombstonedAtUnixNanos],
    ["tombstone_reason", s.tombstoneReason],
    ["flags", s.flags],
    ["is_stateful", s.isStateful],
  ]);
}

function decodeStatementView(value: unknown): StatementView {
  const m = asMap(value);
  return {
    statementId: asBytes(field(m, "statement_id")),
    kind: asStr(field(m, "kind")) as StatementKindWire,
    subject: asBytes(field(m, "subject")),
    subjectPendingAuditId: asBytes(field(m, "subject_pending_audit_id")),
    predicate: asStr(field(m, "predicate")),
    object: decodeStatementObject(field(m, "object")),
    confidence: asNum(field(m, "confidence")),
    evidence: decodeEvidence(field(m, "evidence")),
    extractorId: asNum(field(m, "extractor_id")),
    extractedAtUnixNanos: asBig(field(m, "extracted_at_unix_nanos")),
    schemaVersion: asNum(field(m, "schema_version")),
    validFromUnixNanos: asBig(field(m, "valid_from_unix_nanos")),
    validToUnixNanos: asBig(field(m, "valid_to_unix_nanos")),
    eventAtUnixNanos: asBig(field(m, "event_at_unix_nanos")),
    version: asNum(field(m, "version")),
    supersededBy: asBytes(field(m, "superseded_by")),
    supersedes: asBytes(field(m, "supersedes")),
    chainRoot: asBytes(field(m, "chain_root")),
    tombstoned: asBool(field(m, "tombstoned")),
    tombstonedAtUnixNanos: asBig(field(m, "tombstoned_at_unix_nanos")),
    tombstoneReason: asNum(field(m, "tombstone_reason")),
    flags: asNum(field(m, "flags")),
    isStateful: asBool(field(m, "is_stateful")),
  };
}

export interface StatementGetRequest {
  statementId: WireUuid;
  followSupersession: boolean;
}

export function encodeStatementGet(p: StatementGetRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement_id", p.statementId],
      ["follow_supersession", p.followSupersession],
    ]),
  );
}

export function decodeStatementGet(bytes: Uint8Array): StatementGetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    statementId: asBytes(field(m, "statement_id")),
    followSupersession: asBool(field(m, "follow_supersession")),
  };
}

export interface StatementGetResponse {
  statement: StatementView;
  returnedViaSupersession: boolean;
}

export function encodeStatementGetResponse(p: StatementGetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement", encodeStatementView(p.statement)],
      ["returned_via_supersession", p.returnedViaSupersession],
    ]),
  );
}

export function decodeStatementGetResponse(bytes: Uint8Array): StatementGetResponse {
  const m = asMap(fromCbor(bytes));
  return {
    statement: decodeStatementView(field(m, "statement")),
    returnedViaSupersession: asBool(field(m, "returned_via_supersession")),
  };
}

export interface StatementListRequest {
  subject: WireUuid;
  predicate: string;
  /** `0` = no kind filter; `1`=Fact / `2`=Preference / `3`=Event. */
  kind: number;
  minConfidence: number;
  timeRangeStartUnixNanos: bigint;
  timeRangeEndUnixNanos: bigint;
  onlyCurrent: boolean;
  includeTombstoned: boolean;
  limit: number;
  cursor: Uint8Array;
}

export function encodeStatementList(p: StatementListRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["subject", p.subject],
      ["predicate", p.predicate],
      ["kind", p.kind],
      ["min_confidence", f32(p.minConfidence)],
      ["time_range_start_unix_nanos", p.timeRangeStartUnixNanos],
      ["time_range_end_unix_nanos", p.timeRangeEndUnixNanos],
      ["only_current", p.onlyCurrent],
      ["include_tombstoned", p.includeTombstoned],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

export function decodeStatementList(bytes: Uint8Array): StatementListRequest {
  const m = asMap(fromCbor(bytes));
  return {
    subject: asBytes(field(m, "subject")),
    predicate: asStr(field(m, "predicate")),
    kind: asNum(field(m, "kind")),
    minConfidence: asNum(field(m, "min_confidence")),
    timeRangeStartUnixNanos: asBig(field(m, "time_range_start_unix_nanos")),
    timeRangeEndUnixNanos: asBig(field(m, "time_range_end_unix_nanos")),
    onlyCurrent: asBool(field(m, "only_current")),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

export interface StatementListResponseFrame {
  items: StatementView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

export function encodeStatementListResponse(p: StatementListResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["items", p.items.map(encodeStatementView)],
      ["next_cursor", Array.from(p.nextCursor)],
      ["cumulative_count", p.cumulativeCount],
      ["is_final", p.isFinal],
    ]),
  );
}

export function decodeStatementListResponse(bytes: Uint8Array): StatementListResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeStatementView),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// RELATION_LIST_FROM / RELATION_LIST_TO.
// ---------------------------------------------------------------------------

export interface RelationView {
  relationId: WireUuid;
  chainRoot: WireUuid;
  relationType: string;
  fromEntity: WireUuid;
  toEntity: WireUuid;
  propertiesBlob: Uint8Array;
  evidence: EvidenceRefWire;
  extractorId: number;
  extractedAtUnixNanos: bigint;
  confidence: number;
  validFromUnixNanos: bigint;
  validToUnixNanos: bigint;
  version: number;
  supersededBy: WireUuid;
  supersedes: WireUuid;
  tombstoned: boolean;
  tombstonedAtUnixNanos: bigint;
  flags: number;
}

function encodeRelationView(r: RelationView): Map<string, unknown> {
  return new Map<string, unknown>([
    ["relation_id", r.relationId],
    ["chain_root", r.chainRoot],
    ["relation_type", r.relationType],
    ["from_entity", r.fromEntity],
    ["to_entity", r.toEntity],
    ["properties_blob", Array.from(r.propertiesBlob)],
    ["evidence", encodeEvidence(r.evidence)],
    ["extractor_id", r.extractorId],
    ["extracted_at_unix_nanos", r.extractedAtUnixNanos],
    ["confidence", f32(r.confidence)],
    ["valid_from_unix_nanos", r.validFromUnixNanos],
    ["valid_to_unix_nanos", r.validToUnixNanos],
    ["version", r.version],
    ["superseded_by", r.supersededBy],
    ["supersedes", r.supersedes],
    ["tombstoned", r.tombstoned],
    ["tombstoned_at_unix_nanos", r.tombstonedAtUnixNanos],
    ["flags", r.flags],
  ]);
}

function decodeRelationView(value: unknown): RelationView {
  const m = asMap(value);
  return {
    relationId: asBytes(field(m, "relation_id")),
    chainRoot: asBytes(field(m, "chain_root")),
    relationType: asStr(field(m, "relation_type")),
    fromEntity: asBytes(field(m, "from_entity")),
    toEntity: asBytes(field(m, "to_entity")),
    propertiesBlob: Uint8Array.from(asArray(field(m, "properties_blob")).map(asNum)),
    evidence: decodeEvidence(field(m, "evidence")),
    extractorId: asNum(field(m, "extractor_id")),
    extractedAtUnixNanos: asBig(field(m, "extracted_at_unix_nanos")),
    confidence: asNum(field(m, "confidence")),
    validFromUnixNanos: asBig(field(m, "valid_from_unix_nanos")),
    validToUnixNanos: asBig(field(m, "valid_to_unix_nanos")),
    version: asNum(field(m, "version")),
    supersededBy: asBytes(field(m, "superseded_by")),
    supersedes: asBytes(field(m, "supersedes")),
    tombstoned: asBool(field(m, "tombstoned")),
    tombstonedAtUnixNanos: asBig(field(m, "tombstoned_at_unix_nanos")),
    flags: asNum(field(m, "flags")),
  };
}

export interface RelationListFromRequest {
  fromEntity: WireUuid;
  relationTypeFilter: string;
  timeRangeStartUnixNanos: bigint;
  timeRangeEndUnixNanos: bigint;
  includeSuperseded: boolean;
  includeTombstoned: boolean;
  limit: number;
  cursor: Uint8Array;
}

export function encodeRelationListFrom(p: RelationListFromRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["from_entity", p.fromEntity],
      ["relation_type_filter", p.relationTypeFilter],
      ["time_range_start_unix_nanos", p.timeRangeStartUnixNanos],
      ["time_range_end_unix_nanos", p.timeRangeEndUnixNanos],
      ["include_superseded", p.includeSuperseded],
      ["include_tombstoned", p.includeTombstoned],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

export function decodeRelationListFrom(bytes: Uint8Array): RelationListFromRequest {
  const m = asMap(fromCbor(bytes));
  return {
    fromEntity: asBytes(field(m, "from_entity")),
    relationTypeFilter: asStr(field(m, "relation_type_filter")),
    timeRangeStartUnixNanos: asBig(field(m, "time_range_start_unix_nanos")),
    timeRangeEndUnixNanos: asBig(field(m, "time_range_end_unix_nanos")),
    includeSuperseded: asBool(field(m, "include_superseded")),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

export interface RelationListFromResponseFrame {
  items: RelationView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

export function encodeRelationListFromResponse(p: RelationListFromResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["items", p.items.map(encodeRelationView)],
      ["next_cursor", Array.from(p.nextCursor)],
      ["cumulative_count", p.cumulativeCount],
      ["is_final", p.isFinal],
    ]),
  );
}

export function decodeRelationListFromResponse(bytes: Uint8Array): RelationListFromResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeRelationView),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

export interface RelationListToRequest {
  toEntity: WireUuid;
  relationTypeFilter: string;
  timeRangeStartUnixNanos: bigint;
  timeRangeEndUnixNanos: bigint;
  includeSuperseded: boolean;
  includeTombstoned: boolean;
  limit: number;
  cursor: Uint8Array;
}

export function encodeRelationListTo(p: RelationListToRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["to_entity", p.toEntity],
      ["relation_type_filter", p.relationTypeFilter],
      ["time_range_start_unix_nanos", p.timeRangeStartUnixNanos],
      ["time_range_end_unix_nanos", p.timeRangeEndUnixNanos],
      ["include_superseded", p.includeSuperseded],
      ["include_tombstoned", p.includeTombstoned],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

export function decodeRelationListTo(bytes: Uint8Array): RelationListToRequest {
  const m = asMap(fromCbor(bytes));
  return {
    toEntity: asBytes(field(m, "to_entity")),
    relationTypeFilter: asStr(field(m, "relation_type_filter")),
    timeRangeStartUnixNanos: asBig(field(m, "time_range_start_unix_nanos")),
    timeRangeEndUnixNanos: asBig(field(m, "time_range_end_unix_nanos")),
    includeSuperseded: asBool(field(m, "include_superseded")),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

export interface RelationListToResponseFrame {
  items: RelationView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

export function encodeRelationListToResponse(p: RelationListToResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["items", p.items.map(encodeRelationView)],
      ["next_cursor", Array.from(p.nextCursor)],
      ["cumulative_count", p.cumulativeCount],
      ["is_final", p.isFinal],
    ]),
  );
}

export function decodeRelationListToResponse(bytes: Uint8Array): RelationListToResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeRelationView),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// SCHEMA_GET / SCHEMA_LIST / SCHEMA_VALIDATE.
// ---------------------------------------------------------------------------

export interface SchemaGetRequest {
  namespace: string;
  /** `0` = active version. */
  version: number;
}

export function encodeSchemaGet(p: SchemaGetRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["version", p.version],
    ]),
  );
}

export function decodeSchemaGet(bytes: Uint8Array): SchemaGetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    version: asNum(field(m, "version")),
  };
}

export interface SchemaGetResponse {
  namespace: string;
  schemaVersion: number;
  schemaDocument: string;
  sourceBlob: Uint8Array;
  uploadedAtUnixNanos: bigint;
  validatorVersion: number;
}

export function encodeSchemaGetResponse(p: SchemaGetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["schema_version", p.schemaVersion],
      ["schema_document", p.schemaDocument],
      ["source_blob", Array.from(p.sourceBlob)],
      ["uploaded_at_unix_nanos", p.uploadedAtUnixNanos],
      ["validator_version", p.validatorVersion],
    ]),
  );
}

export function decodeSchemaGetResponse(bytes: Uint8Array): SchemaGetResponse {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    schemaVersion: asNum(field(m, "schema_version")),
    schemaDocument: asStr(field(m, "schema_document")),
    sourceBlob: Uint8Array.from(asArray(field(m, "source_blob")).map(asNum)),
    uploadedAtUnixNanos: asBig(field(m, "uploaded_at_unix_nanos")),
    validatorVersion: asNum(field(m, "validator_version")),
  };
}

export interface SchemaListRequest {
  namespace: string;
  /** `0` = unlimited (server-capped). */
  limit: number;
  cursor: Uint8Array;
}

export function encodeSchemaList(p: SchemaListRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

export function decodeSchemaList(bytes: Uint8Array): SchemaListRequest {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

export interface SchemaListItemWire {
  schemaVersion: number;
  uploadedAtUnixNanos: bigint;
  validatorVersion: number;
  hasSourceText: boolean;
}

function encodeSchemaListItem(s: SchemaListItemWire): Map<string, unknown> {
  return new Map<string, unknown>([
    ["schema_version", s.schemaVersion],
    ["uploaded_at_unix_nanos", s.uploadedAtUnixNanos],
    ["validator_version", s.validatorVersion],
    ["has_source_text", s.hasSourceText],
  ]);
}

function decodeSchemaListItem(value: unknown): SchemaListItemWire {
  const m = asMap(value);
  return {
    schemaVersion: asNum(field(m, "schema_version")),
    uploadedAtUnixNanos: asBig(field(m, "uploaded_at_unix_nanos")),
    validatorVersion: asNum(field(m, "validator_version")),
    hasSourceText: asBool(field(m, "has_source_text")),
  };
}

export interface SchemaListResponseFrame {
  namespace: string;
  items: SchemaListItemWire[];
  total: number;
  nextCursor: Uint8Array;
  isFinal: boolean;
}

export function encodeSchemaListResponse(p: SchemaListResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["items", p.items.map(encodeSchemaListItem)],
      ["total", p.total],
      ["next_cursor", Array.from(p.nextCursor)],
      ["is_final", p.isFinal],
    ]),
  );
}

export function decodeSchemaListResponse(bytes: Uint8Array): SchemaListResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    items: asArray(field(m, "items")).map(decodeSchemaListItem),
    total: asNum(field(m, "total")),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    isFinal: asBool(field(m, "is_final")),
  };
}

export interface SchemaValidateRequest {
  schemaDocument: string;
}

export function encodeSchemaValidate(p: SchemaValidateRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["schema_document", p.schemaDocument]]));
}

export function decodeSchemaValidate(bytes: Uint8Array): SchemaValidateRequest {
  const m = asMap(fromCbor(bytes));
  return { schemaDocument: asStr(field(m, "schema_document")) };
}

export interface SchemaValidateResponse {
  namespace: string;
  /** `current_active + 1` if validation passed; `0` otherwise. */
  wouldBeVersion: number;
  validationErrors: SchemaValidationErrorWire[];
}

export function encodeSchemaValidateResponse(p: SchemaValidateResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["would_be_version", p.wouldBeVersion],
      [
        "validation_errors",
        p.validationErrors.map(
          (e) =>
            new Map<string, unknown>([
              ["code", e.code],
              ["message", e.message],
              ["line", e.line],
              ["column", e.column],
              ["length", e.length],
              ["severity", e.severity],
            ]),
        ),
      ],
    ]),
  );
}

export function decodeSchemaValidateResponse(bytes: Uint8Array): SchemaValidateResponse {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    wouldBeVersion: asNum(field(m, "would_be_version")),
    validationErrors: asArray(field(m, "validation_errors")).map((v) => {
      const e = asMap(v);
      return {
        code: asStr(field(e, "code")),
        message: asStr(field(e, "message")),
        line: asNum(field(e, "line")),
        column: asNum(field(e, "column")),
        length: asNum(field(e, "length")),
        severity: asNum(field(e, "severity")),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// SUBSCRIBE / UNSUBSCRIBE + the subscription event union.
// ---------------------------------------------------------------------------

export enum EventType {
  Encoded = 0,
  Forgotten = 1,
  Reclaimed = 2,
  KindChanged = 3,
  EntityCreated = 16,
  EntityUpdated = 17,
  EntityRenamed = 18,
  EntityMerged = 19,
  EntityUnmerged = 20,
  EntityTombstoned = 21,
  StatementCreated = 22,
  StatementSuperseded = 23,
  StatementTombstoned = 24,
  RelationCreated = 25,
  RelationSuperseded = 26,
  StageCompleted = 27,
  SchemaUpdated = 29,
  RelationTombstoned = 30,
  EdgeAdded = 31,
  EdgeRemoved = 32,
  EdgeSuperseded = 33,
}

export enum StageOutcome {
  Ok = 0,
  Empty = 1,
  Failed = 2,
}

export enum StageAuditStatus {
  Succeeded = 0,
  PartiallyApplied = 1,
  Failed = 2,
  Skipped = 3,
}

export interface StageAutoEdgePayload {
  edgesWritten: number;
}

export interface StageTemporalEdgePayload {
  edgesWritten: number;
}

export interface StageExtractorPayload {
  entityCount: number;
  statementCount: number;
  relationCount: number;
  auditStatus: StageAuditStatus;
  errorMessage: string;
}

/** Per-stage detail sidecar on StageCompleted events. Externally tagged. */
export type StagePayload =
  | { kind: "AutoEdge"; value: StageAutoEdgePayload }
  | { kind: "TemporalEdge"; value: StageTemporalEdgePayload }
  | { kind: "Extractor"; value: StageExtractorPayload };

function encodeStagePayload(s: StagePayload): unknown {
  switch (s.kind) {
    case "AutoEdge":
      return new Map<string, unknown>([
        ["AutoEdge", new Map<string, unknown>([["edges_written", s.value.edgesWritten]])],
      ]);
    case "TemporalEdge":
      return new Map<string, unknown>([
        ["TemporalEdge", new Map<string, unknown>([["edges_written", s.value.edgesWritten]])],
      ]);
    case "Extractor":
      return new Map<string, unknown>([
        [
          "Extractor",
          new Map<string, unknown>([
            ["entity_count", s.value.entityCount],
            ["statement_count", s.value.statementCount],
            ["relation_count", s.value.relationCount],
            ["audit_status", s.value.auditStatus as number],
            ["error_message", s.value.errorMessage],
          ]),
        ],
      ]);
  }
}

function decodeStagePayload(value: unknown): StagePayload {
  const m = asMap(value);
  if (m.has("AutoEdge")) {
    const inner = asMap(m.get("AutoEdge"));
    return { kind: "AutoEdge", value: { edgesWritten: asNum(field(inner, "edges_written")) } };
  }
  if (m.has("TemporalEdge")) {
    const inner = asMap(m.get("TemporalEdge"));
    return {
      kind: "TemporalEdge",
      value: { edgesWritten: asNum(field(inner, "edges_written")) },
    };
  }
  if (m.has("Extractor")) {
    const inner = asMap(m.get("Extractor"));
    return {
      kind: "Extractor",
      value: {
        entityCount: asNum(field(inner, "entity_count")),
        statementCount: asNum(field(inner, "statement_count")),
        relationCount: asNum(field(inner, "relation_count")),
        auditStatus: asNum(field(inner, "audit_status")) as StageAuditStatus,
        errorMessage: asStr(field(inner, "error_message")),
      },
    };
  }
  throw new CborError("unknown StagePayload variant");
}

export interface SimilarityFilter {
  referenceMemoryId: bigint;
  threshold: number;
}

export interface SubscriptionFilter {
  contexts: bigint[] | null;
  kinds: MemoryKindWire[] | null;
  similarTo: SimilarityFilter | null;
  agents: WireUuid[] | null;
}

function encodeSubscriptionFilter(f: SubscriptionFilter): Map<string, unknown> {
  return new Map<string, unknown>([
    ["contexts", f.contexts === null ? null : f.contexts],
    ["kinds", f.kinds === null ? null : f.kinds.map((k) => k as number)],
    [
      "similar_to",
      f.similarTo === null
        ? null
        : new Map<string, unknown>([
            ["reference_memory_id", f.similarTo.referenceMemoryId],
            ["threshold", f32(f.similarTo.threshold)],
          ]),
    ],
    ["agents", f.agents === null ? null : f.agents],
  ]);
}

function decodeSubscriptionFilter(value: unknown): SubscriptionFilter {
  const m = asMap(value);
  return {
    contexts: asOpt(field(m, "contexts"), (v) => asArray(v).map(asBig)),
    kinds: asOpt(field(m, "kinds"), (v) => asArray(v).map((k) => asNum(k) as MemoryKindWire)),
    similarTo: asOpt(field(m, "similar_to"), (v) => {
      const sf = asMap(v);
      return {
        referenceMemoryId: asBig(field(sf, "reference_memory_id")),
        threshold: asNum(field(sf, "threshold")),
      };
    }),
    agents: asOpt(field(m, "agents"), (v) => asArray(v).map(asBytes)),
  };
}

export interface SubscribeRequest {
  filter: SubscriptionFilter;
  includeHistory: boolean;
  fromLsn: bigint | null;
  maxInflight: number;
}

export function encodeSubscribe(p: SubscribeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["filter", encodeSubscriptionFilter(p.filter)],
      ["include_history", p.includeHistory],
      ["from_lsn", p.fromLsn],
      ["max_inflight", p.maxInflight],
    ]),
  );
}

export function decodeSubscribe(bytes: Uint8Array): SubscribeRequest {
  const m = asMap(fromCbor(bytes));
  return {
    filter: decodeSubscriptionFilter(field(m, "filter")),
    includeHistory: asBool(field(m, "include_history")),
    fromLsn: asOpt(field(m, "from_lsn"), asBig),
    maxInflight: asNum(field(m, "max_inflight")),
  };
}

export interface EdgeEventPayload {
  /** `0` = Memory, `1` = Entity. */
  fromKind: number;
  fromId: WireUuid;
  toKind: number;
  toId: WireUuid;
  /** `0` = Builtin, `1` = Mentions, `2` = Typed relation. */
  edgeKindTag: number;
  edgeKindByte: number;
  relationTypeId: number | null;
  weight: number;
  relationId: WireUuid | null;
  supersededRelationId: WireUuid | null;
  /** `0` = EXPLICIT, `1` = AUTO_DERIVED. */
  origin: number;
}

function encodeEdgeEventPayload(e: EdgeEventPayload): Map<string, unknown> {
  return new Map<string, unknown>([
    ["from_kind", e.fromKind],
    ["from_id", e.fromId],
    ["to_kind", e.toKind],
    ["to_id", e.toId],
    ["edge_kind_tag", e.edgeKindTag],
    ["edge_kind_byte", e.edgeKindByte],
    ["relation_type_id", e.relationTypeId],
    ["weight", f32(e.weight)],
    ["relation_id", e.relationId],
    ["superseded_relation_id", e.supersededRelationId],
    ["origin", e.origin],
  ]);
}

function decodeEdgeEventPayload(value: unknown): EdgeEventPayload {
  const m = asMap(value);
  return {
    fromKind: asNum(field(m, "from_kind")),
    fromId: asBytes(field(m, "from_id")),
    toKind: asNum(field(m, "to_kind")),
    toId: asBytes(field(m, "to_id")),
    edgeKindTag: asNum(field(m, "edge_kind_tag")),
    edgeKindByte: asNum(field(m, "edge_kind_byte")),
    relationTypeId: asOpt(field(m, "relation_type_id"), asNum),
    weight: asNum(field(m, "weight")),
    relationId: asOptBytes(field(m, "relation_id")),
    supersededRelationId: asOptBytes(field(m, "superseded_relation_id")),
    origin: asNum(field(m, "origin")),
  };
}

// Typed-graph subscription event bodies.

export interface EntityCreatedEvent {
  entityId: WireUuid;
  entityTypeId: number;
  canonicalName: string;
}

export interface EntityUpdatedEvent {
  entityId: WireUuid;
  entityTypeId: number;
  canonicalName: string;
  embeddingVersionChanged: boolean;
}

export interface EntityRenamedEvent {
  entityId: WireUuid;
  oldCanonicalName: string;
  newCanonicalName: string;
  oldMovedToAlias: boolean;
}

export interface EntityMergedEvent {
  survivor: WireUuid;
  merged: WireUuid;
  auditId: WireUuid;
  confidence: number;
  statementsRerouted: number;
  relationsRerouted: number;
}

export interface EntityUnmergedEvent {
  restoredEntityId: WireUuid;
  fromSurvivor: WireUuid;
  auditId: WireUuid;
}

export interface EntityTombstonedEvent {
  entityId: WireUuid;
  reason: string;
}

export interface StatementCreatedEvent {
  statementId: WireUuid;
  /** `1`=Fact, `2`=Preference, `3`=Event. */
  kind: number;
  subject: WireUuid;
  predicate: string;
  confidence: number;
}

export interface StatementSupersededEvent {
  oldStatementId: WireUuid;
  newStatementId: WireUuid;
  chainRoot: WireUuid;
}

export interface StatementTombstonedEvent {
  statementId: WireUuid;
  reason: string;
}

export interface RelationCreatedEvent {
  relationId: WireUuid;
  relationType: string;
  from: WireUuid;
  to: WireUuid;
}

export interface RelationSupersededEvent {
  oldRelationId: WireUuid;
  newRelationId: WireUuid;
}

export interface RelationTombstonedEvent {
  relationId: WireUuid;
  reason: string;
}

export interface SchemaUpdatedEvent {
  namespace: string;
  fromVersion: number;
  toVersion: number;
  backwardCompatible: boolean;
}

/** Typed-graph event body. Externally tagged (one-entry map keyed by variant). */
export type GraphEventPayload =
  | { kind: "EntityCreated"; value: EntityCreatedEvent }
  | { kind: "EntityUpdated"; value: EntityUpdatedEvent }
  | { kind: "EntityRenamed"; value: EntityRenamedEvent }
  | { kind: "EntityMerged"; value: EntityMergedEvent }
  | { kind: "EntityUnmerged"; value: EntityUnmergedEvent }
  | { kind: "EntityTombstoned"; value: EntityTombstonedEvent }
  | { kind: "StatementCreated"; value: StatementCreatedEvent }
  | { kind: "StatementSuperseded"; value: StatementSupersededEvent }
  | { kind: "StatementTombstoned"; value: StatementTombstonedEvent }
  | { kind: "RelationCreated"; value: RelationCreatedEvent }
  | { kind: "RelationSuperseded"; value: RelationSupersededEvent }
  | { kind: "RelationTombstoned"; value: RelationTombstonedEvent }
  | { kind: "SchemaUpdated"; value: SchemaUpdatedEvent };

function encodeGraphEventPayload(g: GraphEventPayload): unknown {
  let inner: Map<string, unknown>;
  switch (g.kind) {
    case "EntityCreated":
      inner = new Map<string, unknown>([
        ["entity_id", g.value.entityId],
        ["entity_type_id", g.value.entityTypeId],
        ["canonical_name", g.value.canonicalName],
      ]);
      break;
    case "EntityUpdated":
      inner = new Map<string, unknown>([
        ["entity_id", g.value.entityId],
        ["entity_type_id", g.value.entityTypeId],
        ["canonical_name", g.value.canonicalName],
        ["embedding_version_changed", g.value.embeddingVersionChanged],
      ]);
      break;
    case "EntityRenamed":
      inner = new Map<string, unknown>([
        ["entity_id", g.value.entityId],
        ["old_canonical_name", g.value.oldCanonicalName],
        ["new_canonical_name", g.value.newCanonicalName],
        ["old_moved_to_alias", g.value.oldMovedToAlias],
      ]);
      break;
    case "EntityMerged":
      inner = new Map<string, unknown>([
        ["survivor", g.value.survivor],
        ["merged", g.value.merged],
        ["audit_id", g.value.auditId],
        ["confidence", f32(g.value.confidence)],
        ["statements_rerouted", g.value.statementsRerouted],
        ["relations_rerouted", g.value.relationsRerouted],
      ]);
      break;
    case "EntityUnmerged":
      inner = new Map<string, unknown>([
        ["restored_entity_id", g.value.restoredEntityId],
        ["from_survivor", g.value.fromSurvivor],
        ["audit_id", g.value.auditId],
      ]);
      break;
    case "EntityTombstoned":
      inner = new Map<string, unknown>([
        ["entity_id", g.value.entityId],
        ["reason", g.value.reason],
      ]);
      break;
    case "StatementCreated":
      inner = new Map<string, unknown>([
        ["statement_id", g.value.statementId],
        ["kind", g.value.kind],
        ["subject", g.value.subject],
        ["predicate", g.value.predicate],
        ["confidence", f32(g.value.confidence)],
      ]);
      break;
    case "StatementSuperseded":
      inner = new Map<string, unknown>([
        ["old_statement_id", g.value.oldStatementId],
        ["new_statement_id", g.value.newStatementId],
        ["chain_root", g.value.chainRoot],
      ]);
      break;
    case "StatementTombstoned":
      inner = new Map<string, unknown>([
        ["statement_id", g.value.statementId],
        ["reason", g.value.reason],
      ]);
      break;
    case "RelationCreated":
      inner = new Map<string, unknown>([
        ["relation_id", g.value.relationId],
        ["relation_type", g.value.relationType],
        ["from", g.value.from],
        ["to", g.value.to],
      ]);
      break;
    case "RelationSuperseded":
      inner = new Map<string, unknown>([
        ["old_relation_id", g.value.oldRelationId],
        ["new_relation_id", g.value.newRelationId],
      ]);
      break;
    case "RelationTombstoned":
      inner = new Map<string, unknown>([
        ["relation_id", g.value.relationId],
        ["reason", g.value.reason],
      ]);
      break;
    case "SchemaUpdated":
      inner = new Map<string, unknown>([
        ["namespace", g.value.namespace],
        ["from_version", g.value.fromVersion],
        ["to_version", g.value.toVersion],
        ["backward_compatible", g.value.backwardCompatible],
      ]);
      break;
  }
  return new Map<string, unknown>([[g.kind, inner]]);
}

function decodeGraphEventPayload(value: unknown): GraphEventPayload {
  const m = asMap(value);
  if (m.has("EntityCreated")) {
    const e = asMap(m.get("EntityCreated"));
    return {
      kind: "EntityCreated",
      value: {
        entityId: asBytes(field(e, "entity_id")),
        entityTypeId: asNum(field(e, "entity_type_id")),
        canonicalName: asStr(field(e, "canonical_name")),
      },
    };
  }
  if (m.has("EntityUpdated")) {
    const e = asMap(m.get("EntityUpdated"));
    return {
      kind: "EntityUpdated",
      value: {
        entityId: asBytes(field(e, "entity_id")),
        entityTypeId: asNum(field(e, "entity_type_id")),
        canonicalName: asStr(field(e, "canonical_name")),
        embeddingVersionChanged: asBool(field(e, "embedding_version_changed")),
      },
    };
  }
  if (m.has("EntityRenamed")) {
    const e = asMap(m.get("EntityRenamed"));
    return {
      kind: "EntityRenamed",
      value: {
        entityId: asBytes(field(e, "entity_id")),
        oldCanonicalName: asStr(field(e, "old_canonical_name")),
        newCanonicalName: asStr(field(e, "new_canonical_name")),
        oldMovedToAlias: asBool(field(e, "old_moved_to_alias")),
      },
    };
  }
  if (m.has("EntityMerged")) {
    const e = asMap(m.get("EntityMerged"));
    return {
      kind: "EntityMerged",
      value: {
        survivor: asBytes(field(e, "survivor")),
        merged: asBytes(field(e, "merged")),
        auditId: asBytes(field(e, "audit_id")),
        confidence: asNum(field(e, "confidence")),
        statementsRerouted: asNum(field(e, "statements_rerouted")),
        relationsRerouted: asNum(field(e, "relations_rerouted")),
      },
    };
  }
  if (m.has("EntityUnmerged")) {
    const e = asMap(m.get("EntityUnmerged"));
    return {
      kind: "EntityUnmerged",
      value: {
        restoredEntityId: asBytes(field(e, "restored_entity_id")),
        fromSurvivor: asBytes(field(e, "from_survivor")),
        auditId: asBytes(field(e, "audit_id")),
      },
    };
  }
  if (m.has("EntityTombstoned")) {
    const e = asMap(m.get("EntityTombstoned"));
    return {
      kind: "EntityTombstoned",
      value: { entityId: asBytes(field(e, "entity_id")), reason: asStr(field(e, "reason")) },
    };
  }
  if (m.has("StatementCreated")) {
    const e = asMap(m.get("StatementCreated"));
    return {
      kind: "StatementCreated",
      value: {
        statementId: asBytes(field(e, "statement_id")),
        kind: asNum(field(e, "kind")),
        subject: asBytes(field(e, "subject")),
        predicate: asStr(field(e, "predicate")),
        confidence: asNum(field(e, "confidence")),
      },
    };
  }
  if (m.has("StatementSuperseded")) {
    const e = asMap(m.get("StatementSuperseded"));
    return {
      kind: "StatementSuperseded",
      value: {
        oldStatementId: asBytes(field(e, "old_statement_id")),
        newStatementId: asBytes(field(e, "new_statement_id")),
        chainRoot: asBytes(field(e, "chain_root")),
      },
    };
  }
  if (m.has("StatementTombstoned")) {
    const e = asMap(m.get("StatementTombstoned"));
    return {
      kind: "StatementTombstoned",
      value: { statementId: asBytes(field(e, "statement_id")), reason: asStr(field(e, "reason")) },
    };
  }
  if (m.has("RelationCreated")) {
    const e = asMap(m.get("RelationCreated"));
    return {
      kind: "RelationCreated",
      value: {
        relationId: asBytes(field(e, "relation_id")),
        relationType: asStr(field(e, "relation_type")),
        from: asBytes(field(e, "from")),
        to: asBytes(field(e, "to")),
      },
    };
  }
  if (m.has("RelationSuperseded")) {
    const e = asMap(m.get("RelationSuperseded"));
    return {
      kind: "RelationSuperseded",
      value: {
        oldRelationId: asBytes(field(e, "old_relation_id")),
        newRelationId: asBytes(field(e, "new_relation_id")),
      },
    };
  }
  if (m.has("RelationTombstoned")) {
    const e = asMap(m.get("RelationTombstoned"));
    return {
      kind: "RelationTombstoned",
      value: { relationId: asBytes(field(e, "relation_id")), reason: asStr(field(e, "reason")) },
    };
  }
  if (m.has("SchemaUpdated")) {
    const e = asMap(m.get("SchemaUpdated"));
    return {
      kind: "SchemaUpdated",
      value: {
        namespace: asStr(field(e, "namespace")),
        fromVersion: asNum(field(e, "from_version")),
        toVersion: asNum(field(e, "to_version")),
        backwardCompatible: asBool(field(e, "backward_compatible")),
      },
    };
  }
  throw new CborError("unknown GraphEventPayload variant");
}

export interface SubscriptionEvent {
  eventType: EventType;
  memoryId: bigint;
  contextId: bigint;
  text: string;
  kind: MemoryKindWire;
  salience: number;
  timestampUnixNanos: bigint;
  lsn: bigint;
  graphPayload: GraphEventPayload | null;
  edgePayload: EdgeEventPayload | null;
  stageKind: StageKind | null;
  stageOutcome: StageOutcome | null;
  stagePayload: StagePayload | null;
}

export function encodeSubscriptionEvent(p: SubscriptionEvent): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["event_type", p.eventType as number],
      ["memory_id", p.memoryId],
      ["context_id", p.contextId],
      ["text", p.text],
      ["kind", p.kind as number],
      ["salience", f32(p.salience)],
      ["timestamp_unix_nanos", p.timestampUnixNanos],
      ["lsn", p.lsn],
      ["graph_payload", p.graphPayload === null ? null : encodeGraphEventPayload(p.graphPayload)],
      ["edge_payload", p.edgePayload === null ? null : encodeEdgeEventPayload(p.edgePayload)],
      ["stage_kind", p.stageKind === null ? null : (p.stageKind as number)],
      ["stage_outcome", p.stageOutcome === null ? null : (p.stageOutcome as number)],
      ["stage_payload", p.stagePayload === null ? null : encodeStagePayload(p.stagePayload)],
    ]),
  );
}

export function decodeSubscriptionEvent(bytes: Uint8Array): SubscriptionEvent {
  const m = asMap(fromCbor(bytes));
  return {
    eventType: asNum(field(m, "event_type")) as EventType,
    memoryId: asBig(field(m, "memory_id")),
    contextId: asBig(field(m, "context_id")),
    text: asStr(field(m, "text")),
    kind: asNum(field(m, "kind")) as MemoryKindWire,
    salience: asNum(field(m, "salience")),
    timestampUnixNanos: asBig(field(m, "timestamp_unix_nanos")),
    lsn: asBig(field(m, "lsn")),
    graphPayload: asOpt(field(m, "graph_payload"), decodeGraphEventPayload),
    edgePayload: asOpt(field(m, "edge_payload"), decodeEdgeEventPayload),
    stageKind: asOpt(field(m, "stage_kind"), (v) => asNum(v) as StageKind),
    stageOutcome: asOpt(field(m, "stage_outcome"), (v) => asNum(v) as StageOutcome),
    stagePayload: asOpt(field(m, "stage_payload"), decodeStagePayload),
  };
}

export interface UnsubscribeRequest {
  targetStreamId: number;
}

export function encodeUnsubscribe(p: UnsubscribeRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["target_stream_id", p.targetStreamId]]));
}

export function decodeUnsubscribe(bytes: Uint8Array): UnsubscribeRequest {
  const m = asMap(fromCbor(bytes));
  return { targetStreamId: asNum(field(m, "target_stream_id")) };
}

export interface UnsubscribeResponse {
  targetStreamId: number;
  finalLsn: bigint;
}

export function encodeUnsubscribeResponse(p: UnsubscribeResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["target_stream_id", p.targetStreamId],
      ["final_lsn", p.finalLsn],
    ]),
  );
}

export function decodeUnsubscribeResponse(bytes: Uint8Array): UnsubscribeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    targetStreamId: asNum(field(m, "target_stream_id")),
    finalLsn: asBig(field(m, "final_lsn")),
  };
}
