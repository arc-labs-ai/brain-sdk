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

/** How a stored memory was formed: an episodic event, a semantic fact, or a consolidated summary. Integer discriminant on the wire. */
export enum MemoryKindWire {
  Episodic = 0,
  Semantic = 1,
  Consolidated = 2,
}

/** The typed relationship an edge asserts between two memories (causal, temporal, similarity, support, ...). Integer discriminant on the wire. */
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

/** FORGET disposition: a recoverable soft tombstone or an immediate hard zeroing of the slot. */
export enum ForgetMode {
  Soft = 0,
  Hard = 1,
}

/** A background write-pipeline stage a freshly-encoded memory is still pending (auto-edge, temporal-edge, extractor, or HyPE). */
export enum StageKind {
  AutoEdge = 0,
  TemporalEdge = 1,
  Extractor = 2,
  Hype = 3,
}

/** Authentication method offered in WELCOME and selected in AUTH: a bearer token or an mTLS subject claim. */
export enum AuthMethod {
  Token = 0,
  Mtls = 1,
}

/** Which of the three always-wired retrievers contributed a hit (semantic, lexical, or graph). */
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

/** Retriever identity tag carried on a QUERY per-retriever contribution or outcome (semantic, lexical, graph). */
export enum RetrieverWire {
  Semantic = 0,
  Lexical = 1,
  Graph = 2,
}

/** Coarse class of a server ERROR frame; drives whether the client may retry. */
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

/**
 * Named wire error codes (the numeric `code` on an ERROR frame) the client
 * branches on. The Authorization family (`0x0030`–`0x0033`); notably
 * `ActAsDenied` (`0x0033`), returned when a connection principal without the
 * `canActAs` grant — or one targeting a namespace outside its allowlist —
 * sends a request carrying an `act_as` selector.
 */
export enum WireErrorCode {
  PermissionDenied = 0x0030,
  AdminPermissionRequired = 0x0031,
  WrongShard = 0x0032,
  ActAsDenied = 0x0033,
}

// ---------------------------------------------------------------------------
// Handshake.
// ---------------------------------------------------------------------------

/** Optional transport features the client advertises in HELLO (streaming, zstd compression, server push). */
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

/** HELLO (`0x0001`): the client's opening frame — id, supported wire versions, capabilities, and an optional resume token. */
export interface HelloPayload {
  clientId: string;
  supportedVersions: number[];
  capabilities: HelloCapabilities;
  /** Reserved for session resumption; null encodes as CBOR null. */
  clientSessionToken: Uint8Array | null;
}

/** Encode a HELLO (`0x0001`) handshake request. */
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

/** Decode a HELLO (`0x0001`) handshake request payload. */
export function decodeHello(bytes: Uint8Array): HelloPayload {
  const m = asMap(fromCbor(bytes));
  return {
    clientId: asStr(field(m, "client_id")),
    supportedVersions: asArray(field(m, "supported_versions")).map(asNum),
    capabilities: decodeCapabilities(field(m, "capabilities")),
    clientSessionToken: asOptBytes(field(m, "client_session_token")),
  };
}

/** Hard limits and timeouts the server declares in WELCOME (max payload, max concurrent streams, idle timeout, offered auth methods). */
export interface ServerFeatures {
  maxPayloadSize: number;
  maxConcurrentStreams: number;
  idleTimeoutSeconds: number;
  authMethods: AuthMethod[];
}

/** WELCOME (`0x0081`): the server's handshake reply — chosen version, session id, echoed capabilities, and server features. */
export interface WelcomePayload {
  serverId: string;
  chosenVersion: number;
  sessionId: Uint8Array;
  capabilities: HelloCapabilities;
  serverFeatures: ServerFeatures;
}

/** Encode a WELCOME (`0x0081`) handshake response. */
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

/** Decode a WELCOME (`0x0081`) handshake response payload. */
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
  | { kind: "Mtls"; certFingerprint: Uint8Array; assertedSubject: string };

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
  }
}

function decodeCredentials(value: unknown): AuthCredentials {
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

/**
 * An AUTH frame. The credential is the connection's whole identity — the
 * server resolves `(namespace, agent, permissions)` from it and assigns the
 * agent id. The client never sends an agent id.
 */
export interface AuthPayload {
  method: AuthMethod;
  credentials: AuthCredentials;
}

/** Encode an AUTH (`0x0002`) request carrying the connection's credential. */
export function encodeAuth(p: AuthPayload): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["method", p.method as number],
      ["credentials", encodeCredentials(p.credentials)],
    ]),
  );
}

/** Decode an AUTH (`0x0002`) request payload. */
export function decodeAuth(bytes: Uint8Array): AuthPayload {
  const m = asMap(fromCbor(bytes));
  return {
    method: asNum(field(m, "method")) as AuthMethod,
    credentials: decodeCredentials(field(m, "credentials")),
  };
}

/** The capability grants the server resolved from the credential (encode/recall/plan/reason/forget/admin/act-as). */
export interface AgentPermissions {
  canEncode: boolean;
  canRecall: boolean;
  canPlan: boolean;
  canReason: boolean;
  canForget: boolean;
  canAdmin: boolean;
  /** Authorizes running an op on behalf of another identity via the
   * per-request `act_as` field. Held only by a trusted service principal
   * (an edge/gateway); a normal agent's key never carries it. */
  canActAs: boolean;
}

/** AUTH_OK (`0x0082`): the server's post-auth grant — assigned agent id, bound shard, permissions, resolved namespace, and server clock. */
export interface AuthOkPayload {
  agentId: WireUuid;
  boundShardId: number;
  permissions: AgentPermissions;
  /** Owning tenant the connection resolved to (server-derived from auth).
   * Empty when the connection resolves to the reserved `brain` system
   * namespace. Read-only — the client never sends a namespace. */
  namespace: string;
  serverTimeUnixNanos: bigint;
}

/** Encode an AUTH_OK (`0x0082`) response. */
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
          ["can_act_as", perm.canActAs],
        ]),
      ],
      ["namespace", p.namespace],
      ["server_time_unix_nanos", p.serverTimeUnixNanos],
    ]),
  );
}

/** Decode an AUTH_OK (`0x0082`) response payload. */
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
      // Tolerate older servers that predate the act-as grant bit.
      canActAs: perm.has("can_act_as") ? asBool(field(perm, "can_act_as")) : false,
    },
    // Tolerate older servers that don't emit the field yet.
    namespace: m.has("namespace") ? asStr(field(m, "namespace")) : "",
    serverTimeUnixNanos: asBig(field(m, "server_time_unix_nanos")),
  };
}

// ===========================================================================
// Keepalive (PING / PONG / SERVER_PING / CLIENT_PONG).
//
// Map keys are the CBOR field names on the wire and must match the server's
// brain-protocol definitions byte-for-byte. Timestamps are u64 → bigint.
// ===========================================================================

/** PING (`0x0010`): a client liveness probe the server answers with PONG. */
export interface PingRequest {
  clientTimestampUnixNanos: bigint;
}

/** Encode a PING (`0x0010`) request. */
export function encodePing(p: PingRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([["client_timestamp_unix_nanos", p.clientTimestampUnixNanos]]),
  );
}

/** PONG (`0x0090`): the server's reply to a client PING, echoing the nonce. */
export interface PongResponse {
  clientTimestampUnixNanos: bigint;
  serverTimestampUnixNanos: bigint;
}

/** Encode a PONG (`0x0090`) response. */
export function encodePong(p: PongResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["client_timestamp_unix_nanos", p.clientTimestampUnixNanos],
      ["server_timestamp_unix_nanos", p.serverTimestampUnixNanos],
    ]),
  );
}

/** Decode a PONG (`0x0090`) response payload. */
export function decodePong(bytes: Uint8Array): PongResponse {
  const m = asMap(fromCbor(bytes));
  return {
    clientTimestampUnixNanos: asBig(field(m, "client_timestamp_unix_nanos")),
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
  };
}

/** SERVER_PING (`0x0091`): the server's idle-timer heartbeat the client must answer with CLIENT_PONG. */
export interface ServerPingResponse {
  serverTimestampUnixNanos: bigint;
}

/** Encode a SERVER_PING (`0x0091`) heartbeat frame. */
export function encodeServerPing(p: ServerPingResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([["server_timestamp_unix_nanos", p.serverTimestampUnixNanos]]),
  );
}

/** Decode a SERVER_PING (`0x0091`) heartbeat payload. */
export function decodeServerPing(bytes: Uint8Array): ServerPingResponse {
  const m = asMap(fromCbor(bytes));
  return {
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
  };
}

/** CLIENT_PONG (`0x0011`): the client's reply to SERVER_PING that keeps the connection alive. */
export interface ClientPongRequest {
  serverTimestampUnixNanos: bigint;
  clientTimestampUnixNanos: bigint;
}

/** Encode a CLIENT_PONG (`0x0011`) frame. */
export function encodeClientPong(p: ClientPongRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["server_timestamp_unix_nanos", p.serverTimestampUnixNanos],
      ["client_timestamp_unix_nanos", p.clientTimestampUnixNanos],
    ]),
  );
}

/** Decode a CLIENT_PONG (`0x0011`) payload. */
export function decodeClientPong(bytes: Uint8Array): ClientPongRequest {
  const m = asMap(fromCbor(bytes));
  return {
    serverTimestampUnixNanos: asBig(field(m, "server_timestamp_unix_nanos")),
    clientTimestampUnixNanos: asBig(field(m, "client_timestamp_unix_nanos")),
  };
}

// ---------------------------------------------------------------------------
// Per-request effective identity (`act_as`).
// ---------------------------------------------------------------------------

/**
 * Per-request effective-identity selector carried on data-plane op requests.
 * When present, the op runs as this `(namespace, agentId)` on behalf of the
 * authenticated connection principal; when absent the op runs as the
 * connection's own key-bound identity.
 *
 * Honored server-side only when the connection principal holds `canActAs` and
 * `namespace` lies within its granted allowlist — otherwise the op is rejected
 * with `ActAsDenied`. This is the wire form only; the trust model is enforced
 * by the server, not by this codec. On the wire the map is
 * `{ namespace: <text>, agent_id: <16-byte string> }`, and the whole field is
 * CBOR-omitted when absent so requests without an effective identity stay
 * byte-identical to the pre-`act_as` goldens.
 */
export interface ActAs {
  namespace: string;
  /** 16-byte effective agent id (CBOR byte string, key `agent_id`). */
  agentId: WireUuid;
}

function encodeActAs(a: ActAs): Map<string, unknown> {
  return new Map<string, unknown>([
    ["namespace", a.namespace],
    ["agent_id", a.agentId],
  ]);
}

function decodeActAs(value: unknown): ActAs {
  const m = asMap(value);
  return {
    namespace: asStr(field(m, "namespace")),
    agentId: asBytes(field(m, "agent_id")),
  };
}

/**
 * Build a request CBOR map from its ordered field entries, appending the
 * optional `act_as` selector last (matching the server's field order). When
 * `actAs` is null the key is omitted entirely, so the encoded bytes match the
 * pre-`act_as` goldens exactly.
 */
function requestMapWithActAs(
  entries: [string, unknown][],
  actAs: ActAs | null,
): Map<string, unknown> {
  const map = new Map<string, unknown>(entries);
  if (actAs !== null) map.set("act_as", encodeActAs(actAs));
  return map;
}

/** Read the optional `act_as` selector from a decoded request map. */
function decodeOptActAs(m: Map<string, unknown>): ActAs | null {
  return m.has("act_as") ? decodeActAs(m.get("act_as")) : null;
}

// ---------------------------------------------------------------------------
// ENCODE / ENCODE_VECTOR_DIRECT.
// ---------------------------------------------------------------------------

/** One outgoing edge a write asks the server to create from the new memory to an existing one. */
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

/**
 * Write-completion mode — how long a write op blocks before it returns.
 * `Ack` returns after the durable sync ack (the fast default); `Derived`
 * blocks until async derivation completes and the ENCODE response carries a
 * populated `trace: EncodeTrace`. Integer discriminant on the wire, OMITTED
 * from the CBOR map when `Ack` (the server defaults to `Ack`). Writes use
 * `wait`; reads keep `trace`.
 */
export enum WaitMode {
  Ack = 0,
  Derived = 1,
}

/** ENCODE (`0x0020`): store a memory from text, with context, edges, and an optional occurred-at stamp. */
export interface EncodeRequest {
  text: string;
  contextId: bigint;
  requestId: WireUuid;
  txnId: WireUuid | null;
  occurredAtUnixNanos: bigint | null;
  /** Effective identity this encode runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
  /** Write-completion mode (default {@link WaitMode.Ack}). `Derived` blocks
   * until async derivation completes and the ENCODE response carries a
   * populated `trace: EncodeTrace`. Omitted from the CBOR map when `Ack` /
   * undefined (the server defaults to `Ack`). */
  wait?: WaitMode;
  /** Opt out of content dedup and force a distinct memory. Default `false`:
   * Brain dedupes byte-identical text on `(agentId, contextId, BLAKE3(text))`
   * and returns the existing memory (`wasDeduplicated = true`) without writing.
   * Set `true` when the same text is a genuinely distinct observation that must
   * coexist (e.g. the same fact re-stated at a different `occurredAt`). Omitted
   * from the CBOR map when `false` / undefined so the default path stays
   * byte-identical. */
  allowDuplicates?: boolean;
}

/** Encode an ENCODE (`0x0020`) request. `wait` follows `act_as`, and is
 * omitted from the map when `Ack` / undefined. */
export function encodeEncode(p: EncodeRequest): Uint8Array {
  const map = requestMapWithActAs(
    [
      ["text", p.text],
      ["context_id", p.contextId],
      ["request_id", p.requestId],
      ["txn_id", p.txnId],
      ["occurred_at_unix_nanos", p.occurredAtUnixNanos],
    ],
    p.actAs,
  );
  if (p.wait != null && p.wait !== WaitMode.Ack) map.set("wait", p.wait as number);
  if (p.allowDuplicates) map.set("allow_duplicates", true);
  return toCbor(map);
}

/** Decode an ENCODE (`0x0020`) request payload. */
export function decodeEncode(bytes: Uint8Array): EncodeRequest {
  const m = asMap(fromCbor(bytes));
  return {
    text: asStr(field(m, "text")),
    contextId: asBig(field(m, "context_id")),
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    occurredAtUnixNanos: asOpt(field(m, "occurred_at_unix_nanos"), asBig),
    actAs: decodeOptActAs(m),
    wait: m.has("wait") ? (asNum(field(m, "wait")) as WaitMode) : WaitMode.Ack,
    allowDuplicates: m.has("allow_duplicates") ? asBool(field(m, "allow_duplicates")) : false,
  };
}

/** ENCODE_VECTOR_DIRECT (`0x002A`): store a pre-computed embedding; the vector rides the trailing raw f32 section, not the CBOR map. */
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

/** Encode an ENCODE_VECTOR_DIRECT (`0x002A`) request, appending the raw f32 vector after the CBOR map. */
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

/** Decode an ENCODE_VECTOR_DIRECT (`0x002A`) request, splitting the CBOR map from the trailing raw f32 vector. */
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

/** ENCODE_RESP (`0x00A0`): the assigned memory id plus write outcome — salience, dedup verdict, auto-edges, LSN, and pending stages. */
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
  /** Full synchronous write-analysis trace, present only when the request set
   * `trace = true`; absent (CBOR-omitted) otherwise. */
  trace?: EncodeTrace;
}

/** Encode an ENCODE_RESP (`0x00A0`) payload (also the ENCODE_VECTOR_DIRECT reply). */
export function encodeEncodeResponse(p: EncodeResponse): Uint8Array {
  const map = new Map<string, unknown>([
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
  ]);
  if (p.trace != null) map.set("trace", encodeEncodeTrace(p.trace));
  return toCbor(map);
}

/** Decode an ENCODE_RESP (`0x00A0`) payload. */
export function decodeEncodeResponse(bytes: Uint8Array): EncodeResponse {
  const m = asMap(fromCbor(bytes));
  const out: EncodeResponse = {
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
  if (m.has("trace")) out.trace = decodeEncodeTrace(field(m, "trace"));
  return out;
}

// ---------------------------------------------------------------------------
// ENCODE trace.
// ---------------------------------------------------------------------------

/** Terminal status of an `EncodeTrace` phase or index. Integer discriminant. */
export enum EncodeTraceStageStatus {
  Ok = 0,
  Skipped = 1,
  Failed = 2,
  Timeout = 3,
}

/** One phase in an `EncodeTrace` timeline. */
export interface EncodeTraceStage {
  name: string;
  status: EncodeTraceStageStatus;
  latencyUs: bigint;
  detail: string;
  /** The concrete data this stage produced (embedding vector, redb record,
   * HyPE questions, analyzed keyword terms, or the extracted graph). Present
   * only when the caller set `trace = true` and the stage produced inspectable
   * output; absent (CBOR-omitted) otherwise. */
  artifact?: EncodeStageArtifact;
}

/** One entity artifact produced by a traced ENCODE. */
export interface EncodeTraceEntity {
  id: Uint8Array;
  name: string;
  typeQname: string;
}

/** One statement artifact produced by a traced ENCODE. */
export interface EncodeTraceStatement {
  id: Uint8Array;
  subjectName: string;
  predicate: string;
  objectName: string;
  confidence: number;
  /** When the statement's EVENT happened, in unix nanos — the reified Time
   * slot of an Event-kind statement. `null` when the statement has no event
   * time (and then absent from the wire map). */
  eventAtUnixNanos: bigint | null;
}

/** One relation artifact produced by a traced ENCODE. */
export interface EncodeTraceRelation {
  sourceName: string;
  predicate: string;
  targetName: string;
}

/** One index the write landed in, plus its status. */
export interface EncodeTraceIndex {
  name: string;
  status: EncodeTraceStageStatus;
}

/** The dedup verdict carried on an `EncodeTrace`. */
export interface EncodeTraceDedup {
  wasDeduplicated: boolean;
  /** The memory a dedup collapsed into, or `null` when the write was new. */
  matchedMemoryId: Uint8Array | null;
}

/** What a traced ENCODE produced, resolved after the async stages drained. */
export interface EncodeTraceArtifacts {
  entities: EncodeTraceEntity[];
  statements: EncodeTraceStatement[];
  relations: EncodeTraceRelation[];
  indexes: EncodeTraceIndex[];
  dedup: EncodeTraceDedup;
}

/** Full synchronous write-analysis trace for one ENCODE. */
export interface EncodeTrace {
  stages: EncodeTraceStage[];
  artifacts: EncodeTraceArtifacts;
  totalLatencyUs: bigint;
}

function encodeEncodeTrace(t: EncodeTrace): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "stages",
      t.stages.map((s) => {
        const stage = new Map<string, unknown>([
          ["name", s.name],
          ["status", s.status as number],
          ["latency_us", s.latencyUs],
          ["detail", s.detail],
        ]);
        if (s.artifact != null) stage.set("artifact", encodeStageArtifact(s.artifact));
        return stage;
      }),
    ],
    ["artifacts", encodeEncodeTraceArtifacts(t.artifacts)],
    ["total_latency_us", t.totalLatencyUs],
  ]);
}

