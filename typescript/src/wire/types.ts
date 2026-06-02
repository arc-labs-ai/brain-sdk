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