function encodeEncodeTraceArtifacts(a: EncodeTraceArtifacts): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "entities",
      a.entities.map(
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
      a.statements.map((s) => {
        const sm = new Map<string, unknown>([
          ["id", s.id],
          ["subject_name", s.subjectName],
          ["predicate", s.predicate],
          ["object_name", s.objectName],
          ["confidence", f32(s.confidence)],
        ]);
        if (s.eventAtUnixNanos != null)
          sm.set("event_at_unix_nanos", s.eventAtUnixNanos);
        return sm;
      }),
    ],
    [
      "relations",
      a.relations.map(
        (r) =>
          new Map<string, unknown>([
            ["source_name", r.sourceName],
            ["predicate", r.predicate],
            ["target_name", r.targetName],
          ]),
      ),
    ],
    [
      "indexes",
      a.indexes.map(
        (i) =>
          new Map<string, unknown>([
            ["name", i.name],
            ["status", i.status as number],
          ]),
      ),
    ],
    [
      "dedup",
      new Map<string, unknown>([
        ["was_deduplicated", a.dedup.wasDeduplicated],
        ["matched_memory_id", a.dedup.matchedMemoryId],
      ]),
    ],
  ]);
}

function decodeEncodeTrace(value: unknown): EncodeTrace {
  const m = asMap(value);
  return {
    stages: asArray(field(m, "stages")).map((v) => {
      const s = asMap(v);
      const stage: EncodeTraceStage = {
        name: asStr(field(s, "name")),
        status: asNum(field(s, "status")) as EncodeTraceStageStatus,
        latencyUs: asBig(field(s, "latency_us")),
        detail: asStr(field(s, "detail")),
      };
      if (s.has("artifact")) stage.artifact = decodeStageArtifact(field(s, "artifact"));
      return stage;
    }),
    artifacts: decodeEncodeTraceArtifacts(field(m, "artifacts")),
    totalLatencyUs: asBig(field(m, "total_latency_us")),
  };
}

function decodeEncodeTraceArtifacts(value: unknown): EncodeTraceArtifacts {
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
        objectName: asStr(field(s, "object_name")),
        confidence: asNum(field(s, "confidence")),
        eventAtUnixNanos: s.has("event_at_unix_nanos")
          ? asBig(field(s, "event_at_unix_nanos"))
          : null,
      };
    }),
    relations: asArray(field(m, "relations")).map((v) => {
      const r = asMap(v);
      return {
        sourceName: asStr(field(r, "source_name")),
        predicate: asStr(field(r, "predicate")),
        targetName: asStr(field(r, "target_name")),
      };
    }),
    indexes: asArray(field(m, "indexes")).map((v) => {
      const i = asMap(v);
      return {
        name: asStr(field(i, "name")),
        status: asNum(field(i, "status")) as EncodeTraceStageStatus,
      };
    }),
    dedup: (() => {
      const d = asMap(field(m, "dedup"));
      return {
        wasDeduplicated: asBool(field(d, "was_deduplicated")),
        matchedMemoryId: asOptBytes(field(d, "matched_memory_id")),
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// ENCODE stage artifacts (shared: live ENCODE trace + stored MEMORY_INSPECT).
//
// Every field of `EncodeStageArtifact` is optional and OMITTED from the CBOR
// map when empty/absent — mirroring the server's `skip_serializing_if`. Field
// order is fixed: vector, record, hype_questions, keyword_fields, graph.
// ---------------------------------------------------------------------------

/** The redb metadata row a `persist` stage committed — the durable record fields. */
export interface EncodeStageRecord {
  memoryId: Uint8Array;
  /** Memory-kind discriminant (as stored). */
  kind: number;
  /** Salience the write assigned. */
  salience: number;
  createdAtUnixNanos: bigint;
  /** Event time when the caller supplied `occurred_at`; `0` otherwise. */
  occurredAtUnixNanos: bigint;
  /** Stored embedding dimension. */
  vectorDim: number;
  /** Byte length of the stored memory text. */
  textLen: number;
  /** WAL log-sequence number the write landed at. */
  lsn: bigint;
}

function encodeStageRecord(r: EncodeStageRecord): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", r.memoryId],
    ["kind", r.kind],
    ["salience", f32(r.salience)],
    ["created_at_unix_nanos", r.createdAtUnixNanos],
    ["occurred_at_unix_nanos", r.occurredAtUnixNanos],
    ["vector_dim", r.vectorDim],
    ["text_len", r.textLen],
    ["lsn", r.lsn],
  ]);
}

function decodeStageRecord(value: unknown): EncodeStageRecord {
  const m = asMap(value);
  return {
    memoryId: asBytes(field(m, "memory_id")),
    kind: asNum(field(m, "kind")),
    salience: asNum(field(m, "salience")),
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    occurredAtUnixNanos: asBig(field(m, "occurred_at_unix_nanos")),
    vectorDim: asNum(field(m, "vector_dim")),
    textLen: asNum(field(m, "text_len")),
    lsn: asBig(field(m, "lsn")),
  };
}

/** One text-index field and the analyzed terms the write produced for it. */
export interface EncodeStageKeywordField {
  /** Index field name — e.g. `memory_text`, `statement_text`. */
  field: string;
  /** The analyzed tokens (post-tokenizer) the field will match on. */
  terms: string[];
}

function encodeStageKeywordField(k: EncodeStageKeywordField): Map<string, unknown> {
  return new Map<string, unknown>([
    ["field", k.field],
    ["terms", k.terms],
  ]);
}

function decodeStageKeywordField(value: unknown): EncodeStageKeywordField {
  const m = asMap(value);
  return {
    field: asStr(field(m, "field")),
    terms: asArray(field(m, "terms")).map(asStr),
  };
}

/** A node in the knowledge graph an ENCODE produced — an entity, the memory
 * itself, or a literal object value. */
export interface EncodeGraphNode {
  /** Stable node id: entity id, memory id, or a synthetic literal-value id. */
  id: Uint8Array;
  /** Display name / value. */
  name: string;
  /** `"entity"`, `"memory"`, or `"literal"`. */
  kind: string;
  /** For entity nodes, the `"namespace:typename"` (empty otherwise). */
  typeQname: string;
}

function encodeStageGraphNode(n: EncodeGraphNode): Map<string, unknown> {
  return new Map<string, unknown>([
    ["id", n.id],
    ["name", n.name],
    ["kind", n.kind],
    ["type_qname", n.typeQname],
  ]);
}

function decodeStageGraphNode(value: unknown): EncodeGraphNode {
  const m = asMap(value);
  return {
    id: asBytes(field(m, "id")),
    name: asStr(field(m, "name")),
    kind: asStr(field(m, "kind")),
    typeQname: asStr(field(m, "type_qname")),
  };
}

/** A directed edge in the knowledge graph an ENCODE produced. */
export interface EncodeGraphEdge {
  /** Source node id (subject). */
  source: Uint8Array;
  /** Target node id (object / relation target). */
  target: Uint8Array;
  /** Predicate qname. */
  predicate: string;
  /** `"statement"` or `"relation"`. */
  kind: string;
  /** Extraction confidence, when applicable. */
  confidence: number;
  /** When the EVENT this edge records happened, in unix nanos, denormalised
   * from the backing statement. `null` for an undated statement and for
   * every non-statement edge kind (and then absent from the wire map). */
  eventAtUnixNanos: bigint | null;
}

function encodeStageGraphEdge(e: EncodeGraphEdge): Map<string, unknown> {
  const m = new Map<string, unknown>([
    ["source", e.source],
    ["target", e.target],
    ["predicate", e.predicate],
    ["kind", e.kind],
    ["confidence", f32(e.confidence)],
  ]);
  if (e.eventAtUnixNanos != null)
    m.set("event_at_unix_nanos", e.eventAtUnixNanos);
  return m;
}

function decodeStageGraphEdge(value: unknown): EncodeGraphEdge {
  const m = asMap(value);
  return {
    source: asBytes(field(m, "source")),
    target: asBytes(field(m, "target")),
    predicate: asStr(field(m, "predicate")),
    kind: asStr(field(m, "kind")),
    confidence: asNum(field(m, "confidence")),
    eventAtUnixNanos: m.has("event_at_unix_nanos")
      ? asBig(field(m, "event_at_unix_nanos"))
      : null,
  };
}

/** The knowledge graph an ENCODE produced — nodes and the directed edges
 * (statements, relations) between them. */
export interface EncodeStageGraph {
  nodes: EncodeGraphNode[];
  edges: EncodeGraphEdge[];
}

function encodeStageGraph(g: EncodeStageGraph): Map<string, unknown> {
  return new Map<string, unknown>([
    ["nodes", g.nodes.map(encodeStageGraphNode)],
    ["edges", g.edges.map(encodeStageGraphEdge)],
  ]);
}

function decodeStageGraph(value: unknown): EncodeStageGraph {
  const m = asMap(value);
  return {
    nodes: asArray(field(m, "nodes")).map(decodeStageGraphNode),
    edges: asArray(field(m, "edges")).map(decodeStageGraphEdge),
  };
}

/**
 * The concrete output one ENCODE stage produced behind the scenes. A per-stage
 * output bag: every field is optional and each stage populates only the subset
 * it generated (`embed` → `vector`, `persist` → `record`, HyPE →
 * `hypeQuestions`, a text-index stage → `keywordFields`, the extractor →
 * `graph`). Empty/absent fields are omitted from the wire map. Reused as the
 * MEMORY_INSPECT bundle shape so the live trace and the stored view are one type.
 */
export interface EncodeStageArtifact {
  /** The embedding vector the `embed` stage produced (full width). Rides the
   * CBOR map as a shortest-float array; empty when the stage produced none. */
  vector: number[];
  /** The metadata row the `persist` stage committed to redb; `null` when absent. */
  record: EncodeStageRecord | null;
  /** Hypothetical questions the write-time HyPE step generated. */
  hypeQuestions: string[];
  /** The analyzed keyword terms a text-index stage derived, per index field. */
  keywordFields: EncodeStageKeywordField[];
  /** The knowledge-graph fragment this stage produced; `null` when absent. */
  graph: EncodeStageGraph | null;
}

function encodeStageArtifact(a: EncodeStageArtifact): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (a.vector.length > 0) map.set("vector", a.vector.map(f32));
  if (a.record !== null) map.set("record", encodeStageRecord(a.record));
  if (a.hypeQuestions.length > 0) map.set("hype_questions", a.hypeQuestions);
  if (a.keywordFields.length > 0) {
    map.set("keyword_fields", a.keywordFields.map(encodeStageKeywordField));
  }
  if (a.graph !== null) map.set("graph", encodeStageGraph(a.graph));
  return map;
}

function decodeStageArtifact(value: unknown): EncodeStageArtifact {
  const m = asMap(value);
  return {
    vector: m.has("vector") ? asArray(field(m, "vector")).map(asNum) : [],
    record: m.has("record") ? decodeStageRecord(field(m, "record")) : null,
    hypeQuestions: m.has("hype_questions")
      ? asArray(field(m, "hype_questions")).map(asStr)
      : [],
    keywordFields: m.has("keyword_fields")
      ? asArray(field(m, "keyword_fields")).map(decodeStageKeywordField)
      : [],
    graph: m.has("graph") ? decodeStageGraph(field(m, "graph")) : null,
  };
}

// ---------------------------------------------------------------------------
// MEMORY_INSPECT.
// ---------------------------------------------------------------------------

/** MEMORY_INSPECT (`0x0028`): fetch the durable write-artifact bundle for one
 * memory. Single-shot — the reply carries the whole bundle. */
export interface MemoryInspectRequest {
  memoryId: Uint8Array;
  /** Effective identity this read runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a MEMORY_INSPECT (`0x0028`) request. `act_as` trails when present. */
export function encodeMemoryInspect(p: MemoryInspectRequest): Uint8Array {
  return toCbor(requestMapWithActAs([["memory_id", p.memoryId]], p.actAs));
}

/** Decode a MEMORY_INSPECT (`0x0028`) request payload. */
export function decodeMemoryInspect(bytes: Uint8Array): MemoryInspectRequest {
  const m = asMap(fromCbor(bytes));
  return {
    memoryId: asBytes(field(m, "memory_id")),
    actAs: decodeOptActAs(m),
  };
}

/** MEMORY_INSPECT_RESP (`0x00A8`): the durable per-memory artifact bundle —
 * what each write stage produced (embedding vector, redb record, keyword terms,
 * HyPE questions, extracted graph) plus the memory text. `found = false` (with
 * an empty `artifact`) when no memory / no bundle exists for the id. */
export interface MemoryInspectResponse {
  found: boolean;
  memoryId: Uint8Array;
  text: string;
  artifact: EncodeStageArtifact;
}

/** Encode a MEMORY_INSPECT_RESP (`0x00A8`) payload. */
export function encodeMemoryInspectResponse(p: MemoryInspectResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["found", p.found],
      ["memory_id", p.memoryId],
      ["text", p.text],
      ["artifact", encodeStageArtifact(p.artifact)],
    ]),
  );
}

/** Decode a MEMORY_INSPECT_RESP (`0x00A8`) payload. */
export function decodeMemoryInspectResponse(bytes: Uint8Array): MemoryInspectResponse {
  const m = asMap(fromCbor(bytes));
  return {
    found: asBool(field(m, "found")),
    memoryId: asBytes(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    artifact: decodeStageArtifact(field(m, "artifact")),
  };
}

// ---------------------------------------------------------------------------
// RECALL.
// ---------------------------------------------------------------------------

/**
 * What kind of answer RECALL produced. On the wire this is the variant-name
 * text string. `None` is the "don't know" outcome; `Single` resolves to one
 * memory; `Many` carries several ranked memories.
 */
export type AnswerKind = "Single" | "Many" | "None";

/** RECALL (`0x0021`): retrieve memories by cue, with subject, filters (kind/context/confidence/salience/time), and graph/text toggles. */
export interface RecallRequest {
  cueText: string;
  subjectName: string;
  maxResults: number;
  confidenceThreshold: number;
  contextFilter: bigint[] | null;
  ageBoundUnixNanos: bigint | null;
  asOfRecordTimeUnixNanos: bigint | null;
  kindFilter: MemoryKindWire[] | null;
  salienceFloor: number;
  includeEdges: boolean;
  includeGraph: boolean;
  includeText: boolean;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
  /** Opt-in per-stage read-pipeline trace. When `true`, the final RECALL_RESP
   * frame carries a populated `trace: RecallTrace`; when `false` (the default)
   * the response field is absent and the read pays nothing. Always present on
   * the wire (the server tolerates its absence, defaulting to `false`). */
  trace: boolean;
  /** Effective identity this recall runs as. `null` (CBOR-omitted) runs as
   * the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a RECALL (`0x0021`) request. `trace` precedes `act_as`. */
export function encodeRecall(p: RecallRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["cue_text", p.cueText],
        ["subject_name", p.subjectName],
        ["max_results", p.maxResults],
        ["confidence_threshold", f32(p.confidenceThreshold)],
        ["context_filter", p.contextFilter === null ? null : p.contextFilter],
        ["age_bound_unix_nanos", p.ageBoundUnixNanos],
        ["as_of_record_time_unix_nanos", p.asOfRecordTimeUnixNanos],
        ["kind_filter", p.kindFilter === null ? null : p.kindFilter.map((k) => k as number)],
        ["salience_floor", f32(p.salienceFloor)],
        ["include_edges", p.includeEdges],
        ["include_graph", p.includeGraph],
        ["include_text", p.includeText],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
        ["trace", p.trace],
      ],
      p.actAs,
    ),
  );
}

/** Decode a RECALL (`0x0021`) request payload. */
export function decodeRecall(bytes: Uint8Array): RecallRequest {
  const m = asMap(fromCbor(bytes));
  return {
    cueText: asStr(field(m, "cue_text")),
    subjectName: asStr(field(m, "subject_name")),
    maxResults: asNum(field(m, "max_results")),
    confidenceThreshold: asNum(field(m, "confidence_threshold")),
    contextFilter: asOpt(field(m, "context_filter"), (v) => asArray(v).map(asBig)),
    ageBoundUnixNanos: asOpt(field(m, "age_bound_unix_nanos"), asBig),
    asOfRecordTimeUnixNanos: asOpt(field(m, "as_of_record_time_unix_nanos"), asBig),
    kindFilter: asOpt(field(m, "kind_filter"), (v) =>
      asArray(v).map((k) => asNum(k) as MemoryKindWire),
    ),
    salienceFloor: asNum(field(m, "salience_floor")),
    includeEdges: asBool(field(m, "include_edges")),
    includeGraph: asBool(field(m, "include_graph")),
    includeText: asBool(field(m, "include_text")),
    requestId: asOptBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    trace: m.has("trace") ? asBool(field(m, "trace")) : false,
    actAs: decodeOptActAs(m),
  };
}

/** A memory's outgoing edge as returned in a recall hit: target, kind, and weight. */
export interface EdgeView {
  target: bigint;
  kind: EdgeKindWire;
  weight: number;
}

/** A graph-enrichment entity node attached to a recall hit: id, display name, and type qname. */
export interface EnrichedEntity {
  id: Uint8Array;
  name: string;
  typeQname: string;
}

/** A graph-enrichment statement attached to a recall hit: subject/predicate/object labels and confidence. */
export interface EnrichedStatement {
  id: Uint8Array;
  subjectName: string;
  predicate: string;
  objectLabel: string;
  confidence: number;
  /** When the statement's EVENT happened, in unix nanos — the reified Time
   * slot of an Event-kind statement. `null` when the statement has no event
   * time (and then absent from the wire map). */
  eventAtUnixNanos: bigint | null;
}

/** A graph-enrichment relation attached to a recall hit: from-name, predicate, to-name. */
export interface EnrichedRelation {
  fromName: string;
  predicate: string;
  toName: string;
}

/** The typed-graph neighborhood optionally attached to a recall hit (entities, statements, relations). */
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
      g.statements.map((s) => {
        const sm = new Map<string, unknown>([
          ["id", s.id],
          ["subject_name", s.subjectName],
          ["predicate", s.predicate],
          ["object_label", s.objectLabel],
          ["confidence", f32(s.confidence)],
        ]);
        if (s.eventAtUnixNanos != null)
          sm.set("event_at_unix_nanos", s.eventAtUnixNanos);
        return sm;
      }),
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

/** One recalled memory: text, the fused/rerank/similarity scores, provenance, edges, and the retrievers that surfaced it. */
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
  occurredAtUnixNanos: bigint | null;
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
    ["occurred_at_unix_nanos", r.occurredAtUnixNanos],
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
        eventAtUnixNanos: s.has("event_at_unix_nanos")
          ? asBig(field(s, "event_at_unix_nanos"))
          : null,
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
    occurredAtUnixNanos: asOpt(field(m, "occurred_at_unix_nanos"), asBig),
    edgesOutCount: asNum(field(m, "edges_out_count")),
    edgesInCount: asNum(field(m, "edges_in_count")),
    graph: asOpt(field(m, "graph"), decodeGraph),
  };
}

/**
 * The drained result of a RECALL: the final frame's `answerKind` with every
 * frame's `memories` concatenated. `answerKind` says how to read them — `Single`
 * resolves to one memory, `Many` to several, `None` to a "don't know".
 */
export interface RecallAnswer {
  answerKind: AnswerKind;
  memories: MemoryResult[];
}

/** RECALL_RESP (`0x00A1`), one streamed frame: a batch of memory hits plus the running answer verdict and remaining-count estimate. */
export interface RecallResponseFrame {
  answerKind: AnswerKind;
  memories: MemoryResult[];
  isFinal: boolean;
  cumulativeCount: number;
  estimatedRemaining: number | null;
  /** Per-stage read-pipeline trace, present only on the final frame and only
   * when the request set `trace = true`; absent (CBOR-omitted) otherwise. */
  trace?: RecallTrace;
}

/** Encode one RECALL_RESP (`0x00A1`) streamed frame. */
export function encodeRecallResponse(p: RecallResponseFrame): Uint8Array {
  const map = new Map<string, unknown>([
    ["answer_kind", p.answerKind],
    ["memories", p.memories.map(encodeMemoryResult)],
    ["is_final", p.isFinal],
    ["cumulative_count", p.cumulativeCount],
    ["estimated_remaining", p.estimatedRemaining],
  ]);
  if (p.trace != null) map.set("trace", encodeRecallTrace(p.trace));
  return toCbor(map);
}

/** Decode one RECALL_RESP (`0x00A1`) streamed frame. */
export function decodeRecallResponse(bytes: Uint8Array): RecallResponseFrame {
  const m = asMap(fromCbor(bytes));
  const out: RecallResponseFrame = {
    answerKind: asStr(field(m, "answer_kind")) as AnswerKind,
    memories: asArray(field(m, "memories")).map(decodeMemoryResult),
    isFinal: asBool(field(m, "is_final")),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    estimatedRemaining: asOpt(field(m, "estimated_remaining"), asNum),
  };
  if (m.has("trace")) out.trace = decodeRecallTrace(field(m, "trace"));
  return out;
}

// ---------------------------------------------------------------------------
// RECALL trace.
// ---------------------------------------------------------------------------

/** Terminal status of a retriever lane in a RECALL trace. Integer discriminant. */
export enum RecallTraceRetrieverStatus {
  Success = 0,
  Skipped = 1,
  Timeout = 2,
  Failure = 3,
}

/** What one retriever lane did during a traced RECALL. */
export interface RecallTraceRetriever {
  name: RetrieverNameWire;
  status: RecallTraceRetrieverStatus;
  /** Skip reason for `Skipped`, error message for `Failure`; empty otherwise. */
  statusDetail: string;
  latencyMs: number;
  candidateCount: number;
  /** Only populated in full-detail mode (`trace: true`): the raw candidates
   * this lane contributed before fusion, in the lane's own rank order. */
  candidates: RecallTraceCandidate[];
}

/** One retriever-lane candidate surfaced in full-detail trace mode. The graph
 * lane surfaces typed items (entities / relations), so `itemId` is interpreted
 * against `kind`. */
export interface RecallTraceCandidate {
  /** Raw id of the surfaced item — a memory, statement, entity, or relation id
   * depending on `kind`. */
  itemId: bigint;
  /** How to interpret `itemId`. */
  kind: RankedItemKindWire;
  /** A human-readable label — memory text, entity name, or a rendered
   * statement/relation. Full-detail mode only; truncated server-side. */
  text: string;
  /** This lane's raw score for this item. */
  score: number;
}

/** Which id-space a [[RecallTraceDroppedId]]'s `id` belongs to. Mirrors the
 * pipeline-internal `RankedItemId`: supersession, as-of, and the final limit
 * truncation can drop `Statement`/`Relation`/`Entity` items, not just
 * `Memory` ones, so those three drop lists are kind-tagged. */
export enum RankedItemKindWire {
  Memory = 0,
  Statement = 1,
  Entity = 2,
  Relation = 3,
}

/** One id a filter-chain step dropped, tagged with which id-space it came
 * from. Used where a step can drop non-`Memory` items (supersession, as-of,
 * and the final limit truncation). */
export interface RecallTraceDroppedId {
  kind: RankedItemKindWire;
  id: bigint;
}

/** Filter-chain survivor counts after each step of a traced RECALL. */
export interface RecallTraceFilterChain {
  before: number;
  afterType: number;
  afterTemporal: number;
  afterConfidence: number;
  afterTombstone: number;
  afterSupersession: number;
  afterAsOf: number;
  afterLimit: number;
  /** Only populated in full-detail mode: which memory ids were removed by
   * this specific filter step (empty = nothing dropped here). This step only
   * ever drops `Memory` items in practice, so it stays a plain id list. */
  droppedByType: bigint[];
  droppedByTemporal: bigint[];
  droppedByConfidence: bigint[];
  droppedByTombstone: bigint[];
  /** Only populated in full-detail mode: which ids were removed by
   * supersession, kind-tagged since this step drops `Statement` and
   * `Relation` items, not just `Memory` ones (empty = nothing dropped here). */
  droppedBySupersession: RecallTraceDroppedId[];
  /** Only populated in full-detail mode: which ids the bi-temporal as-of
   * filter removed, kind-tagged since this step drops `Statement` items
   * (empty = nothing dropped here). */
  droppedByAsOf: RecallTraceDroppedId[];
  /** Only populated in full-detail mode: which ids the final `limit`
   * truncation removed, kind-tagged since the truncated tail can contain any
   * item kind (empty = nothing dropped here). */
  droppedByLimit: RecallTraceDroppedId[];
}

/** Outcome of the cross-encoder rerank stage in a RECALL trace. */
export interface RecallTraceRerank {
  applied: boolean;
  candidates: number;
  latencyMs: number;
  /** Full-detail mode only: the fused (pre-rerank) order, so the client can
   * show exactly what the cross-encoder moved. */
  beforeOrder: bigint[];
  /** Full-detail mode only: the post-rerank order. */
  afterOrder: bigint[];
}

/** Full-detail mode only: per-fused-item score breakdown by contributing
 * lane, surfaced on a `RecallTrace` when the request opted into tracing. */
export interface RecallTraceFusion {
  items: RecallTraceFusionItem[];
}

/** One fused item's RRF score plus the per-lane component scores that
 * contributed to it. */
export interface RecallTraceFusionItem {
  memoryId: bigint;
  rrfScore: number;
  laneScores: [RetrieverNameWire, number][];
}

/** Per-stage observability for one traced RECALL. */
export interface RecallTrace {
  retrievers: RecallTraceRetriever[];
  filterChain: RecallTraceFilterChain;
  /** Rerank outcome, or `null` when the rerank stage did not run. */
  rerank: RecallTraceRerank | null;
  totalLatencyMs: number;
  /** Full-detail mode only: per-fused-item score breakdown by contributing
   * lane. `null` when trace detail wasn't requested or fusion produced
   * nothing. */
  fusion: RecallTraceFusion | null;
}

function encodeRecallTraceCandidate(c: RecallTraceCandidate): Map<string, unknown> {
  return new Map<string, unknown>([
    ["item_id", c.itemId],
    ["kind", c.kind as number],
    ["text", c.text],
    ["score", f32(c.score)],
  ]);
}

function decodeRecallTraceCandidate(value: unknown): RecallTraceCandidate {
  const c = asMap(value);
  return {
    itemId: asBig(field(c, "item_id")),
    kind: asNum(field(c, "kind")) as RankedItemKindWire,
    text: asStr(field(c, "text")),
    score: asNum(field(c, "score")),
  };
}

function encodeRecallTraceDroppedId(d: RecallTraceDroppedId): Map<string, unknown> {
  return new Map<string, unknown>([
    ["kind", d.kind as number],
    ["id", d.id],
  ]);
}

function decodeRecallTraceDroppedId(value: unknown): RecallTraceDroppedId {
  const d = asMap(value);
  return {
    kind: asNum(field(d, "kind")) as RankedItemKindWire,
    id: asBig(field(d, "id")),
  };
}

function encodeRecallTrace(t: RecallTrace): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "retrievers",
      t.retrievers.map(
        (r) =>
          new Map<string, unknown>([
            ["name", r.name as number],
            ["status", r.status as number],
            ["status_detail", r.statusDetail],
            ["latency_ms", f64(r.latencyMs)],
            ["candidate_count", r.candidateCount],
            ["candidates", r.candidates.map(encodeRecallTraceCandidate)],
          ]),
      ),
    ],
    [
      "filter_chain",
      new Map<string, unknown>([
        ["before", t.filterChain.before],
        ["after_type", t.filterChain.afterType],
        ["after_temporal", t.filterChain.afterTemporal],
        ["after_confidence", t.filterChain.afterConfidence],
        ["after_tombstone", t.filterChain.afterTombstone],
        ["after_supersession", t.filterChain.afterSupersession],
        ["after_as_of", t.filterChain.afterAsOf],
        ["after_limit", t.filterChain.afterLimit],
        ["dropped_by_type", t.filterChain.droppedByType],
        ["dropped_by_temporal", t.filterChain.droppedByTemporal],
        ["dropped_by_confidence", t.filterChain.droppedByConfidence],
        ["dropped_by_tombstone", t.filterChain.droppedByTombstone],
        ["dropped_by_supersession", t.filterChain.droppedBySupersession.map(encodeRecallTraceDroppedId)],
        ["dropped_by_as_of", t.filterChain.droppedByAsOf.map(encodeRecallTraceDroppedId)],
        ["dropped_by_limit", t.filterChain.droppedByLimit.map(encodeRecallTraceDroppedId)],
      ]),
    ],
    [
      "rerank",
      t.rerank === null
        ? null
        : new Map<string, unknown>([
            ["applied", t.rerank.applied],
            ["candidates", t.rerank.candidates],
            ["latency_ms", f64(t.rerank.latencyMs)],
            ["before_order", t.rerank.beforeOrder],
            ["after_order", t.rerank.afterOrder],
          ]),
    ],
    ["total_latency_ms", f64(t.totalLatencyMs)],
    [
      "fusion",
      t.fusion === null
        ? null
        : new Map<string, unknown>([
            [
              "items",
              t.fusion.items.map(
                (i) =>
                  new Map<string, unknown>([
                    ["memory_id", i.memoryId],
                    ["rrf_score", f32(i.rrfScore)],
                    ["lane_scores", i.laneScores.map(([name, score]) => [name as number, f32(score)])],
                  ]),
              ),
            ],
          ]),
    ],
  ]);
}

function decodeRecallTrace(value: unknown): RecallTrace {
  const m = asMap(value);
  const fc = asMap(field(m, "filter_chain"));
  return {
    retrievers: asArray(field(m, "retrievers")).map((v) => {
      const r = asMap(v);
      return {
        name: asNum(field(r, "name")) as RetrieverNameWire,
        status: asNum(field(r, "status")) as RecallTraceRetrieverStatus,
        statusDetail: asStr(field(r, "status_detail")),
        latencyMs: asNum(field(r, "latency_ms")),
        candidateCount: asNum(field(r, "candidate_count")),
        candidates: asArray(field(r, "candidates")).map(decodeRecallTraceCandidate),
      };
    }),
    filterChain: {
      before: asNum(field(fc, "before")),
      afterType: asNum(field(fc, "after_type")),
      afterTemporal: asNum(field(fc, "after_temporal")),
      afterConfidence: asNum(field(fc, "after_confidence")),
      afterTombstone: asNum(field(fc, "after_tombstone")),
      afterSupersession: asNum(field(fc, "after_supersession")),
      afterAsOf: asNum(field(fc, "after_as_of")),
      afterLimit: asNum(field(fc, "after_limit")),
      droppedByType: asArray(field(fc, "dropped_by_type")).map(asBig),
      droppedByTemporal: asArray(field(fc, "dropped_by_temporal")).map(asBig),
      droppedByConfidence: asArray(field(fc, "dropped_by_confidence")).map(asBig),
      droppedByTombstone: asArray(field(fc, "dropped_by_tombstone")).map(asBig),
      droppedBySupersession: asArray(field(fc, "dropped_by_supersession")).map(decodeRecallTraceDroppedId),
      droppedByAsOf: asArray(field(fc, "dropped_by_as_of")).map(decodeRecallTraceDroppedId),
      droppedByLimit: asArray(field(fc, "dropped_by_limit")).map(decodeRecallTraceDroppedId),
    },
    rerank: asOpt(field(m, "rerank"), (v) => {
      const rr = asMap(v);
      return {
        applied: asBool(field(rr, "applied")),
        candidates: asNum(field(rr, "candidates")),
        latencyMs: asNum(field(rr, "latency_ms")),
        beforeOrder: asArray(field(rr, "before_order")).map(asBig),
        afterOrder: asArray(field(rr, "after_order")).map(asBig),
      };
    }),
    totalLatencyMs: asNum(field(m, "total_latency_ms")),
    fusion: asOpt(field(m, "fusion"), (v) => {
      const fu = asMap(v);
      return {
        items: asArray(field(fu, "items")).map((iv) => {
          const i = asMap(iv);
          return {
            memoryId: asBig(field(i, "memory_id")),
            rrfScore: asNum(field(i, "rrf_score")),
            laneScores: asArray(field(i, "lane_scores")).map((lsv) => {
              const ls = asArray(lsv);
              return [asNum(ls[0]) as RetrieverNameWire, asNum(ls[1])] as [
                RetrieverNameWire,
                number,
              ];
            }),
          };
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// FORGET.
// ---------------------------------------------------------------------------

/** FORGET (`0x0024`): tombstone or hard-zero a memory by id. */
export interface ForgetRequest {
  memoryId: bigint;
  mode: ForgetMode;
  requestId: WireUuid;
  txnId: WireUuid | null;
  /** Effective identity this forget runs as. `null` (CBOR-omitted) runs as
   * the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a FORGET (`0x0024`) request. */
export function encodeForget(p: ForgetRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["memory_id", p.memoryId],
        ["mode", p.mode as number],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
      ],
      p.actAs,
    ),
  );
}

/** Decode a FORGET (`0x0024`) request payload. */
export function decodeForget(bytes: Uint8Array): ForgetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    memoryId: asBig(field(m, "memory_id")),
    mode: asNum(field(m, "mode")) as ForgetMode,
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    actAs: decodeOptActAs(m),
  };
}

/** FORGET_RESP (`0x00A4`): the disposition applied and when it took effect. */
export interface ForgetResponse {
  memoryId: bigint;
  wasAlreadyForgotten: boolean;
  edgesRemoved: number;
}

/** Encode a FORGET_RESP (`0x00A4`) payload. */
export function encodeForgetResponse(p: ForgetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["memory_id", p.memoryId],
      ["was_already_forgotten", p.wasAlreadyForgotten],
      ["edges_removed", p.edgesRemoved],
    ]),
  );
}

/** Decode a FORGET_RESP (`0x00A4`) payload. */
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

/** Structured detail sidecar on an ERROR frame (field-level cause, retry hint). */
export interface ErrorDetails {
  field: string | null;
  expected: string | null;
  actual: string | null;
}

/** ERROR (`0x00FF`): the server's structured failure frame — category, code, message, and optional retry-after. */
export interface ErrorResponse {
  code: number;
  category: ErrorCategoryWire;
  message: string;
  details: ErrorDetails | null;
  retryAfterMs: number | null;
}

/** Encode an ERROR (`0x00FF`) frame. */
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

/** Decode an ERROR (`0x00FF`) frame payload. */
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

/**
 * Statement kind. The fieldless variants encode as a variant-name text string
 * ("Fact"/"Preference"/"Event"/"Attribute"/"Relation"/"Directive"); the
 * open-ended `Custom` variant carries a single storage byte and encodes as a
 * one-entry CBOR map `{"Custom": <byte>}` (ciborium newtype-variant). The
 * storage-byte map is 0=Fact, 1=Preference, 2=Event, 3=Attribute, 4=Relation,
 * 5=Directive, and >=6 ⇒ Custom(byte).
 */
export type StatementKindWire =
  | "Fact"
  | "Preference"
  | "Event"
  | "Attribute"
  | "Relation"
  | "Directive"
  | { Custom: number };

function encodeStatementKind(k: StatementKindWire): unknown {
  // A fieldless variant is the bare variant-name string; `Custom` is the
  // ciborium newtype-variant one-entry map.
  if (typeof k === "string") return k;
  return new Map<string, unknown>([["Custom", k.Custom]]);
}

function decodeStatementKind(value: unknown): StatementKindWire {
  if (typeof value === "string") {
    switch (value) {
      case "Fact":
      case "Preference":
      case "Event":
      case "Attribute":
      case "Relation":
      case "Directive":
        return value;
      default:
        throw new CborError(`unknown StatementKind variant: ${value}`);
    }
  }
  const m = asMap(value);
  if (m.has("Custom")) return { Custom: asNum(m.get("Custom")) };
  throw new CborError("unknown StatementKind variant");
}

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

/** ENTITY_CREATE (`0x0130`): declare a typed entity with a canonical name, aliases, and an attributes blob. */
export interface EntityCreateRequest {
  entityTypeId: number;
  canonicalName: string;
  aliases: string[];
  attributesBlob: Uint8Array;
  requestId: WireUuid;
  /** Effective identity this entity create runs as. `null` (CBOR-omitted)
   * runs as the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode an ENTITY_CREATE (`0x0130`) request. */
export function encodeEntityCreate(p: EntityCreateRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["entity_type_id", p.entityTypeId],
        ["canonical_name", p.canonicalName],
        ["aliases", p.aliases],
        ["attributes_blob", Array.from(p.attributesBlob)],
        ["request_id", p.requestId],
      ],
      p.actAs,
    ),
  );
}

/** Decode an ENTITY_CREATE (`0x0130`) request payload. */
export function decodeEntityCreate(bytes: Uint8Array): EntityCreateRequest {
  const m = asMap(fromCbor(bytes));
  return {
    entityTypeId: asNum(field(m, "entity_type_id")),
    canonicalName: asStr(field(m, "canonical_name")),
    aliases: asArray(field(m, "aliases")).map(asStr),
    attributesBlob: Uint8Array.from(asArray(field(m, "attributes_blob")).map(asNum)),
    requestId: asBytes(field(m, "request_id")),
    actAs: decodeOptActAs(m),
  };
}

/** ENTITY_CREATE_RESP (`0x01B0`): the id minted for the new entity. */
export interface EntityCreateResponse {
  entityId: WireUuid;
}

/** Encode an ENTITY_CREATE_RESP (`0x01B0`) payload. */
export function encodeEntityCreateResponse(p: EntityCreateResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["entity_id", p.entityId]]));
}

/** Decode an ENTITY_CREATE_RESP (`0x01B0`) payload. */
export function decodeEntityCreateResponse(bytes: Uint8Array): EntityCreateResponse {
  const m = asMap(fromCbor(bytes));
  return { entityId: asBytes(field(m, "entity_id")) };
}

/** STATEMENT_CREATE (`0x0140`): assert a typed claim (subject/predicate/object) with evidence, confidence, and a bi-temporal validity window. */
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
  /** Effective identity this statement create runs as. `null` (CBOR-omitted)
   * runs as the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** The CBOR map for a STATEMENT_CREATE payload — shared so STATEMENT_SUPERSEDE
 * can nest one without a lossy re-encode round-trip (which would demote the
 * f32 confidence to f64). */
function statementCreateMap(p: StatementCreateRequest): Map<string, unknown> {
  return requestMapWithActAs(
    [
      ["kind", encodeStatementKind(p.kind)],
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
    ],
    p.actAs,
  );
}

/** Encode a STATEMENT_CREATE (`0x0140`) request. */
export function encodeStatementCreate(p: StatementCreateRequest): Uint8Array {
  return toCbor(statementCreateMap(p));
}

/** Decode a STATEMENT_CREATE (`0x0140`) request payload. */
export function decodeStatementCreate(bytes: Uint8Array): StatementCreateRequest {
  const m = asMap(fromCbor(bytes));
  return {
    kind: decodeStatementKind(field(m, "kind")),
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
    actAs: decodeOptActAs(m),
  };
}

/** STATEMENT_CREATE_RESP (`0x01C0`): the new statement id, any auto-superseded prior claim, and the chain root. */
export interface StatementCreateResponse {
  statementId: WireUuid;
  autoSuperseded: WireUuid;
  chainRoot: WireUuid;
}

/** Encode a STATEMENT_CREATE_RESP (`0x01C0`) payload. */
export function encodeStatementCreateResponse(p: StatementCreateResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement_id", p.statementId],
      ["auto_superseded", p.autoSuperseded],
      ["chain_root", p.chainRoot],
    ]),
  );
}

/** Decode a STATEMENT_CREATE_RESP (`0x01C0`) payload. */
export function decodeStatementCreateResponse(bytes: Uint8Array): StatementCreateResponse {
  const m = asMap(fromCbor(bytes));
  return {
    statementId: asBytes(field(m, "statement_id")),
    autoSuperseded: asBytes(field(m, "auto_superseded")),
    chainRoot: asBytes(field(m, "chain_root")),
  };
}

/** RELATION_CREATE (`0x0150`): a new typed edge between two entities with provenance and a bi-temporal validity window. */
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
  /** Effective identity this relation create runs as. `null` (CBOR-omitted)
   * runs as the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** The CBOR map for a RELATION_CREATE payload — shared so RELATION_SUPERSEDE
 * can nest one without a lossy re-encode round-trip (which would demote the
 * f32 confidence to f64). */
function relationCreateMap(p: RelationCreateRequest): Map<string, unknown> {
  return requestMapWithActAs(
    [
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
    ],
    p.actAs,
  );
}

/** Read a RELATION_CREATE map back into the typed request — shared by the
 * top-level decoder and the RELATION_SUPERSEDE nested-field decoder. */
function relationCreateFromMap(m: Map<string, unknown>): RelationCreateRequest {
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
    actAs: decodeOptActAs(m),
  };
}

/** Encode a RELATION_CREATE (`0x0150`) request: a new typed edge between two
 * entities with provenance and a bi-temporal validity window. */
export function encodeRelationCreate(p: RelationCreateRequest): Uint8Array {
  return toCbor(relationCreateMap(p));
}

/** Decode a RELATION_CREATE (`0x0150`) request payload. */
export function decodeRelationCreate(bytes: Uint8Array): RelationCreateRequest {
  return relationCreateFromMap(asMap(fromCbor(bytes)));
}

/** RELATION_CREATE_RESP (`0x01D0`): the id minted for the new relation. */
export interface RelationCreateResponse {
  relationId: WireUuid;
}

/** Encode a RELATION_CREATE_RESP (`0x01D0`) payload. */
export function encodeRelationCreateResponse(p: RelationCreateResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["relation_id", p.relationId]]));
}

/** Decode a RELATION_CREATE_RESP (`0x01D0`) payload. */
export function decodeRelationCreateResponse(bytes: Uint8Array): RelationCreateResponse {
  const m = asMap(fromCbor(bytes));
  return { relationId: asBytes(field(m, "relation_id")) };
}

/** SCHEMA_UPLOAD (`0x0120`): submit a schema document; `dryRun` validates without applying. */
export interface SchemaUploadRequest {
  schemaDocument: string;
  dryRun: boolean;
  allowBreaking: boolean;
  requestId: WireUuid;
}

/** Encode a SCHEMA_UPLOAD (`0x0120`) request. */
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

/** Decode a SCHEMA_UPLOAD (`0x0120`) request payload. */
export function decodeSchemaUpload(bytes: Uint8Array): SchemaUploadRequest {
  const m = asMap(fromCbor(bytes));
  return {
    schemaDocument: asStr(field(m, "schema_document")),
    dryRun: asBool(field(m, "dry_run")),
    allowBreaking: asBool(field(m, "allow_breaking")),
    requestId: asBytes(field(m, "request_id")),
  };
}

/** One schema validation diagnostic (location + message) returned by an upload or validate call. */
export interface SchemaValidationErrorWire {
  code: string;
  message: string;
  line: number;
  column: number;
  length: number;
  severity: number;
}

/** SCHEMA_UPLOAD_RESP (`0x01A0`): the resulting namespace/version, any validation errors, and a backward-compat verdict. */
export interface SchemaUploadResponse {
  namespace: string;
  schemaVersion: number;
  validationErrors: SchemaValidationErrorWire[];
  backwardCompatible: boolean;
  migrationSummaryBlob: Uint8Array;
}

/** Encode a SCHEMA_UPLOAD_RESP (`0x01A0`) payload. */
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

/** Decode a SCHEMA_UPLOAD_RESP (`0x01A0`) payload. */
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

/** A half-open millisecond time window used to filter a query by valid/event time. */
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

/** RRF fusion tuning for a QUERY: the k constant and per-retriever weights. */
export interface FusionConfigWire {
  k: number;
  semanticWeight: number;
  lexicalWeight: number;
  graphWeight: number;
}

/** A typed-graph retrieval shape — anchor, kind/predicate/time filters,
 * retriever selection, and fusion config. RECALL is the sole read verb; this
 * struct now only carries the query the QUERY_EXPLAIN / QUERY_TRACE debug
 * surface plans and traces. */
export interface QueryRequest {
  text: string;
  entityAnchor: WireUuid | null;
  kindFilter: number[];
  predicateFilter: string[];
  timeFilter: TimeRangeWire | null;
  asOfRecordTimeUnixNanos: bigint | null;
  confidenceMin: number | null;
  includeTombstoned: boolean;
  includeSuperseded: boolean;
  limit: number;
  retrievers: RetrieverSelectionWire;
  fusionConfig: FusionConfigWire | null;
  requestId: WireUuid;
}

/** The CBOR map for a QUERY payload — shared so QUERY_EXPLAIN / QUERY_TRACE can
 * nest a whole query without a lossy re-encode round-trip. */
function queryMap(p: QueryRequest): Map<string, unknown> {
  return new Map<string, unknown>([
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
      ["as_of_record_time_unix_nanos", p.asOfRecordTimeUnixNanos],
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
    ]);
}

/** Read a QUERY map back into the typed request — shared by the QUERY_EXPLAIN /
 * QUERY_TRACE nested-field decoders. */
function queryFromMap(m: Map<string, unknown>): QueryRequest {
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
    asOfRecordTimeUnixNanos: asOpt(field(m, "as_of_record_time_unix_nanos"), asBig),
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

/** MATERIALIZE_PROCEDURAL (`0x0164`): assemble a procedural-memory system block from the agent's top procedural statements. */
export interface MaterializeProceduralRequest {
  agentId: WireUuid;
  contextFilter: bigint;
  topK: number;
  minConfidence: number;
  categories: string[];
  requestId: WireUuid;
}

/** Encode a MATERIALIZE_PROCEDURAL (`0x0164`) request. */
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

/** Decode a MATERIALIZE_PROCEDURAL (`0x0164`) request payload. */
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

/** MATERIALIZE_PROCEDURAL_RESP (`0x01E4`): the rendered system block, the statements it drew on, and whether the budget trimmed it. */
export interface MaterializeProceduralResponse {
  systemBlock: string;
  statementIds: WireUuid[];
  totalCandidates: number;
  trimmedByBudget: boolean;
}

/** Encode a MATERIALIZE_PROCEDURAL_RESP (`0x01E4`) payload. */
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

/** Decode a MATERIALIZE_PROCEDURAL_RESP (`0x01E4`) payload. */
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

/** LINK (`0x0025`): create or reweight a typed edge between two memories. */
export interface LinkRequest {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  /** `[0, 1]` for most kinds; `[-1, 1]` for Contradicts. */
  weight: number;
  requestId: WireUuid;
  txnId: WireUuid | null;
  /** Effective identity this link runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a LINK (`0x0025`) request. */
export function encodeLink(p: LinkRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["source", p.source],
        ["target", p.target],
        ["kind", p.kind as number],
        ["weight", f32(p.weight)],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
      ],
      p.actAs,
    ),
  );
}

/** Decode a LINK (`0x0025`) request payload. */
export function decodeLink(bytes: Uint8Array): LinkRequest {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    weight: asNum(field(m, "weight")),
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    actAs: decodeOptActAs(m),
  };
}

/** LINK_RESP (`0x00A5`): the edge as stored and whether it already existed (weight overwritten). */
export interface LinkResponse {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  weight: number;
  createdAtUnixNanos: bigint;
  /** `true` if the edge already existed (LINK overwrote its weight). */
  alreadyExisted: boolean;
}

/** Encode a LINK_RESP (`0x00A5`) payload. */
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

/** Decode a LINK_RESP (`0x00A5`) payload. */
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

/** UNLINK (`0x0026`): remove the edge identified by (source, kind, target). */
export interface UnlinkRequest {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  requestId: WireUuid;
  txnId: WireUuid | null;
  /** Effective identity this unlink runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode an UNLINK (`0x0026`) request. */
export function encodeUnlink(p: UnlinkRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["source", p.source],
        ["target", p.target],
        ["kind", p.kind as number],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
      ],
      p.actAs,
    ),
  );
}

/** Decode an UNLINK (`0x0026`) request payload. */
export function decodeUnlink(bytes: Uint8Array): UnlinkRequest {
  const m = asMap(fromCbor(bytes));
  return {
    source: asBig(field(m, "source")),
    target: asBig(field(m, "target")),
    kind: asNum(field(m, "kind")) as EdgeKindWire,
    requestId: asBytes(field(m, "request_id")),
    txnId: asOptBytes(field(m, "txn_id")),
    actAs: decodeOptActAs(m),
  };
}

/** UNLINK_RESP (`0x00A6`): the edge key and whether a matching edge was removed. */
export interface UnlinkResponse {
  source: bigint;
  target: bigint;
  kind: EdgeKindWire;
  /** `true` if the edge existed and was removed; `false` if it didn't exist. */
  removed: boolean;
}

/** Encode an UNLINK_RESP (`0x00A6`) payload. */
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

/** Decode an UNLINK_RESP (`0x00A6`) payload. */
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
// MEMORY_LIST.
// ---------------------------------------------------------------------------

/** Sort axis for MEMORY_LIST. Integer discriminant on the wire. v1 supports
 * only `Created` end-to-end; the others are reserved wire values. */
export enum MemoryListSort {
  Created = 0,
  Salience = 1,
  Occurred = 2,
  LastAccessed = 3,
}

/** Sort direction for MEMORY_LIST. Integer discriminant on the wire. */
export enum MemoryListDir {
  Asc = 0,
  Desc = 1,
}

/** Which time field a MEMORY_LIST `from`/`to` range filters on. Integer
 * discriminant on the wire. v1 supports only `Created`. */
export enum MemoryListTimeAxis {
  Created = 0,
  Occurred = 1,
}

/**
 * MEMORY_LIST (`0x0027`): a paginated keyset enumeration of the caller's
 * `(namespace, agent)` memories. Not RECALL — no query, no ranking. It walks
 * the tenant timeline in a stable order and returns a page plus an opaque
 * keyset cursor. Empty/zero fields mean "no filter".
 */
export interface MemoryListRequest {
  sort: MemoryListSort;
  dir: MemoryListDir;
  /** Page size, validated server-side to `1..=100`. */
  limit: number;
  /** Empty on first page; opaque continuation token otherwise. */
  cursor: Uint8Array;
  /** Empty = all kinds; otherwise only these memory kinds are returned. */
  kinds: MemoryKindWire[];
  /** When false, tombstoned memories are excluded; when true, both active and
   * tombstoned rows are enumerated. */
  includeTombstoned: boolean;
  /** Which time field the `from`/`to` bounds apply to. */
  timeAxis: MemoryListTimeAxis;
  /** Inclusive lower time bound in unix-nanos; `0` = no lower bound. */
  fromUnixNanos: bigint;
  /** Inclusive upper time bound in unix-nanos; `0` = no upper bound. */
  toUnixNanos: bigint;
  /** Inclusive salience floor in `[0, 1]`. */
  salienceMin: number;
  /** Inclusive salience ceiling in `[0, 1]`. */
  salienceMax: number;
  /** Substring/token filter over memory text; empty = no filter. */
  textContains: string;
  /** Effective identity this list runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a MEMORY_LIST (`0x0027`) request. `act_as` trails when present. */
export function encodeMemoryList(p: MemoryListRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["sort", p.sort as number],
        ["dir", p.dir as number],
        ["limit", p.limit],
        // `cursor` is `Vec<u8>` without serde_bytes server-side → a CBOR array
        // of ints, not a byte string (matches statement/relation/entity list).
        ["cursor", Array.from(p.cursor)],
        ["kinds", p.kinds.map((k) => k as number)],
        ["include_tombstoned", p.includeTombstoned],
        ["time_axis", p.timeAxis as number],
        ["from_unix_nanos", p.fromUnixNanos],
        ["to_unix_nanos", p.toUnixNanos],
        ["salience_min", f32(p.salienceMin)],
        ["salience_max", f32(p.salienceMax)],
        ["text_contains", p.textContains],
      ],
      p.actAs,
    ),
  );
}

/** Decode a MEMORY_LIST (`0x0027`) request payload. */
export function decodeMemoryList(bytes: Uint8Array): MemoryListRequest {
  const m = asMap(fromCbor(bytes));
  return {
    sort: asNum(field(m, "sort")) as MemoryListSort,
    dir: asNum(field(m, "dir")) as MemoryListDir,
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
    kinds: asArray(field(m, "kinds")).map((k) => asNum(k) as MemoryKindWire),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    timeAxis: asNum(field(m, "time_axis")) as MemoryListTimeAxis,
    fromUnixNanos: asBig(field(m, "from_unix_nanos")),
    toUnixNanos: asBig(field(m, "to_unix_nanos")),
    salienceMin: asNum(field(m, "salience_min")),
    salienceMax: asNum(field(m, "salience_max")),
    textContains: asStr(field(m, "text_contains")),
    actAs: decodeOptActAs(m),
  };
}

/** One memory in a MEMORY_LIST response batch: the enumeration-relevant fields
 * plus relationship-handle counts. */
export interface MemoryListItem {
  memoryId: Uint8Array;
  text: string;
  /** Raw memory-kind byte (0 = Episodic, 1 = Semantic, 2 = Consolidated). */
  kind: number;
  /** Lifecycle state byte (0 = active, 1 = tombstoned). */
  state: number;
  createdAtUnixNanos: bigint;
  /** Client-supplied event time; `0` when the memory has none. */
  occurredAtUnixNanos: bigint;
  lastAccessedAtUnixNanos: bigint;
  /** Point-in-time salience snapshot (it decays). */
  salience: number;
  accessCount: number;
  sourceRequestId: Uint8Array;
  statementCount: number;
  entityCount: number;
  relationCount: number;
}

function encodeMemoryListItem(i: MemoryListItem): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", i.memoryId],
    ["text", i.text],
    ["kind", i.kind],
    ["state", i.state],
    ["created_at_unix_nanos", i.createdAtUnixNanos],
    ["occurred_at_unix_nanos", i.occurredAtUnixNanos],
    ["last_accessed_at_unix_nanos", i.lastAccessedAtUnixNanos],
    ["salience", f32(i.salience)],
    ["access_count", i.accessCount],
    ["source_request_id", i.sourceRequestId],
    ["statement_count", i.statementCount],
    ["entity_count", i.entityCount],
    ["relation_count", i.relationCount],
  ]);
}

function decodeMemoryListItem(value: unknown): MemoryListItem {
  const m = asMap(value);
  return {
    memoryId: asBytes(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    kind: asNum(field(m, "kind")),
    state: asNum(field(m, "state")),
    createdAtUnixNanos: asBig(field(m, "created_at_unix_nanos")),
    occurredAtUnixNanos: asBig(field(m, "occurred_at_unix_nanos")),
    lastAccessedAtUnixNanos: asBig(field(m, "last_accessed_at_unix_nanos")),
    salience: asNum(field(m, "salience")),
    accessCount: asNum(field(m, "access_count")),
    sourceRequestId: asBytes(field(m, "source_request_id")),
    statementCount: asNum(field(m, "statement_count")),
    entityCount: asNum(field(m, "entity_count")),
    relationCount: asNum(field(m, "relation_count")),
  };
}

/** One streamed MEMORY_LIST_RESP (`0x00A7`) frame. The last frame carries
 * `isFinal = true`; a non-empty `nextCursor` means more pages remain. */
export interface MemoryListResponseFrame {
  items: MemoryListItem[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

/** Encode one MEMORY_LIST_RESP (`0x00A7`) streamed frame. */
export function encodeMemoryListResponse(p: MemoryListResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["items", p.items.map(encodeMemoryListItem)],
      // `next_cursor` is `Vec<u8>` without serde_bytes → CBOR array of ints.
      ["next_cursor", Array.from(p.nextCursor)],
      ["cumulative_count", p.cumulativeCount],
      ["is_final", p.isFinal],
    ]),
  );
}

/** Decode one MEMORY_LIST_RESP (`0x00A7`) streamed frame. */
export function decodeMemoryListResponse(bytes: Uint8Array): MemoryListResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeMemoryListItem),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// GRAPH_FETCH — full-agent typed-graph export.
// ---------------------------------------------------------------------------

/** One graph node. `id` is the 16-byte entity / statement / memory id; `kind`
 * says which id-space it is (0 = Entity, 1 = Statement, 2 = Memory). */
export interface GraphNode {
  id: Uint8Array;
  kind: number;
  label: string;
  /** Entity type qname (e.g. `brain:Person`); empty for non-entity nodes. */
  typeQname: string;
}

function encodeGraphNode(n: GraphNode): Map<string, unknown> {
  return new Map<string, unknown>([
    ["id", n.id],
    ["kind", n.kind],
    ["label", n.label],
    ["type_qname", n.typeQname],
  ]);
}

function decodeGraphNode(value: unknown): GraphNode {
  const m = asMap(value);
  return {
    id: asBytes(field(m, "id")),
    kind: asNum(field(m, "kind")),
    label: asStr(field(m, "label")),
    typeQname: asStr(field(m, "type_qname")),
  };
}

/** One graph edge. `kind`: 0 = Relation, 1 = Fact, 2 = HasStatement, 3 = Mentions. */
export interface GraphEdge {
  fromId: Uint8Array;
  toId: Uint8Array;
  kind: number;
  /** Predicate / relation-type label; empty for `Mentions`. */
  label: string;
}

function encodeGraphEdge(e: GraphEdge): Map<string, unknown> {
  return new Map<string, unknown>([
    ["from_id", e.fromId],
    ["to_id", e.toId],
    ["kind", e.kind],
    ["label", e.label],
  ]);
}

function decodeGraphEdge(value: unknown): GraphEdge {
  const m = asMap(value);
  return {
    fromId: asBytes(field(m, "from_id")),
    toId: asBytes(field(m, "to_id")),
    kind: asNum(field(m, "kind")),
    label: asStr(field(m, "label")),
  };
}

/**
 * GRAPH_FETCH (`0x0163`): a paginated export of the caller's whole
 * `(namespace, agent)` typed graph as a node/edge set. Default layer is the
 * concept map (entity nodes + Relation/Fact edges); `includeStatements` adds
 * value-object statement nodes, `includeMemories` adds source-memory nodes,
 * `includeMemoryEdges` adds the stored memory↔memory links between them.
 * The cursor is opaque, signed over the layer toggles.
 */
export interface GraphFetchRequest {
  /** Page size, validated server-side to `1..=500`. */
  limit: number;
  /** Empty on first page; opaque continuation token otherwise. */
  cursor: Uint8Array;
  /** Emit value-object statement nodes + their `HasStatement` edges. */
  includeStatements: boolean;
  /** Emit source memory nodes + their `Mentions` edges. */
  includeMemories: boolean;
  /** Emit the stored memory↔memory edges (`SimilarTo`, `FollowedBy`, …)
   * incident to the page's memory nodes. Requires `includeMemories` — setting
   * it alone is rejected, because the edges would have no rendered endpoints. */
  includeMemoryEdges: boolean;
  /** Include tombstoned statements/relations. Default false. */
  includeTombstoned: boolean;
  /** Effective identity this export runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a GRAPH_FETCH (`0x0163`) request. `act_as` trails when present. */
export function encodeGraphFetch(p: GraphFetchRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["limit", p.limit],
        // `cursor` is `Vec<u8>` without serde_bytes server-side → a CBOR array
        // of ints, not a byte string (matches the *_list cursors).
        ["cursor", Array.from(p.cursor)],
        ["include_statements", p.includeStatements],
        ["include_memories", p.includeMemories],
        ["include_memory_edges", p.includeMemoryEdges],
        ["include_tombstoned", p.includeTombstoned],
      ],
      p.actAs,
    ),
  );
}

/** Decode a GRAPH_FETCH (`0x0163`) request payload. */
export function decodeGraphFetch(bytes: Uint8Array): GraphFetchRequest {
  const m = asMap(fromCbor(bytes));
  return {
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
    includeStatements: asBool(field(m, "include_statements")),
    includeMemories: asBool(field(m, "include_memories")),
    includeMemoryEdges: asBool(field(m, "include_memory_edges")),
    includeTombstoned: asBool(field(m, "include_tombstoned")),
    actAs: decodeOptActAs(m),
  };
}

/** One streamed GRAPH_FETCH_RESP (`0x01E3`) frame. Nodes/edges may repeat
 * across pages (completeness, not disjointness) — dedup by id. The last frame
 * carries `isFinal = true`; a non-empty `nextCursor` means more pages remain. */
export interface GraphFetchResponseFrame {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor: Uint8Array;
  isFinal: boolean;
}

/** Encode one GRAPH_FETCH_RESP (`0x01E3`) streamed frame. */
export function encodeGraphFetchResponse(p: GraphFetchResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["nodes", p.nodes.map(encodeGraphNode)],
      ["edges", p.edges.map(encodeGraphEdge)],
      // `next_cursor` is `Vec<u8>` without serde_bytes → CBOR array of ints.
      ["next_cursor", Array.from(p.nextCursor)],
      ["is_final", p.isFinal],
    ]),
  );
}

/** Decode one GRAPH_FETCH_RESP (`0x01E3`) streamed frame. */
export function decodeGraphFetchResponse(bytes: Uint8Array): GraphFetchResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    nodes: asArray(field(m, "nodes")).map(decodeGraphNode),
    edges: asArray(field(m, "edges")).map(decodeGraphEdge),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// PLAN.
// ---------------------------------------------------------------------------

/** Search strategy hint for PLAN (auto, A*, MCTS, or attractor rollout). */
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

/** Resource ceiling for a PLAN search: max steps, wall time, and branches explored. */
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

/** PLAN (`0x0022`): search for a path from a start endpoint to a goal endpoint under a budget. */
export interface PlanRequest {
  start: PlanState;
  goal: PlanState;
  budget: PlanBudget;
  strategyHint: PlanStrategy | null;
  contextFilter: bigint[] | null;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
  /** Opt-in per-stage observability. When `true`, the final PLAN_RESP frame
   * carries a populated `trace: PlanTrace` describing every node the
   * bidirectional BFS visited (in both directions) and every meeting point
   * found, including the ones dropped by the `max_paths` cap. When `false`
   * (the default) the pipeline discards that data as before, so the flag is
   * zero-cost on the hot path. Mirrors `RecallRequest.trace`. */
  trace: boolean;
  /** Effective identity this plan runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a PLAN (`0x0022`) request. */
export function encodePlan(p: PlanRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["start", encodePlanState(p.start)],
        ["goal", encodePlanState(p.goal)],
        ["budget", encodePlanBudget(p.budget)],
        ["strategy_hint", p.strategyHint === null ? null : (p.strategyHint as number)],
        ["context_filter", p.contextFilter === null ? null : p.contextFilter],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
        ["trace", p.trace],
      ],
      p.actAs,
    ),
  );
}

/** Decode a PLAN (`0x0022`) request payload. */
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
    trace: m.has("trace") ? asBool(field(m, "trace")) : false,
    actAs: decodeOptActAs(m),
  };
}

/** Terminal disposition of a PLAN search (found, no path, budget exhausted, ...). */
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

/** One step along a planned path: the memory reached and the edge taken to get there. */
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

/** PLAN_RESP (`0x00A2`), one streamed frame: a batch of path steps plus the terminal plan status on the final frame. */
export interface PlanResponseFrame {
  steps: PlanStep[];
  isFinal: boolean;
  planStatus: PlanStatus | null;
  /** Per-stage bidirectional-search trace, present only on the final frame
   * and only when the request set `trace = true`; absent (CBOR-omitted)
   * otherwise. Mirrors `RecallResponseFrame.trace`. */
  trace?: PlanTrace;
}

/** Encode one PLAN_RESP (`0x00A2`) streamed frame. */
export function encodePlanResponse(p: PlanResponseFrame): Uint8Array {
  const map = new Map<string, unknown>([
    ["steps", p.steps.map(encodePlanStep)],
    ["is_final", p.isFinal],
    ["plan_status", p.planStatus === null ? null : (p.planStatus as number)],
  ]);
  if (p.trace != null) map.set("trace", encodePlanTrace(p.trace));
  return toCbor(map);
}

/** Decode one PLAN_RESP (`0x00A2`) streamed frame. */
export function decodePlanResponse(bytes: Uint8Array): PlanResponseFrame {
  const m = asMap(fromCbor(bytes));
  const out: PlanResponseFrame = {
    steps: asArray(field(m, "steps")).map(decodePlanStep),
    isFinal: asBool(field(m, "is_final")),
    planStatus: asOpt(field(m, "plan_status"), (v) => asNum(v) as PlanStatus),
  };
  if (m.has("trace")) out.trace = decodePlanTrace(field(m, "trace"));
  return out;
}

// ---------------------------------------------------------------------------
// PLAN trace.
// ---------------------------------------------------------------------------

/** Which direction of the bidirectional BFS a `PlanTraceNode` was visited from. */
export enum PlanTraceDirection {
  /** Visited by the forward search, rooted at `start`. */
  Forward = 0,
  /** Visited by the backward search, rooted at `goal`. */
  Backward = 1,
}

/** One node the bidirectional BFS visited, from either direction. */
export interface PlanTraceNode {
  memoryId: bigint;
  text: string;
  direction: PlanTraceDirection;
  depth: number;
  /** The parent node's memory id this node was reached through. `null` for
   * the root (`start` in the forward direction, `goal` in the backward
   * direction). */
  parentEdge: bigint | null;
  /** The goal-proximity alignment score computed for this node, when one
   * was computed. */
  alignmentScore: number | null;
}

/** One meeting point the bidirectional BFS found where the forward and
 * backward frontiers connected. */
export interface PlanTraceMeetingPoint {
  memoryId: bigint;
  text: string;
  /** `true` when this meeting point survived the `max_paths` cap and
   * contributed a path to the response; `false` when it was found but
   * dropped by the cap. */
  includedInResult: boolean;
}

/** Per-stage observability for one traced PLAN. */
export interface PlanTrace {
  /** Every node the bidirectional BFS visited, in both directions. */
  explored: PlanTraceNode[];
  /** Every meeting point the BFS found, flagging which ones survived the
   * `max_paths` cap and made it into the returned path(s). */
  meetingPoints: PlanTraceMeetingPoint[];
}

function encodePlanTraceNode(n: PlanTraceNode): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", n.memoryId],
    ["text", n.text],
    ["direction", n.direction as number],
    ["depth", n.depth],
    ["parent_edge", n.parentEdge],
    ["alignment_score", n.alignmentScore === null ? null : f32(n.alignmentScore)],
  ]);
}

function decodePlanTraceNode(value: unknown): PlanTraceNode {
  const m = asMap(value);
  return {
    memoryId: asBig(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    direction: asNum(field(m, "direction")) as PlanTraceDirection,
    depth: asNum(field(m, "depth")),
    parentEdge: asOpt(field(m, "parent_edge"), asBig),
    alignmentScore: asOpt(field(m, "alignment_score"), asNum),
  };
}

function encodePlanTraceMeetingPoint(p: PlanTraceMeetingPoint): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", p.memoryId],
    ["text", p.text],
    ["included_in_result", p.includedInResult],
  ]);
}

function decodePlanTraceMeetingPoint(value: unknown): PlanTraceMeetingPoint {
  const m = asMap(value);
  return {
    memoryId: asBig(field(m, "memory_id")),
    text: asStr(field(m, "text")),
    includedInResult: asBool(field(m, "included_in_result")),
  };
}

function encodePlanTrace(t: PlanTrace): Map<string, unknown> {
  return new Map<string, unknown>([
    ["explored", t.explored.map(encodePlanTraceNode)],
    ["meeting_points", t.meetingPoints.map(encodePlanTraceMeetingPoint)],
  ]);
}

function decodePlanTrace(value: unknown): PlanTrace {
  const m = asMap(value);
  return {
    explored: asArray(field(m, "explored")).map(decodePlanTraceNode),
    meetingPoints: asArray(field(m, "meeting_points")).map(decodePlanTraceMeetingPoint),
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

/** REASON (`0x0023`): derive inferences about an observation under a depth/branch budget. */
export interface ReasonRequest {
  observation: ObservationInput;
  depth: number;
  confidenceThreshold: number;
  contextFilter: bigint[] | null;
  maxInferences: number;
  budgetWallTimeMs: number;
  requestId: WireUuid | null;
  txnId: WireUuid | null;
  /** Opt-in per-stage observability. When `true`, the final REASON_RESP frame
   * carries a populated `trace: ReasonTrace` describing the full
   * base-candidate set, every edge the outward walk considered (and why each
   * was pruned), the un-collapsed per-item score components, and whether
   * topic-alignment centroid computation ran. When `false` (the default) the
   * pipeline discards that data as before, so the flag is zero-cost on the
   * hot path. Mirrors `RecallRequest.trace`. */
  trace: boolean;
  /** Effective identity this reason runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a REASON (`0x0023`) request. */
export function encodeReason(p: ReasonRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["observation", encodeObservationInput(p.observation)],
        ["depth", p.depth],
        ["confidence_threshold", f32(p.confidenceThreshold)],
        ["context_filter", p.contextFilter === null ? null : p.contextFilter],
        ["max_inferences", p.maxInferences],
        ["budget_wall_time_ms", p.budgetWallTimeMs],
        ["request_id", p.requestId],
        ["txn_id", p.txnId],
        ["trace", p.trace],
      ],
      p.actAs,
    ),
  );
}

/** Decode a REASON (`0x0023`) request payload. */
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
    trace: m.has("trace") ? asBool(field(m, "trace")) : false,
    actAs: decodeOptActAs(m),
  };
}

/** Terminal disposition of a REASON run (complete, budget exhausted, depth limit, cancelled). */
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

/** One inference: the claim, its supporting/contradicting memories, confidence, and the inference kind. */
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

/** REASON_RESP (`0x00A3`), one streamed frame: a batch of inference steps plus the terminal reason status on the final frame. */
export interface ReasonResponseFrame {
  inferences: InferenceStep[];
  isFinal: boolean;
  reasonStatus: ReasonStatus | null;
  /** Per-stage read-pipeline trace, present only on the final frame and only
   * when the request set `trace = true`; absent (CBOR-omitted) otherwise.
   * Mirrors `RecallResponseFrame.trace`. */
  trace?: ReasonTrace;
}

/** Encode one REASON_RESP (`0x00A3`) streamed frame. */
export function encodeReasonResponse(p: ReasonResponseFrame): Uint8Array {
  const map = new Map<string, unknown>([
    ["inferences", p.inferences.map(encodeInferenceStep)],
    ["is_final", p.isFinal],
    ["reason_status", p.reasonStatus === null ? null : (p.reasonStatus as number)],
  ]);
  if (p.trace != null) map.set("trace", encodeReasonTrace(p.trace));
  return toCbor(map);
}

/** Decode one REASON_RESP (`0x00A3`) streamed frame. */
export function decodeReasonResponse(bytes: Uint8Array): ReasonResponseFrame {
  const m = asMap(fromCbor(bytes));
  const out: ReasonResponseFrame = {
    inferences: asArray(field(m, "inferences")).map(decodeInferenceStep),
    isFinal: asBool(field(m, "is_final")),
    reasonStatus: asOpt(field(m, "reason_status"), (v) => asNum(v) as ReasonStatus),
  };
  if (m.has("trace")) out.trace = decodeReasonTrace(field(m, "trace"));
  return out;
}

// ---------------------------------------------------------------------------
// REASON trace.
// ---------------------------------------------------------------------------

/** One base-candidate hit surfaced in a REASON trace. */
export interface ReasonTraceCandidate {
  memoryId: bigint;
  text: string;
  score: number;
}

/** The base observation's resolved candidate set, before any evidence walk. */
export interface ReasonTraceBase {
  candidates: ReasonTraceCandidate[];
}

/** One edge the outward walk visited, considered or dropped. */
export interface ReasonTraceEdgeCandidate {
  memoryId: bigint;
  text: string;
  edgeKind: EdgeKindWire;
  depth: number;
  fromMemoryId: bigint;
  rawScore: number;
}

/** A memory id plus its stored text, with no other payload — the shared
 * shape for the walk's plain id-dropped buckets (tombstone / visited /
 * trim-cap) so an opaque id is never surfaced without the content that
 * explains the drop. */
export interface ReasonTraceIdWithText {
  memoryId: bigint;
  text: string;
}

/** A memory id paired with the score it was dropped at. */
export interface ReasonTraceScoredId {
  memoryId: bigint;
  text: string;
  score: number;
}

/** Everything the outward evidence walk considered and every reason an edge
 * or item was pruned before becoming a surviving `InferenceStep`. */
export interface ReasonTraceWalk {
  /** Every edge the walk visited at each node, before any pruning — the
   * direct analogue of `RecallTraceRetriever.candidates`. */
  considered: ReasonTraceEdgeCandidate[];
  /** Edges pruned by the edge-kind filter. */
  droppedByEdgeKind: ReasonTraceEdgeCandidate[];
  /** Edges pruned because the target memory was tombstoned. */
  droppedByTombstone: ReasonTraceIdWithText[];
  /** Edges pruned because the target memory was already visited. */
  droppedByVisited: ReasonTraceIdWithText[];
  /** Evidence items pruned by `confidence_threshold` in `filter_and_trim`. */
  droppedByConfidence: ReasonTraceScoredId[];
  /** Supporting-evidence items dropped by the per-inference trim cap. */
  droppedByMaxSupporting: ReasonTraceIdWithText[];
  /** Contradicting-evidence items dropped by the per-inference trim cap. */
  droppedByMaxContradicting: ReasonTraceIdWithText[];
}

/** The un-collapsed multiplicative score components combined into one
 * `InferenceStep.confidence` value. */
export interface ReasonTraceScoreBreakdown {
  memoryId: bigint;
  text: string;
  baseSimilarity: number;
  decay: number;
  weightProduct: number;
  alignment: number;
  /** Structural-fit nudge from VSA analogical inference (bind/bundle/
   * `analogy_query` over the item's statement-graph triple against the
   * observation's own triple). Neutral `1.0` when no triple is resolvable
   * for the item — a re-rank nudge only, never a gate. */
  analogicalFit: number;
  finalScore: number;
}

/** Whether topic-alignment centroid computation ran for this REASON. */
export interface ReasonTraceCentroid {
  computed: boolean;
  /** Populated when `computed = false`; `null` otherwise. */
  skippedReason: string | null;
}

/** Per-stage observability for one traced REASON. */
export interface ReasonTrace {
  /** The full HNSW hit set resolved for the base observation, not just the
   * subset that seeded the walk. */
  base: ReasonTraceBase;
  /** Everything the outward evidence walk touched: considered edges and
   * every prune reason, one bucket per prune point. */
  walk: ReasonTraceWalk;
  /** Un-collapsed score components for every surviving evidence item. */
  scoring: ReasonTraceScoreBreakdown[];
  /** Whether topic-alignment centroid computation ran, and why not when it
   * didn't. */
  centroid: ReasonTraceCentroid;
}

function encodeReasonTraceCandidate(c: ReasonTraceCandidate): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", c.memoryId],
    ["text", c.text],
    ["score", f32(c.score)],
  ]);
}

function decodeReasonTraceCandidate(value: unknown): ReasonTraceCandidate {
  const c = asMap(value);
  return {
    memoryId: asBig(field(c, "memory_id")),
    text: asStr(field(c, "text")),
    score: asNum(field(c, "score")),
  };
}

function encodeReasonTraceEdgeCandidate(e: ReasonTraceEdgeCandidate): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", e.memoryId],
    ["text", e.text],
    ["edge_kind", e.edgeKind as number],
    ["depth", e.depth],
    ["from_memory_id", e.fromMemoryId],
    ["raw_score", f32(e.rawScore)],
  ]);
}

function decodeReasonTraceEdgeCandidate(value: unknown): ReasonTraceEdgeCandidate {
  const e = asMap(value);
  return {
    memoryId: asBig(field(e, "memory_id")),
    text: asStr(field(e, "text")),
    edgeKind: asNum(field(e, "edge_kind")) as EdgeKindWire,
    depth: asNum(field(e, "depth")),
    fromMemoryId: asBig(field(e, "from_memory_id")),
    rawScore: asNum(field(e, "raw_score")),
  };
}

function encodeReasonTraceIdWithText(i: ReasonTraceIdWithText): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", i.memoryId],
    ["text", i.text],
  ]);
}

function decodeReasonTraceIdWithText(value: unknown): ReasonTraceIdWithText {
  const i = asMap(value);
  return {
    memoryId: asBig(field(i, "memory_id")),
    text: asStr(field(i, "text")),
  };
}

function encodeReasonTraceScoredId(s: ReasonTraceScoredId): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", s.memoryId],
    ["text", s.text],
    ["score", f32(s.score)],
  ]);
}

function decodeReasonTraceScoredId(value: unknown): ReasonTraceScoredId {
  const s = asMap(value);
  return {
    memoryId: asBig(field(s, "memory_id")),
    text: asStr(field(s, "text")),
    score: asNum(field(s, "score")),
  };
}

function encodeReasonTraceScoreBreakdown(s: ReasonTraceScoreBreakdown): Map<string, unknown> {
  return new Map<string, unknown>([
    ["memory_id", s.memoryId],
    ["text", s.text],
    ["base_similarity", f32(s.baseSimilarity)],
    ["decay", f32(s.decay)],
    ["weight_product", f32(s.weightProduct)],
    ["alignment", f32(s.alignment)],
    ["analogical_fit", f32(s.analogicalFit)],
    ["final_score", f32(s.finalScore)],
  ]);
}

function decodeReasonTraceScoreBreakdown(value: unknown): ReasonTraceScoreBreakdown {
  const s = asMap(value);
  return {
    memoryId: asBig(field(s, "memory_id")),
    text: asStr(field(s, "text")),
    baseSimilarity: asNum(field(s, "base_similarity")),
    decay: asNum(field(s, "decay")),
    weightProduct: asNum(field(s, "weight_product")),
    alignment: asNum(field(s, "alignment")),
    analogicalFit: asNum(field(s, "analogical_fit")),
    finalScore: asNum(field(s, "final_score")),
  };
}

function encodeReasonTrace(t: ReasonTrace): Map<string, unknown> {
  return new Map<string, unknown>([
    ["base", new Map<string, unknown>([["candidates", t.base.candidates.map(encodeReasonTraceCandidate)]])],
    [
      "walk",
      new Map<string, unknown>([
        ["considered", t.walk.considered.map(encodeReasonTraceEdgeCandidate)],
        ["dropped_by_edge_kind", t.walk.droppedByEdgeKind.map(encodeReasonTraceEdgeCandidate)],
        ["dropped_by_tombstone", t.walk.droppedByTombstone.map(encodeReasonTraceIdWithText)],
        ["dropped_by_visited", t.walk.droppedByVisited.map(encodeReasonTraceIdWithText)],
        ["dropped_by_confidence", t.walk.droppedByConfidence.map(encodeReasonTraceScoredId)],
        [
          "dropped_by_max_supporting",
          t.walk.droppedByMaxSupporting.map(encodeReasonTraceIdWithText),
        ],
        [
          "dropped_by_max_contradicting",
          t.walk.droppedByMaxContradicting.map(encodeReasonTraceIdWithText),
        ],
      ]),
    ],
    ["scoring", t.scoring.map(encodeReasonTraceScoreBreakdown)],
    [
      "centroid",
      new Map<string, unknown>([
        ["computed", t.centroid.computed],
        ["skipped_reason", t.centroid.skippedReason],
      ]),
    ],
  ]);
}

function decodeReasonTrace(value: unknown): ReasonTrace {
  const m = asMap(value);
  const base = asMap(field(m, "base"));
  const walk = asMap(field(m, "walk"));
  const centroid = asMap(field(m, "centroid"));
  return {
    base: {
      candidates: asArray(field(base, "candidates")).map(decodeReasonTraceCandidate),
    },
    walk: {
      considered: asArray(field(walk, "considered")).map(decodeReasonTraceEdgeCandidate),
      droppedByEdgeKind: asArray(field(walk, "dropped_by_edge_kind")).map(
        decodeReasonTraceEdgeCandidate,
      ),
      droppedByTombstone: asArray(field(walk, "dropped_by_tombstone")).map(
        decodeReasonTraceIdWithText,
      ),
      droppedByVisited: asArray(field(walk, "dropped_by_visited")).map(
        decodeReasonTraceIdWithText,
      ),
      droppedByConfidence: asArray(field(walk, "dropped_by_confidence")).map(
        decodeReasonTraceScoredId,
      ),
      droppedByMaxSupporting: asArray(field(walk, "dropped_by_max_supporting")).map(
        decodeReasonTraceIdWithText,
      ),
      droppedByMaxContradicting: asArray(field(walk, "dropped_by_max_contradicting")).map(
        decodeReasonTraceIdWithText,
      ),
    },
    scoring: asArray(field(m, "scoring")).map(decodeReasonTraceScoreBreakdown),
    centroid: {
      computed: asBool(field(centroid, "computed")),
      skippedReason: asOpt(field(centroid, "skipped_reason"), asStr),
    },
  };
}

// ---------------------------------------------------------------------------
// TXN_BEGIN / TXN_COMMIT / TXN_ABORT.
// ---------------------------------------------------------------------------

/** TXN_BEGIN (`0x0040`): open a transaction under a client-minted id that later writes enroll in. */
export interface TxnBeginRequest {
  txnId: WireUuid;
  timeoutSeconds: number;
}

/** Encode a TXN_BEGIN (`0x0040`) request. */
export function encodeTxnBegin(p: TxnBeginRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["timeout_seconds", p.timeoutSeconds],
    ]),
  );
}

/** Decode a TXN_BEGIN (`0x0040`) request payload. */
export function decodeTxnBegin(bytes: Uint8Array): TxnBeginRequest {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    timeoutSeconds: asNum(field(m, "timeout_seconds")),
  };
}

/** TXN_BEGIN_RESP (`0x00C0`): confirmation the transaction is open. */
export interface TxnBeginResponse {
  txnId: WireUuid;
  timeoutSeconds: number;
  startedAtUnixNanos: bigint;
}

/** Encode a TXN_BEGIN_RESP (`0x00C0`) payload. */
export function encodeTxnBeginResponse(p: TxnBeginResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["timeout_seconds", p.timeoutSeconds],
      ["started_at_unix_nanos", p.startedAtUnixNanos],
    ]),
  );
}

/** Decode a TXN_BEGIN_RESP (`0x00C0`) payload. */
export function decodeTxnBeginResponse(bytes: Uint8Array): TxnBeginResponse {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    timeoutSeconds: asNum(field(m, "timeout_seconds")),
    startedAtUnixNanos: asBig(field(m, "started_at_unix_nanos")),
  };
}

/** TXN_COMMIT (`0x0041`): apply a transaction's buffered writes. */
export interface TxnCommitRequest {
  txnId: WireUuid;
}

/** Encode a TXN_COMMIT (`0x0041`) request. */
export function encodeTxnCommit(p: TxnCommitRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["txn_id", p.txnId]]));
}

/** Decode a TXN_COMMIT (`0x0041`) request payload. */
export function decodeTxnCommit(bytes: Uint8Array): TxnCommitRequest {
  const m = asMap(fromCbor(bytes));
  return { txnId: asBytes(field(m, "txn_id")) };
}

/** TXN_COMMIT_RESP (`0x00C1`): how many operations the commit applied. */
export interface TxnCommitResponse {
  txnId: WireUuid;
  committedAtUnixNanos: bigint;
  operationsApplied: number;
}

/** Encode a TXN_COMMIT_RESP (`0x00C1`) payload. */
export function encodeTxnCommitResponse(p: TxnCommitResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["committed_at_unix_nanos", p.committedAtUnixNanos],
      ["operations_applied", p.operationsApplied],
    ]),
  );
}

/** Decode a TXN_COMMIT_RESP (`0x00C1`) payload. */
export function decodeTxnCommitResponse(bytes: Uint8Array): TxnCommitResponse {
  const m = asMap(fromCbor(bytes));
  return {
    txnId: asBytes(field(m, "txn_id")),
    committedAtUnixNanos: asBig(field(m, "committed_at_unix_nanos")),
    operationsApplied: asNum(field(m, "operations_applied")),
  };
}

/** TXN_ABORT (`0x0042`): discard a transaction's buffered writes. */
export interface TxnAbortRequest {
  txnId: WireUuid;
}

/** Encode a TXN_ABORT (`0x0042`) request. */
export function encodeTxnAbort(p: TxnAbortRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["txn_id", p.txnId]]));
}

/** Decode a TXN_ABORT (`0x0042`) request payload. */
export function decodeTxnAbort(bytes: Uint8Array): TxnAbortRequest {
  const m = asMap(fromCbor(bytes));
  return { txnId: asBytes(field(m, "txn_id")) };
}

/** TXN_ABORT_RESP (`0x00C2`): confirmation the transaction was discarded. */
export interface TxnAbortResponse {
  txnId: WireUuid;
  operationsDiscarded: number;
}

/** Encode a TXN_ABORT_RESP (`0x00C2`) payload. */
export function encodeTxnAbortResponse(p: TxnAbortResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["txn_id", p.txnId],
      ["operations_discarded", p.operationsDiscarded],
    ]),
  );
}

/** Decode a TXN_ABORT_RESP (`0x00C2`) payload. */
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

/** Encode a GET_CAPABILITIES (`0x0032`) request (empty payload). */
export function encodeGetCapabilities(_p: GetCapabilitiesRequest): Uint8Array {
  return toCbor(new Map<string, unknown>());
}

/** Decode a GET_CAPABILITIES (`0x0032`) request payload. */
export function decodeGetCapabilities(_bytes: Uint8Array): GetCapabilitiesRequest {
  return {};
}

/** The connected shard's live capability flags: reranker loaded, extractor tiers enabled, and embedding dimensionality. */
export interface Capabilities {
  rerank: boolean;
  llmExtractor: boolean;
  classifierExtractor: boolean;
  patternExtractor: boolean;
  schemaNamespaces: string[];
  vectorDim: number;
}

/** GET_CAPABILITIES_RESP (`0x00B2`): the shard's live capabilities plus the active user schema namespaces. */
export interface GetCapabilitiesResponse {
  capabilities: Capabilities;
}

/** Encode a GET_CAPABILITIES_RESP (`0x00B2`) payload. */
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

/** Decode a GET_CAPABILITIES_RESP (`0x00B2`) payload. */
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
// EXTRACTOR_LIST.
// ---------------------------------------------------------------------------

/** Empty request body — the registry is server-side state. Extraction is
 * always-on, so `EXTRACTOR_LIST` is the only extractor wire op and it takes no
 * arguments: every registered extractor is returned. */
export interface ExtractorListRequest {}

/** Encode an EXTRACTOR_LIST (`0x0124`) request (empty payload). */
export function encodeExtractorList(_p: ExtractorListRequest): Uint8Array {
  return toCbor(new Map<string, unknown>());
}

/** Decode an EXTRACTOR_LIST (`0x0124`) request payload. */
export function decodeExtractorList(_bytes: Uint8Array): ExtractorListRequest {
  return {};
}

/** One row in an {@link ExtractorListResponseFrame}: the extractor's id,
 * owning namespace, name, tier kind (`0`=pattern, `1`=classifier, `2`=llm),
 * schema version, and creation timestamp. */
export interface ExtractorListItem {
  extractorId: number;
  namespace: string;
  name: string;
  kind: number;
  schemaVersion: number;
  createdAtUnixNanos: bigint;
}

/** EXTRACTOR_LIST_RESP (`0x01A4`): a single-frame snapshot of the always-on
 * extractors, with the total count and a final-frame marker. */
export interface ExtractorListResponseFrame {
  items: ExtractorListItem[];
  total: number;
  isFinal: boolean;
}

/** Encode an EXTRACTOR_LIST_RESP (`0x01A4`) payload. */
export function encodeExtractorListResponse(p: ExtractorListResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      [
        "items",
        p.items.map(
          (it) =>
            new Map<string, unknown>([
              ["extractor_id", it.extractorId],
              ["namespace", it.namespace],
              ["name", it.name],
              ["kind", it.kind],
              ["schema_version", it.schemaVersion],
              ["created_at_unix_nanos", it.createdAtUnixNanos],
            ]),
        ),
      ],
      ["total", p.total],
      ["is_final", p.isFinal],
    ]),
  );
}

/** Decode an EXTRACTOR_LIST_RESP (`0x01A4`) payload. */
export function decodeExtractorListResponse(bytes: Uint8Array): ExtractorListResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map((v) => {
      const im = asMap(v);
      return {
        extractorId: asNum(field(im, "extractor_id")),
        namespace: asStr(field(im, "namespace")),
        name: asStr(field(im, "name")),
        kind: asNum(field(im, "kind")),
        schemaVersion: asNum(field(im, "schema_version")),
        createdAtUnixNanos: asBig(field(im, "created_at_unix_nanos")),
      };
    }),
    total: asNum(field(m, "total")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// ENTITY_GET / ENTITY_LIST.
// ---------------------------------------------------------------------------

/** A full entity row as returned by reads: id, type, canonical/normalized names, aliases, attributes, mention count, and lifecycle stamps. */
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

/** ENTITY_GET (`0x0131`): fetch one entity by id. */
export interface EntityGetRequest {
  entityId: WireUuid;
  /** Effective identity this get runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the connection's
   * own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode an ENTITY_GET (`0x0131`) request. */
export function encodeEntityGet(p: EntityGetRequest): Uint8Array {
  return toCbor(requestMapWithActAs([["entity_id", p.entityId]], p.actAs));
}

/** Decode an ENTITY_GET (`0x0131`) request payload. */
export function decodeEntityGet(bytes: Uint8Array): EntityGetRequest {
  const m = asMap(fromCbor(bytes));
  return { entityId: asBytes(field(m, "entity_id")), actAs: decodeOptActAs(m) };
}

/** ENTITY_GET_RESP (`0x01B1`): the requested entity view. */
export interface EntityGetResponse {
  entity: EntityView;
}

/** Encode an ENTITY_GET_RESP (`0x01B1`) payload. */
export function encodeEntityGetResponse(p: EntityGetResponse): Uint8Array {
  return toCbor(new Map<string, unknown>([["entity", encodeEntityView(p.entity)]]));
}

/** Decode an ENTITY_GET_RESP (`0x01B1`) payload. */
export function decodeEntityGetResponse(bytes: Uint8Array): EntityGetResponse {
  const m = asMap(fromCbor(bytes));
  return { entity: decodeEntityView(field(m, "entity")) };
}

/** ENTITY_LIST (`0x0137`): page through entities with a type filter and a cursor. */
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
  /** Effective identity this list runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the connection's
   * own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode an ENTITY_LIST (`0x0137`) request. */
export function encodeEntityList(p: EntityListRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["entity_type_id", p.entityTypeId],
        ["name_prefix", p.namePrefix],
        ["mention_count_min", p.mentionCountMin],
        ["include_tombstoned", p.includeTombstoned],
        ["include_merged", p.includeMerged],
        ["limit", p.limit],
        ["cursor", Array.from(p.cursor)],
      ],
      p.actAs,
    ),
  );
}

/** Decode an ENTITY_LIST (`0x0137`) request payload. */
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
    actAs: decodeOptActAs(m),
  };
}

/** One entry in an ENTITY_LIST page: the entity id and its canonical name. */
export interface EntityListItem {
  entity: EntityView;
}

/** ENTITY_LIST_RESP (`0x01B7`), one streamed frame: a page of entities plus the next cursor and running count. */
export interface EntityListResponseFrame {
  items: EntityListItem[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

/** Encode one ENTITY_LIST_RESP (`0x01B7`) streamed frame. */
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

/** Decode one ENTITY_LIST_RESP (`0x01B7`) streamed frame. */
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

/** ENTITY_RESOLVE (`0x0136`): map a candidate name to an entity, optionally minting one on a miss. */
export interface EntityResolveRequest {
  candidateName: string;
  context: string;
  /** `0` = no hint; otherwise an entity type id. */
  entityTypeHint: number;
  allowCreate: boolean;
  requestId: WireUuid;
  /** Effective identity this resolve runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the
   * connection's own key-bound identity. Resolution is scoped to the
   * effective `(namespace, agent)`. */
  actAs: ActAs | null;
}

/** Encode an ENTITY_RESOLVE (`0x0136`) request. */
export function encodeEntityResolve(p: EntityResolveRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["candidate_name", p.candidateName],
        ["context", p.context],
        ["entity_type_hint", p.entityTypeHint],
        ["allow_create", p.allowCreate],
        ["request_id", p.requestId],
      ],
      p.actAs,
    ),
  );
}

/** Decode an ENTITY_RESOLVE (`0x0136`) request payload. */
export function decodeEntityResolve(bytes: Uint8Array): EntityResolveRequest {
  const m = asMap(fromCbor(bytes));
  return {
    candidateName: asStr(field(m, "candidate_name")),
    context: asStr(field(m, "context")),
    entityTypeHint: asNum(field(m, "entity_type_hint")),
    allowCreate: asBool(field(m, "allow_create")),
    requestId: asBytes(field(m, "request_id")),
    actAs: decodeOptActAs(m),
  };
}

/** ENTITY_RESOLVE_RESP (`0x01B6`): the resolved (or created) entity id and the resolution outcome. */
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

/** Encode an ENTITY_RESOLVE_RESP (`0x01B6`) payload. */
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

/** Decode an ENTITY_RESOLVE_RESP (`0x01B6`) payload. */
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

/** A full statement row as returned by reads: kind, subject/predicate/object, evidence, confidence, bi-temporal window, and chain/tombstone state. */
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
    ["kind", encodeStatementKind(s.kind)],
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
    kind: decodeStatementKind(field(m, "kind")),
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

/** STATEMENT_GET (`0x0141`): fetch one statement by id, optionally following supersession to the chain head. */
export interface StatementGetRequest {
  statementId: WireUuid;
  followSupersession: boolean;
  /** Effective identity this get runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the connection's
   * own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a STATEMENT_GET (`0x0141`) request. */
export function encodeStatementGet(p: StatementGetRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["statement_id", p.statementId],
        ["follow_supersession", p.followSupersession],
      ],
      p.actAs,
    ),
  );
}

/** Decode a STATEMENT_GET (`0x0141`) request payload. */
export function decodeStatementGet(bytes: Uint8Array): StatementGetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    statementId: asBytes(field(m, "statement_id")),
    followSupersession: asBool(field(m, "follow_supersession")),
    actAs: decodeOptActAs(m),
  };
}

/** STATEMENT_GET_RESP (`0x01C1`): the statement view and whether it was reached via supersession. */
export interface StatementGetResponse {
  statement: StatementView;
  returnedViaSupersession: boolean;
}

/** Encode a STATEMENT_GET_RESP (`0x01C1`) payload. */
export function encodeStatementGetResponse(p: StatementGetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement", encodeStatementView(p.statement)],
      ["returned_via_supersession", p.returnedViaSupersession],
    ]),
  );
}

/** Decode a STATEMENT_GET_RESP (`0x01C1`) payload. */
export function decodeStatementGetResponse(bytes: Uint8Array): StatementGetResponse {
  const m = asMap(fromCbor(bytes));
  return {
    statement: decodeStatementView(field(m, "statement")),
    returnedViaSupersession: asBool(field(m, "returned_via_supersession")),
  };
}

/** STATEMENT_LIST (`0x0146`): page through statements by subject/predicate filters with a cursor. */
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
  /** Effective identity this list runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the connection's
   * own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a STATEMENT_LIST (`0x0146`) request. */
export function encodeStatementList(p: StatementListRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
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
      ],
      p.actAs,
    ),
  );
}

/** Decode a STATEMENT_LIST (`0x0146`) request payload. */
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
    actAs: decodeOptActAs(m),
  };
}

/** STATEMENT_LIST_RESP (`0x01C6`), one streamed frame: a page of statements plus the next cursor and running count. */
export interface StatementListResponseFrame {
  items: StatementView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

/** Encode one STATEMENT_LIST_RESP (`0x01C6`) streamed frame. */
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

/** Decode one STATEMENT_LIST_RESP (`0x01C6`) streamed frame. */
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

/** A full relation row as returned by reads: type, endpoints, properties, evidence, confidence, bi-temporal window, and chain/tombstone state. */
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

/** RELATION_LIST_FROM (`0x0154`): page through relations originating at an entity, with type/time filters and a cursor. */
export interface RelationListFromRequest {
  fromEntity: WireUuid;
  relationTypeFilter: string;
  timeRangeStartUnixNanos: bigint;
  timeRangeEndUnixNanos: bigint;
  includeSuperseded: boolean;
  includeTombstoned: boolean;
  limit: number;
  cursor: Uint8Array;
  /** Effective identity this list runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a RELATION_LIST_FROM (`0x0154`) request. */
export function encodeRelationListFrom(p: RelationListFromRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["from_entity", p.fromEntity],
        ["relation_type_filter", p.relationTypeFilter],
        ["time_range_start_unix_nanos", p.timeRangeStartUnixNanos],
        ["time_range_end_unix_nanos", p.timeRangeEndUnixNanos],
        ["include_superseded", p.includeSuperseded],
        ["include_tombstoned", p.includeTombstoned],
        ["limit", p.limit],
        ["cursor", Array.from(p.cursor)],
      ],
      p.actAs,
    ),
  );
}

/** Decode a RELATION_LIST_FROM (`0x0154`) request payload. */
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
    actAs: decodeOptActAs(m),
  };
}

/** RELATION_LIST_FROM_RESP (`0x01D4`), one streamed frame: a page of outgoing relations plus the next cursor and running count. */
export interface RelationListFromResponseFrame {
  items: RelationView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

/** Encode one RELATION_LIST_FROM_RESP (`0x01D4`) streamed frame. */
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

/** Decode one RELATION_LIST_FROM_RESP (`0x01D4`) streamed frame. */
export function decodeRelationListFromResponse(bytes: Uint8Array): RelationListFromResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeRelationView),
    nextCursor: Uint8Array.from(asArray(field(m, "next_cursor")).map(asNum)),
    cumulativeCount: asNum(field(m, "cumulative_count")),
    isFinal: asBool(field(m, "is_final")),
  };
}

/** RELATION_LIST_TO (`0x0155`): page through relations pointing at an entity, with type/time filters and a cursor. */
export interface RelationListToRequest {
  toEntity: WireUuid;
  relationTypeFilter: string;
  timeRangeStartUnixNanos: bigint;
  timeRangeEndUnixNanos: bigint;
  includeSuperseded: boolean;
  includeTombstoned: boolean;
  limit: number;
  cursor: Uint8Array;
  /** Effective identity this list runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a RELATION_LIST_TO (`0x0155`) request. */
export function encodeRelationListTo(p: RelationListToRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["to_entity", p.toEntity],
        ["relation_type_filter", p.relationTypeFilter],
        ["time_range_start_unix_nanos", p.timeRangeStartUnixNanos],
        ["time_range_end_unix_nanos", p.timeRangeEndUnixNanos],
        ["include_superseded", p.includeSuperseded],
        ["include_tombstoned", p.includeTombstoned],
        ["limit", p.limit],
        ["cursor", Array.from(p.cursor)],
      ],
      p.actAs,
    ),
  );
}

/** Decode a RELATION_LIST_TO (`0x0155`) request payload. */
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
    actAs: decodeOptActAs(m),
  };
}

/** RELATION_LIST_TO_RESP (`0x01D5`), one streamed frame: a page of incoming relations plus the next cursor and running count. */
export interface RelationListToResponseFrame {
  items: RelationView[];
  nextCursor: Uint8Array;
  cumulativeCount: number;
  isFinal: boolean;
}

/** Encode one RELATION_LIST_TO_RESP (`0x01D5`) streamed frame. */
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

/** Decode one RELATION_LIST_TO_RESP (`0x01D5`) streamed frame. */
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
// Relation lifecycle + traversal — fetch one (get), revise (supersede), retire
// (tombstone), or walk the graph from an entity (traverse).
// ---------------------------------------------------------------------------

/** RELATION_GET (`0x0151`) request. `followSupersession` returns the current
 * head of a superseded relation's chain rather than the retired id asked for. */
export interface RelationGetRequest {
  relationId: WireUuid;
  followSupersession: boolean;
  /** Effective identity this get runs as. `null` (CBOR-omitted) runs as the
   * connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a RELATION_GET (`0x0151`) request. */
export function encodeRelationGet(p: RelationGetRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["relation_id", p.relationId],
        ["follow_supersession", p.followSupersession],
      ],
      p.actAs,
    ),
  );
}

/** Decode a RELATION_GET (`0x0151`) request payload. */
export function decodeRelationGet(bytes: Uint8Array): RelationGetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    relationId: asBytes(field(m, "relation_id")),
    followSupersession: asBool(field(m, "follow_supersession")),
    actAs: decodeOptActAs(m),
  };
}

/** RELATION_GET_RESP (`0x01D1`). `returnedViaSupersession` flags that the view
 * is the chain head, not the exact id requested. */
export interface RelationGetResponse {
  relation: RelationView;
  returnedViaSupersession: boolean;
}

/** Encode a RELATION_GET_RESP (`0x01D1`) payload. */
export function encodeRelationGetResponse(p: RelationGetResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["relation", encodeRelationView(p.relation)],
      ["returned_via_supersession", p.returnedViaSupersession],
    ]),
  );
}

/** Decode a RELATION_GET_RESP (`0x01D1`) payload. */
export function decodeRelationGetResponse(bytes: Uint8Array): RelationGetResponse {
  const m = asMap(fromCbor(bytes));
  return {
    relation: decodeRelationView(field(m, "relation")),
    returnedViaSupersession: asBool(field(m, "returned_via_supersession")),
  };
}

/** RELATION_SUPERSEDE (`0x0152`) request. Revise a relation, keeping the old
 * and the `newRelation` on one chain so history is preserved. */
export interface RelationSupersedeRequest {
  oldRelationId: WireUuid;
  newRelation: RelationCreateRequest;
  requestId: WireUuid;
}

/** Encode a RELATION_SUPERSEDE (`0x0152`) request. */
export function encodeRelationSupersede(p: RelationSupersedeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["old_relation_id", p.oldRelationId],
      // Nest the relation map directly — no re-encode round-trip.
      ["new_relation", relationCreateMap(p.newRelation)],
      ["request_id", p.requestId],
    ]),
  );
}

/** Decode a RELATION_SUPERSEDE (`0x0152`) request payload. */
export function decodeRelationSupersede(bytes: Uint8Array): RelationSupersedeRequest {
  const m = asMap(fromCbor(bytes));
  return {
    oldRelationId: asBytes(field(m, "old_relation_id")),
    newRelation: relationCreateFromMap(asMap(field(m, "new_relation"))),
    requestId: asBytes(field(m, "request_id")),
  };
}

/** RELATION_SUPERSEDE_RESP (`0x01D2`). The new relation's id and monotonic
 * chain version. */
export interface RelationSupersedeResponse {
  newRelationId: WireUuid;
  version: number;
}

/** Encode a RELATION_SUPERSEDE_RESP (`0x01D2`) payload. */
export function encodeRelationSupersedeResponse(p: RelationSupersedeResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["new_relation_id", p.newRelationId],
      ["version", p.version],
    ]),
  );
}

/** Decode a RELATION_SUPERSEDE_RESP (`0x01D2`) payload. */
export function decodeRelationSupersedeResponse(bytes: Uint8Array): RelationSupersedeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    newRelationId: asBytes(field(m, "new_relation_id")),
    version: asNum(field(m, "version")),
  };
}

/** RELATION_TOMBSTONE (`0x0153`) request. Soft-retire a relation with an audit
 * `reason`; the row survives but drops out of traversal. */
export interface RelationTombstoneRequest {
  relationId: WireUuid;
  reason: string;
  requestId: WireUuid;
}

/** Encode a RELATION_TOMBSTONE (`0x0153`) request. */
export function encodeRelationTombstone(p: RelationTombstoneRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["relation_id", p.relationId],
      ["reason", p.reason],
      ["request_id", p.requestId],
    ]),
  );
}

/** Decode a RELATION_TOMBSTONE (`0x0153`) request payload. */
export function decodeRelationTombstone(bytes: Uint8Array): RelationTombstoneRequest {
  const m = asMap(fromCbor(bytes));
  return {
    relationId: asBytes(field(m, "relation_id")),
    reason: asStr(field(m, "reason")),
    requestId: asBytes(field(m, "request_id")),
  };
}

/** RELATION_TOMBSTONE_RESP (`0x01D3`). The record time the retirement landed. */
export interface RelationTombstoneResponse {
  tombstonedAtUnixNanos: bigint;
}

/** Encode a RELATION_TOMBSTONE_RESP (`0x01D3`) payload. */
export function encodeRelationTombstoneResponse(p: RelationTombstoneResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([["tombstoned_at_unix_nanos", p.tombstonedAtUnixNanos]]),
  );
}

/** Decode a RELATION_TOMBSTONE_RESP (`0x01D3`) payload. */
export function decodeRelationTombstoneResponse(bytes: Uint8Array): RelationTombstoneResponse {
  const m = asMap(fromCbor(bytes));
  return { tombstonedAtUnixNanos: asBig(field(m, "tombstoned_at_unix_nanos")) };
}

/** One hop in a traversal path: the relation edge crossed, its endpoints, the
 * relation type, and the hop depth from the start entity. */
export interface TraversalStepWire {
  relationId: WireUuid;
  from: WireUuid;
  to: WireUuid;
  relationType: string;
  depth: number;
}

/** Encode one {@link TraversalStepWire} into its CBOR map. */
function encodeTraversalStep(s: TraversalStepWire): Map<string, unknown> {
  return new Map<string, unknown>([
    ["relation_id", s.relationId],
    ["from", s.from],
    ["to", s.to],
    ["relation_type", s.relationType],
    ["depth", s.depth],
  ]);
}

/** Decode one {@link TraversalStepWire} from a CBOR map. */
function decodeTraversalStep(value: unknown): TraversalStepWire {
  const m = asMap(value);
  return {
    relationId: asBytes(field(m, "relation_id")),
    from: asBytes(field(m, "from")),
    to: asBytes(field(m, "to")),
    relationType: asStr(field(m, "relation_type")),
    depth: asNum(field(m, "depth")),
  };
}

/** One path the traversal found, as an ordered list of steps. */
export interface TraversalPathWire {
  steps: TraversalStepWire[];
}

/** Encode one {@link TraversalPathWire} into its CBOR map. */
function encodeTraversalPath(p: TraversalPathWire): Map<string, unknown> {
  return new Map<string, unknown>([["steps", p.steps.map(encodeTraversalStep)]]);
}

/** Decode one {@link TraversalPathWire} from a CBOR map. */
function decodeTraversalPath(value: unknown): TraversalPathWire {
  const m = asMap(value);
  return { steps: asArray(field(m, "steps")).map(decodeTraversalStep) };
}

/** RELATION_TRAVERSE (`0x0156`) request. Multi-hop walk of the relation graph
 * from `startEntity`; `direction` is outgoing/incoming/both, the bounds cap the
 * search, and `timeAtUnixNanos` walks the graph as it stood at a record time. */
export interface RelationTraverseRequest {
  startEntity: WireUuid;
  relationTypes: string[];
  direction: number;
  maxDepth: number;
  maxNodes: number;
  timeAtUnixNanos: bigint;
  includeSuperseded: boolean;
  requestId: WireUuid;
  /** Effective identity this traversal runs as, on behalf of the connection
   * principal. `null` (the common case, CBOR-omitted) runs as the connection's
   * own key-bound identity. The walk is scoped to the effective
   * `(namespace, agent)`. */
  actAs: ActAs | null;
}

/** Encode a RELATION_TRAVERSE (`0x0156`) request. */
export function encodeRelationTraverse(p: RelationTraverseRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["start_entity", p.startEntity],
        ["relation_types", p.relationTypes],
        ["direction", p.direction],
        ["max_depth", p.maxDepth],
        ["max_nodes", p.maxNodes],
        ["time_at_unix_nanos", p.timeAtUnixNanos],
        ["include_superseded", p.includeSuperseded],
        ["request_id", p.requestId],
      ],
      p.actAs,
    ),
  );
}

/** Decode a RELATION_TRAVERSE (`0x0156`) request payload. */
export function decodeRelationTraverse(bytes: Uint8Array): RelationTraverseRequest {
  const m = asMap(fromCbor(bytes));
  return {
    startEntity: asBytes(field(m, "start_entity")),
    relationTypes: asArray(field(m, "relation_types")).map(asStr),
    direction: asNum(field(m, "direction")),
    maxDepth: asNum(field(m, "max_depth")),
    maxNodes: asNum(field(m, "max_nodes")),
    timeAtUnixNanos: asBig(field(m, "time_at_unix_nanos")),
    includeSuperseded: asBool(field(m, "include_superseded")),
    requestId: asBytes(field(m, "request_id")),
    actAs: decodeOptActAs(m),
  };
}

/** RELATION_TRAVERSE_RESP (`0x01D6`), one streamed frame. `isFinal` marks the
 * last; `truncated` flags a bound was hit before the graph was exhausted. */
export interface RelationTraverseResponseFrame {
  paths: TraversalPathWire[];
  totalPaths: number;
  truncated: boolean;
  isFinal: boolean;
}

/** Encode one RELATION_TRAVERSE_RESP (`0x01D6`) streamed frame. */
export function encodeRelationTraverseResponse(p: RelationTraverseResponseFrame): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["paths", p.paths.map(encodeTraversalPath)],
      ["total_paths", p.totalPaths],
      ["truncated", p.truncated],
      ["is_final", p.isFinal],
    ]),
  );
}

/** Decode one RELATION_TRAVERSE_RESP (`0x01D6`) streamed frame. */
export function decodeRelationTraverseResponse(bytes: Uint8Array): RelationTraverseResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    paths: asArray(field(m, "paths")).map(decodeTraversalPath),
    totalPaths: asNum(field(m, "total_paths")),
    truncated: asBool(field(m, "truncated")),
    isFinal: asBool(field(m, "is_final")),
  };
}

// ---------------------------------------------------------------------------
// Query introspection — the plan (explain) and execution trace debug surface.
// ---------------------------------------------------------------------------

/** QUERY_EXPLAIN (`0x0161`) request. Ask for the plan of a `query` without
 * running it. */
export interface QueryExplainRequest {
  query: QueryRequest;
}

/** Encode a QUERY_EXPLAIN (`0x0161`) request. */
export function encodeQueryExplain(p: QueryExplainRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["query", queryMap(p.query)]]));
}

/** Decode a QUERY_EXPLAIN (`0x0161`) request payload. */
export function decodeQueryExplain(bytes: Uint8Array): QueryExplainRequest {
  const m = asMap(fromCbor(bytes));
  return { query: queryFromMap(asMap(field(m, "query"))) };
}

/** QUERY_EXPLAIN_RESP (`0x01E1`). The human-readable plan plus an estimated
 * cost in milliseconds. */
export interface QueryExplainResponse {
  planText: string;
  estimatedCostMs: number;
}

/** Encode a QUERY_EXPLAIN_RESP (`0x01E1`) payload. */
export function encodeQueryExplainResponse(p: QueryExplainResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["plan_text", p.planText],
      ["estimated_cost_ms", f32(p.estimatedCostMs)],
    ]),
  );
}

/** Decode a QUERY_EXPLAIN_RESP (`0x01E1`) payload. */
export function decodeQueryExplainResponse(bytes: Uint8Array): QueryExplainResponse {
  const m = asMap(fromCbor(bytes));
  return {
    planText: asStr(field(m, "plan_text")),
    estimatedCostMs: asNum(field(m, "estimated_cost_ms")),
  };
}

/** QUERY_TRACE (`0x0162`) request. Run a `query` and return its per-stage
 * execution trace. */
export interface QueryTraceRequest {
  query: QueryRequest;
}

/** Encode a QUERY_TRACE (`0x0162`) request. */
export function encodeQueryTrace(p: QueryTraceRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["query", queryMap(p.query)]]));
}

/** Decode a QUERY_TRACE (`0x0162`) request payload. */
export function decodeQueryTrace(bytes: Uint8Array): QueryTraceRequest {
  const m = asMap(fromCbor(bytes));
  return { query: queryFromMap(asMap(field(m, "query"))) };
}

/** QUERY_TRACE_RESP (`0x01E2`). The human-readable trace plus total latency in
 * milliseconds. */
export interface QueryTraceResponse {
  traceText: string;
  totalLatencyMs: number;
}

/** Encode a QUERY_TRACE_RESP (`0x01E2`) payload. */
export function encodeQueryTraceResponse(p: QueryTraceResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["trace_text", p.traceText],
      ["total_latency_ms", f64(p.totalLatencyMs)],
    ]),
  );
}

/** Decode a QUERY_TRACE_RESP (`0x01E2`) payload. */
export function decodeQueryTraceResponse(bytes: Uint8Array): QueryTraceResponse {
  const m = asMap(fromCbor(bytes));
  return {
    traceText: asStr(field(m, "trace_text")),
    totalLatencyMs: asNum(field(m, "total_latency_ms")),
  };
}

// ---------------------------------------------------------------------------
// SCHEMA_GET / SCHEMA_LIST / SCHEMA_VALIDATE.
// ---------------------------------------------------------------------------

/** SCHEMA_GET (`0x0121`): fetch one schema version in a namespace (`version` 0 = active). */
export interface SchemaGetRequest {
  namespace: string;
  /** `0` = active version. */
  version: number;
}

/** Encode a SCHEMA_GET (`0x0121`) request. */
export function encodeSchemaGet(p: SchemaGetRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["version", p.version],
    ]),
  );
}

/** Decode a SCHEMA_GET (`0x0121`) request payload. */
export function decodeSchemaGet(bytes: Uint8Array): SchemaGetRequest {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    version: asNum(field(m, "version")),
  };
}

/** SCHEMA_GET_RESP (`0x01A1`): the schema document and its version metadata. */
export interface SchemaGetResponse {
  namespace: string;
  schemaVersion: number;
  schemaDocument: string;
  sourceBlob: Uint8Array;
  uploadedAtUnixNanos: bigint;
  validatorVersion: number;
}

/** Encode a SCHEMA_GET_RESP (`0x01A1`) payload. */
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

/** Decode a SCHEMA_GET_RESP (`0x01A1`) payload. */
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

/** SCHEMA_LIST (`0x0122`): enumerate the schema versions declared in a namespace. */
export interface SchemaListRequest {
  namespace: string;
  /** `0` = unlimited (server-capped). */
  limit: number;
  cursor: Uint8Array;
}

/** Encode a SCHEMA_LIST (`0x0122`) request. */
export function encodeSchemaList(p: SchemaListRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["namespace", p.namespace],
      ["limit", p.limit],
      ["cursor", Array.from(p.cursor)],
    ]),
  );
}

/** Decode a SCHEMA_LIST (`0x0122`) request payload. */
export function decodeSchemaList(bytes: Uint8Array): SchemaListRequest {
  const m = asMap(fromCbor(bytes));
  return {
    namespace: asStr(field(m, "namespace")),
    limit: asNum(field(m, "limit")),
    cursor: Uint8Array.from(asArray(field(m, "cursor")).map(asNum)),
  };
}

/** One entry in a SCHEMA_LIST page: a namespace version with its metadata (version, active flag, timestamps). */
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

/** SCHEMA_LIST_RESP (`0x01A2`), one streamed frame: a page of schema-version entries. */
export interface SchemaListResponseFrame {
  namespace: string;
  items: SchemaListItemWire[];
  total: number;
  nextCursor: Uint8Array;
  isFinal: boolean;
}

/** Encode one SCHEMA_LIST_RESP (`0x01A2`) streamed frame. */
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

/** Decode one SCHEMA_LIST_RESP (`0x01A2`) streamed frame. */
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

/** SCHEMA_VALIDATE (`0x0123`): check a schema document for errors without persisting it. */
export interface SchemaValidateRequest {
  schemaDocument: string;
}

/** Encode a SCHEMA_VALIDATE (`0x0123`) request. */
export function encodeSchemaValidate(p: SchemaValidateRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["schema_document", p.schemaDocument]]));
}

/** Decode a SCHEMA_VALIDATE (`0x0123`) request payload. */
export function decodeSchemaValidate(bytes: Uint8Array): SchemaValidateRequest {
  const m = asMap(fromCbor(bytes));
  return { schemaDocument: asStr(field(m, "schema_document")) };
}

/** SCHEMA_VALIDATE_RESP (`0x01A3`): whether the document is valid and any diagnostics. */
export interface SchemaValidateResponse {
  namespace: string;
  /** `current_active + 1` if validation passed; `0` otherwise. */
  wouldBeVersion: number;
  validationErrors: SchemaValidationErrorWire[];
}

/** Encode a SCHEMA_VALIDATE_RESP (`0x01A3`) payload. */
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

/** Decode a SCHEMA_VALIDATE_RESP (`0x01A3`) payload. */
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

/** Discriminant for a SUBSCRIBE_EVENT: which change the server is pushing (encode, forget, entity/statement/relation lifecycle, edge, stage, schema). */
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

/** Outcome of a completed write-pipeline stage carried on a StageCompleted event (ok, empty, failed). */
export enum StageOutcome {
  Ok = 0,
  Empty = 1,
  Failed = 2,
}

/** How far an extractor stage's audited writes were applied (succeeded, partial, failed, skipped). */
export enum StageAuditStatus {
  Succeeded = 0,
  PartiallyApplied = 1,
  Failed = 2,
  Skipped = 3,
}

/** StageCompleted detail for the auto-edge stage: how many edges it wrote. */
export interface StageAutoEdgePayload {
  edgesWritten: number;
}

/** StageCompleted detail for the temporal-edge stage: how many edges it wrote. */
export interface StageTemporalEdgePayload {
  edgesWritten: number;
}

/** StageCompleted detail for the extractor stage: entity/statement/relation counts, audit status, and any error. */
export interface StageExtractorPayload {
  entityCount: number;
  statementCount: number;
  relationCount: number;
  auditStatus: StageAuditStatus;
  errorMessage: string;
}

/** StageCompleted detail for the HyPE stage: how many hypothetical questions were embedded/persisted/indexed, and LLM spend (0 on a cache hit). */
export interface StageHypePayload {
  questionsWritten: number;
  costMicroUsd: bigint;
}

/** Per-stage detail sidecar on StageCompleted events. Externally tagged. */
export type StagePayload =
  | { kind: "AutoEdge"; value: StageAutoEdgePayload }
  | { kind: "TemporalEdge"; value: StageTemporalEdgePayload }
  | { kind: "Extractor"; value: StageExtractorPayload }
  | { kind: "Hype"; value: StageHypePayload };

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
    case "Hype":
      return new Map<string, unknown>([
        [
          "Hype",
          new Map<string, unknown>([
            ["questions_written", s.value.questionsWritten],
            ["cost_micro_usd", s.value.costMicroUsd],
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
  if (m.has("Hype")) {
    const inner = asMap(m.get("Hype"));
    return {
      kind: "Hype",
      value: {
        questionsWritten: asNum(field(inner, "questions_written")),
        costMicroUsd: asBig(field(inner, "cost_micro_usd")),
      },
    };
  }
  throw new CborError("unknown StagePayload variant");
}

/** A subscribe filter clause matching events for memories similar to a reference above a threshold. */
export interface SimilarityFilter {
  referenceMemoryId: bigint;
  threshold: number;
}

/** The predicate a SUBSCRIBE applies to the change feed: context, kind, similarity, agent, and memory-id scoping. */
export interface SubscriptionFilter {
  contexts: bigint[] | null;
  kinds: MemoryKindWire[] | null;
  similarTo: SimilarityFilter | null;
  agents: WireUuid[] | null;
  /** Subset of memory ids whose events the subscriber wants. `null` or empty = all memories. Scopes a subscription to a single in-flight write (e.g. to watch its async derivation stages complete). */
  memoryIds: bigint[] | null;
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
    ["memory_ids", f.memoryIds === null ? null : f.memoryIds],
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
    memoryIds: asOpt(field(m, "memory_ids"), (v) => asArray(v).map(asBig)),
  };
}

/** SUBSCRIBE (`0x0030`): open a change-feed subscription with a filter, optional history replay, and an in-flight cap. */
export interface SubscribeRequest {
  filter: SubscriptionFilter;
  includeHistory: boolean;
  fromLsn: bigint | null;
  maxInflight: number;
  /** Effective identity this subscription runs as. `null` (CBOR-omitted) runs as
   * the connection's own key-bound identity. */
  actAs: ActAs | null;
}

/** Encode a SUBSCRIBE (`0x0030`) request. */
export function encodeSubscribe(p: SubscribeRequest): Uint8Array {
  return toCbor(
    requestMapWithActAs(
      [
        ["filter", encodeSubscriptionFilter(p.filter)],
        ["include_history", p.includeHistory],
        ["from_lsn", p.fromLsn],
        ["max_inflight", p.maxInflight],
      ],
      p.actAs,
    ),
  );
}

/** Decode a SUBSCRIBE (`0x0030`) request payload. */
export function decodeSubscribe(bytes: Uint8Array): SubscribeRequest {
  const m = asMap(fromCbor(bytes));
  return {
    filter: decodeSubscriptionFilter(field(m, "filter")),
    includeHistory: asBool(field(m, "include_history")),
    fromLsn: asOpt(field(m, "from_lsn"), asBig),
    maxInflight: asNum(field(m, "max_inflight")),
    actAs: decodeOptActAs(m),
  };
}

/** The edge-change detail carried on an EdgeAdded / EdgeRemoved / EdgeSuperseded subscription event. */
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

/** SUBSCRIBE_EVENT detail: an entity was created. */
export interface EntityCreatedEvent {
  entityId: WireUuid;
  entityTypeId: number;
  canonicalName: string;
}

/** SUBSCRIBE_EVENT detail: an entity's name/aliases/attributes were replaced. */
export interface EntityUpdatedEvent {
  entityId: WireUuid;
  entityTypeId: number;
  canonicalName: string;
  embeddingVersionChanged: boolean;
}

/** SUBSCRIBE_EVENT detail: an entity was renamed. */
export interface EntityRenamedEvent {
  entityId: WireUuid;
  oldCanonicalName: string;
  newCanonicalName: string;
  oldMovedToAlias: boolean;
}

/** SUBSCRIBE_EVENT detail: one entity was merged into another. */
export interface EntityMergedEvent {
  survivor: WireUuid;
  merged: WireUuid;
  auditId: WireUuid;
  confidence: number;
  statementsRerouted: number;
  relationsRerouted: number;
}

/** SUBSCRIBE_EVENT detail: a prior merge was undone. */
export interface EntityUnmergedEvent {
  restoredEntityId: WireUuid;
  fromSurvivor: WireUuid;
  auditId: WireUuid;
}

/** SUBSCRIBE_EVENT detail: an entity was soft-retired. */
export interface EntityTombstonedEvent {
  entityId: WireUuid;
  reason: string;
}

/** SUBSCRIBE_EVENT detail: a statement was created. */
export interface StatementCreatedEvent {
  statementId: WireUuid;
  /** `1`=Fact, `2`=Preference, `3`=Event. */
  kind: number;
  subject: WireUuid;
  predicate: string;
  confidence: number;
}

/** SUBSCRIBE_EVENT detail: a statement was superseded by a revision. */
export interface StatementSupersededEvent {
  oldStatementId: WireUuid;
  newStatementId: WireUuid;
  chainRoot: WireUuid;
}

/** SUBSCRIBE_EVENT detail: a statement was soft-retired. */
export interface StatementTombstonedEvent {
  statementId: WireUuid;
  reason: string;
}

/** SUBSCRIBE_EVENT detail: a relation was created. */
export interface RelationCreatedEvent {
  relationId: WireUuid;
  relationType: string;
  from: WireUuid;
  to: WireUuid;
}

/** SUBSCRIBE_EVENT detail: a relation was superseded by a revision. */
export interface RelationSupersededEvent {
  oldRelationId: WireUuid;
  newRelationId: WireUuid;
}

/** SUBSCRIBE_EVENT detail: a relation was soft-retired. */
export interface RelationTombstonedEvent {
  relationId: WireUuid;
  reason: string;
}

/** SUBSCRIBE_EVENT detail: a namespace's schema was updated. */
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

/** SUBSCRIBE_EVENT (`0x00B0`): the decoded change pushed on a subscription, tagged by event type with its variant payload. */
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

/** Encode a SUBSCRIBE_EVENT (`0x00B0`) frame. */
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

/** Decode a SUBSCRIBE_EVENT (`0x00B0`) frame payload. */
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

/** UNSUBSCRIBE (`0x0031`): tear down a subscription by its stream id. */
export interface UnsubscribeRequest {
  targetStreamId: number;
}

/** Encode an UNSUBSCRIBE (`0x0031`) request. */
export function encodeUnsubscribe(p: UnsubscribeRequest): Uint8Array {
  return toCbor(new Map<string, unknown>([["target_stream_id", p.targetStreamId]]));
}

/** Decode an UNSUBSCRIBE (`0x0031`) request payload. */
export function decodeUnsubscribe(bytes: Uint8Array): UnsubscribeRequest {
  const m = asMap(fromCbor(bytes));
  return { targetStreamId: asNum(field(m, "target_stream_id")) };
}

/** UNSUBSCRIBE_RESP (`0x00B1`): the torn-down stream id and the final LSN delivered. */
export interface UnsubscribeResponse {
  targetStreamId: number;
  finalLsn: bigint;
}

/** Encode an UNSUBSCRIBE_RESP (`0x00B1`) payload. */
export function encodeUnsubscribeResponse(p: UnsubscribeResponse): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["target_stream_id", p.targetStreamId],
      ["final_lsn", p.finalLsn],
    ]),
  );
}

/** Decode an UNSUBSCRIBE_RESP (`0x00B1`) payload. */
export function decodeUnsubscribeResponse(bytes: Uint8Array): UnsubscribeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    targetStreamId: asNum(field(m, "target_stream_id")),
    finalLsn: asBig(field(m, "final_lsn")),
  };
}

// ---------------------------------------------------------------------------
// Entity mutation — an entity accretes detail (update/rename), consolidates
// duplicates (merge/unmerge), and retires (tombstone) over its lifetime.
// ---------------------------------------------------------------------------

/** ENTITY_UPDATE (`0x0132`). Replace name, aliases, and attributes. */
export interface EntityUpdateRequest {
  entityId: WireUuid;
  canonicalName: string;
  aliases: string[];
  attributesBlob: Uint8Array;
  requestId: WireUuid;
}

/** Encode an ENTITY_UPDATE (`0x0132`) request. */
export function encodeEntityUpdate(p: EntityUpdateRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["entity_id", p.entityId],
      ["canonical_name", p.canonicalName],
      ["aliases", p.aliases],
      ["attributes_blob", Array.from(p.attributesBlob)],
      ["request_id", p.requestId],
    ]),
  );
}

/** ENTITY_UPDATE_RESP (`0x01B2`) / ENTITY_RENAME_RESP (`0x01B3`). */
export interface EntityViewResponse {
  entity: EntityView;
}

/** Decode an ENTITY_UPDATE_RESP / ENTITY_RENAME_RESP entity-view payload. */
export function decodeEntityViewResponse(bytes: Uint8Array): EntityViewResponse {
  const m = asMap(fromCbor(bytes));
  return { entity: decodeEntityView(field(m, "entity")) };
}

/** ENTITY_RENAME (`0x0133`). `moveToAlias` keeps the old name reachable. */
export interface EntityRenameRequest {
  entityId: WireUuid;
  newCanonicalName: string;
  moveToAlias: boolean;
  requestId: WireUuid;
}

/** Encode an ENTITY_RENAME (`0x0133`) request. */
export function encodeEntityRename(p: EntityRenameRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["entity_id", p.entityId],
      ["new_canonical_name", p.newCanonicalName],
      ["move_to_alias", p.moveToAlias],
      ["request_id", p.requestId],
    ]),
  );
}

/** ENTITY_MERGE (`0x0134`). Fold `merged` into `survivor`; reversible. */
export interface EntityMergeRequest {
  survivor: WireUuid;
  merged: WireUuid;
  confidence: number;
  reason: string;
  requestId: WireUuid;
}

/** Encode an ENTITY_MERGE (`0x0134`) request. */
export function encodeEntityMerge(p: EntityMergeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["survivor", p.survivor],
      ["merged", p.merged],
      ["confidence", f32(p.confidence)],
      ["reason", p.reason],
      ["request_id", p.requestId],
    ]),
  );
}

/** ENTITY_MERGE_RESP (`0x01B4`). Merge-audit id + reversible window. */
export interface EntityMergeResponse {
  auditId: WireUuid;
  gracePeriodSeconds: bigint;
}

/** Decode an ENTITY_MERGE_RESP (`0x01B4`) payload. */
export function decodeEntityMergeResponse(bytes: Uint8Array): EntityMergeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    auditId: asBytes(field(m, "audit_id")),
    gracePeriodSeconds: asBig(field(m, "grace_period_seconds")),
  };
}

/** ENTITY_UNMERGE (`0x0135`). Undo a merge within its grace window. */
export interface EntityUnmergeRequest {
  mergedEntity: WireUuid;
  requestId: WireUuid;
}

/** Encode an ENTITY_UNMERGE (`0x0135`) request. */
export function encodeEntityUnmerge(p: EntityUnmergeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["merged_entity", p.mergedEntity],
      ["request_id", p.requestId],
    ]),
  );
}

/** ENTITY_UNMERGE_RESP (`0x01B5`). The restored entity's id. */
export interface EntityUnmergeResponse {
  restoredEntityId: WireUuid;
}

/** Decode an ENTITY_UNMERGE_RESP (`0x01B5`) payload. */
export function decodeEntityUnmergeResponse(bytes: Uint8Array): EntityUnmergeResponse {
  const m = asMap(fromCbor(bytes));
  return { restoredEntityId: asBytes(field(m, "restored_entity_id")) };
}

/** ENTITY_TOMBSTONE (`0x0138`). Soft-retire with an audit reason. */
export interface EntityTombstoneRequest {
  entityId: WireUuid;
  reason: string;
  requestId: WireUuid;
}

/** Encode an ENTITY_TOMBSTONE (`0x0138`) request. */
export function encodeEntityTombstone(p: EntityTombstoneRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["entity_id", p.entityId],
      ["reason", p.reason],
      ["request_id", p.requestId],
    ]),
  );
}

/** ENTITY_TOMBSTONE_RESP (`0x01B8`). When the retirement took effect. */
export interface EntityTombstoneResponse {
  tombstonedAtUnixNanos: bigint;
}

/** Decode an ENTITY_TOMBSTONE_RESP (`0x01B8`) payload. */
export function decodeEntityTombstoneResponse(bytes: Uint8Array): EntityTombstoneResponse {
  const m = asMap(fromCbor(bytes));
  return { tombstonedAtUnixNanos: asBig(field(m, "tombstoned_at_unix_nanos")) };
}

// ---------------------------------------------------------------------------
// Statement lifecycle — a claim is revised (supersede), walked back (retract),
// retired (tombstone), or inspected across versions (history).
// ---------------------------------------------------------------------------

/** STATEMENT_SUPERSEDE (`0x0142`). Revise a claim, keeping the chain. */
export interface StatementSupersedeRequest {
  oldStatementId: WireUuid;
  newStatement: StatementCreateRequest;
  requestId: WireUuid;
}

/** Encode a STATEMENT_SUPERSEDE (`0x0142`) request, nesting the replacement statement's map. */
export function encodeStatementSupersede(p: StatementSupersedeRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["old_statement_id", p.oldStatementId],
      // Nest the statement map directly — no re-encode round-trip.
      ["new_statement", statementCreateMap(p.newStatement)],
      ["request_id", p.requestId],
    ]),
  );
}

/** STATEMENT_SUPERSEDE_RESP (`0x01C2`). New id + chain root + version. */
export interface StatementSupersedeResponse {
  newStatementId: WireUuid;
  chainRoot: WireUuid;
  version: number;
}

/** Decode a STATEMENT_SUPERSEDE_RESP (`0x01C2`) payload. */
export function decodeStatementSupersedeResponse(bytes: Uint8Array): StatementSupersedeResponse {
  const m = asMap(fromCbor(bytes));
  return {
    newStatementId: asBytes(field(m, "new_statement_id")),
    chainRoot: asBytes(field(m, "chain_root")),
    version: asNum(field(m, "version")),
  };
}

/** STATEMENT_TOMBSTONE (`0x0143`) / STATEMENT_RETRACT (`0x0144`). `reason` is 1..=4. */
export interface StatementReasonRequest {
  statementId: WireUuid;
  reason: number;
  reasonMessage: string;
  requestId: WireUuid;
}

/** Encode a STATEMENT_TOMBSTONE (`0x0143`) / STATEMENT_RETRACT (`0x0144`) request (shared reason shape). */
export function encodeStatementReason(p: StatementReasonRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["statement_id", p.statementId],
      ["reason", p.reason],
      ["reason_message", p.reasonMessage],
      ["request_id", p.requestId],
    ]),
  );
}

/** STATEMENT_TOMBSTONE_RESP (`0x01C3`). */
export interface StatementTombstoneResponse {
  tombstonedAtUnixNanos: bigint;
}

/** Decode a STATEMENT_TOMBSTONE_RESP (`0x01C3`) payload. */
export function decodeStatementTombstoneResponse(bytes: Uint8Array): StatementTombstoneResponse {
  const m = asMap(fromCbor(bytes));
  return { tombstonedAtUnixNanos: asBig(field(m, "tombstoned_at_unix_nanos")) };
}

/** STATEMENT_RETRACT_RESP (`0x01C4`). Retracted-at + scheduled zero-at. */
export interface StatementRetractResponse {
  retractedAtUnixNanos: bigint;
  willZeroAtUnixNanos: bigint;
}

/** Decode a STATEMENT_RETRACT_RESP (`0x01C4`) payload. */
export function decodeStatementRetractResponse(bytes: Uint8Array): StatementRetractResponse {
  const m = asMap(fromCbor(bytes));
  return {
    retractedAtUnixNanos: asBig(field(m, "retracted_at_unix_nanos")),
    willZeroAtUnixNanos: asBig(field(m, "will_zero_at_unix_nanos")),
  };
}

/** STATEMENT_HISTORY (`0x0145`). A read — no `requestId`. */
export interface StatementHistoryRequest {
  anchorId: WireUuid;
  includeTombstoned: boolean;
}

/** Encode a STATEMENT_HISTORY (`0x0145`) request. */
export function encodeStatementHistory(p: StatementHistoryRequest): Uint8Array {
  return toCbor(
    new Map<string, unknown>([
      ["anchor_id", p.anchorId],
      ["include_tombstoned", p.includeTombstoned],
    ]),
  );
}

/** STATEMENT_HISTORY_RESP (`0x01C5`), one streamed frame. */
export interface StatementHistoryResponseFrame {
  items: StatementView[];
  chainRoot: WireUuid;
  totalVersions: number;
  isFinal: boolean;
}

/** Decode one STATEMENT_HISTORY_RESP (`0x01C5`) streamed frame. */
export function decodeStatementHistoryResponseFrame(bytes: Uint8Array): StatementHistoryResponseFrame {
  const m = asMap(fromCbor(bytes));
  return {
    items: asArray(field(m, "items")).map(decodeStatementView),
    chainRoot: asBytes(field(m, "chain_root")),
    totalVersions: asNum(field(m, "total_versions")),
    isFinal: asBool(field(m, "is_final")),
  };
}
