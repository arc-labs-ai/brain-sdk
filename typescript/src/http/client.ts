/**
 * {@link BrainHttpClient} — the HTTP tier of the Brain SDK.
 *
 * Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
 * gateway). Same verb surface and field names as the Rust and Python HTTP
 * clients. For the native wire protocol (streaming, transactions, typed-graph
 * management), use {@link BrainClient} instead.
 */
import { BrainHttpError } from "./errors.js";
import { describeThrown } from "../transport.js";
import type {
  Capabilities,
  CreateEntityInput,
  CreateEntityResult,
  EncodeInput,
  EncodeResult,
  EntityDetail,
  ForgetInput,
  ForgetResult,
  GetRelationQuery,
  GetStatementQuery,
  GraphFetchQuery,
  GraphPage,
  LinkInput,
  LinkResult,
  ListEntitiesQuery,
  ListEntitiesResult,
  ListRelationsQuery,
  ListRelationsResult,
  ListStatementsQuery,
  ListStatementsResult,
  MemoryInspect,
  MemoryListPage,
  MemoryListQuery,
  PlanInput,
  PlanResult,
  ReasonInput,
  ReasonResult,
  RecallInput,
  RecallResult,
  RelationDetail,
  ResolveEntityInput,
  ResolveEntityResult,
  Schema,
  SchemaGetQuery,
  SchemaReplaceInput,
  SchemaReplaceResult,
  SchemaUploadInput,
  SchemaUploadResult,
  SchemaValidateInput,
  SchemaValidateResult,
  StatementDetail,
  TraverseInput,
  TraverseResult,
  UnlinkInput,
  UnlinkResult,
  Permissions,
  Whoami,
} from "./types.js";

/**
 * Retry policy for the HTTP tier — applied only to idempotent verbs (`encode`,
 * `whoami`, `capabilities`). Transport/timeout errors (`status === 0`), HTTP
 * `503` and `429` (rate limited) are retried; every other status is
 * terminal. The backoff grows exponentially from `baseDelayMs` (100ms, 200ms,
 * …), capped at `maxDelayMs`; a server `Retry-After` hint overrides it.
 */
export interface HttpRetryPolicy {
  /** Total attempts including the first. `1` disables retry. */
  maxAttempts: number;
  /** First backoff; doubles each subsequent attempt (milliseconds). */
  baseDelayMs: number;
  /** Upper bound on any single backoff (also caps a server `Retry-After`). */
  maxDelayMs: number;
}

/** The default HTTP retry policy: 3 attempts, 100ms base backoff, 2s cap. */
export const DEFAULT_HTTP_RETRY: HttpRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
};

/** No retry: a single attempt. */
export const NO_HTTP_RETRY: HttpRetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

/** Options for {@link BrainHttpClient}. */
export interface BrainHttpClientOptions {
  /** The API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Base URL of the edge. Defaults to `http://127.0.0.1:8080` (self-host). */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Retry policy for idempotent verbs. Defaults to {@link DEFAULT_HTTP_RETRY}. */
  retry?: Partial<HttpRetryPolicy>;
  /** Override the `fetch` implementation (defaults to the global). */
  fetch?: typeof fetch;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * A query object — one of the `*Query` interfaces in `types.ts`: camelCase
 * keys, scalar values. Typed as `object` rather than `Record<string, …>`
 * because an interface has no implicit index signature and so is not
 * assignable to one; the values here are only ever stringified.
 */
type Query = object;

/** A {@link BrainHttpError} that may carry a parsed `Retry-After` hint (ms). */
type ErrorWithRetryAfter = BrainHttpError & { retryAfterMs?: number };

/** Parse a `Retry-After` header expressed as integer seconds, into ms. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const secs = Number.parseInt(header.trim(), 10);
  return Number.isFinite(secs) && String(secs) === header.trim() ? secs * 1000 : undefined;
}

/**
 * The edge speaks snake_case JSON; this SDK speaks camelCase, as its wire types
 * already do. Converting at the transport seam keeps one convention in the
 * public API instead of two — Rust and Python have no such split because
 * snake_case is idiomatic there, so their HTTP types match the wire by
 * coincidence rather than by a different rule.
 *
 * Generic rather than a hand-written mapping per field of every DTO across the
 * edge's 25 routes: every HTTP type here is a fixed-shape struct with plain
 * snake_case keys, so the transform is total and mechanical. There are no
 * free-form maps whose keys would be wrongly rewritten, and the tagged unions
 * carry their tag in a value, which the transform does not touch.
 */
function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function toSnakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[snakeCase(k)] = toSnakeKeys(v);
  }
  return out;
}

function toCamelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())] = toCamelKeys(v);
  }
  return out;
}

/**
 * Render a query object as a URL query string, snake_casing its names.
 *
 * The body seam above cannot do this: a query string is not JSON and never
 * passes through `JSON.stringify`. The edge deserializes query parameters with
 * serde under the same snake_case names as its bodies, so `includeTombstoned`
 * sent verbatim would silently take the field's default instead — a filter that
 * appears to be applied and is not.
 *
 * `undefined` is dropped rather than sent as the string `"undefined"`, so an
 * omitted option means "let the edge default it".
 */
function encodeQuery(query: Query | undefined): string {
  if (query === undefined) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (v === undefined) continue;
    // Every query field on every route is a string, number or boolean. `Query`
    // cannot say so in the type — a TypeScript `interface` is not assignable to
    // an index-signature type, and all of these are interfaces — so the
    // guarantee is enforced here instead. Without it a nested object would
    // stringify to the literal `[object Object]` and the request would go out
    // silently wrong; the edge would answer 400 or, worse, apply a default.
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new TypeError(
        `query parameter \`${k}\` must be a string, number or boolean, got ${
          v === null ? "null" : typeof v
        }`,
      );
    }
    parts.push(`${encodeURIComponent(snakeCase(k))}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Interpolate a path id, escaped — an id is caller data, not a path fragment. */
function pathId(id: string): string {
  return encodeURIComponent(id);
}

export class BrainHttpClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: HttpRetryPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BrainHttpClientOptions) {
    // `opts` is non-optional in the type, but this package ships to JavaScript
    // callers too, so the guard covers a missing argument as well as a missing
    // key. `?.` keeps both cases in one expression.
    if (!opts?.apiKey) {
      throw new BrainHttpError(0, "config", "apiKey is required");
    }
    this.base = (opts.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_HTTP_RETRY, ...(opts.retry ?? {}) };
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new BrainHttpError(0, "config", "no fetch available; pass opts.fetch");
    }
    this.fetchImpl = f;
  }

  /**
   * Store a memory. Retried: every attempt carries the same `Idempotency-Key`,
   * so a retry after an ambiguous failure (the write landed, the response was
   * lost) replays the original result instead of storing twice.
   */
  encode(input: EncodeInput): Promise<EncodeResult> {
    return this.requestWithRetry("POST", "/v1/memories", input, undefined, {
      "idempotency-key": newIdempotencyKey(),
    });
  }

  /** Recall memories for a cue. */
  recall(input: RecallInput): Promise<RecallResult> {
    return this.requestOnce("POST", "/v1/recall", input);
  }

  /** Forget a memory. */
  forget(input: ForgetInput): Promise<ForgetResult> {
    return this.requestOnce("DELETE", "/v1/memories", input);
  }

  /** Create/overwrite a directed edge between two memories. */
  link(input: LinkInput): Promise<LinkResult> {
    return this.requestOnce("POST", "/v1/links", input);
  }

  /** Remove a directed edge (idempotent). */
  unlink(input: UnlinkInput): Promise<UnlinkResult> {
    return this.requestOnce("DELETE", "/v1/links", input);
  }

  /** Plan a path from a start state to a goal state. */
  plan(input: PlanInput): Promise<PlanResult> {
    return this.requestOnce("POST", "/v1/plan", input);
  }

  /** Infer over the graph from an observation. */
  reason(input: ReasonInput): Promise<ReasonResult> {
    return this.requestOnce("POST", "/v1/reason", input);
  }

  /** The identity Brain resolves from the credential. Idempotent GET — retried. */
  whoami(): Promise<Whoami> {
    return this.requestWithRetry<WireWhoami>("GET", "/v1/whoami").then(normalizeWhoami);
  }

  /** What the connected shard supports. Idempotent GET — retried. */
  capabilities(): Promise<Capabilities> {
    return this.requestWithRetry("GET", "/v1/capabilities");
  }

  /** A page of memories, newest first. Idempotent GET — retried. */
  memoryList(query?: MemoryListQuery): Promise<MemoryListPage> {
    return this.requestWithRetry("GET", "/v1/memories", undefined, query);
  }

  /** Everything the extraction pipeline produced for one memory. Retried. */
  memoryInspect(memoryId: string): Promise<MemoryInspect> {
    return this.requestWithRetry("GET", `/v1/memories/${pathId(memoryId)}/inspect`);
  }

  /** A page of entities matching the filters. Idempotent GET — retried. */
  listEntities(query?: ListEntitiesQuery): Promise<ListEntitiesResult> {
    return this.requestWithRetry("GET", "/v1/entities", undefined, query);
  }

  /** One entity by id. Idempotent GET — retried. */
  getEntity(entityId: string): Promise<EntityDetail> {
    return this.requestWithRetry("GET", `/v1/entities/${pathId(entityId)}`);
  }

  /** Mint an entity. Creates state — not retried. */
  createEntity(input: CreateEntityInput): Promise<CreateEntityResult> {
    return this.requestOnce("POST", "/v1/entities", input);
  }

  /**
   * Resolve a name to an entity. Not retried: with `allowCreate` it mints one,
   * and the outcome of a replay is not the outcome of the first attempt.
   */
  resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    return this.requestOnce("POST", "/v1/entities/resolve", input);
  }

  /** Walk the relation graph out from one entity. Not retried. */
  traverseRelations(entityId: string, input: TraverseInput = {}): Promise<TraverseResult> {
    return this.requestOnce("POST", `/v1/entities/${pathId(entityId)}/traverse`, input);
  }

  /** Relations anchored on one entity. Idempotent GET — retried. */
  listRelations(entityId: string, query?: ListRelationsQuery): Promise<ListRelationsResult> {
    return this.requestWithRetry(
      "GET",
      `/v1/entities/${pathId(entityId)}/relations`,
      undefined,
      query,
    );
  }

  /** One relation by id. Idempotent GET — retried. */
  getRelation(relationId: string, query?: GetRelationQuery): Promise<RelationDetail> {
    return this.requestWithRetry("GET", `/v1/relations/${pathId(relationId)}`, undefined, query);
  }

  /** A page of statements matching the filters. Idempotent GET — retried. */
  listStatements(query?: ListStatementsQuery): Promise<ListStatementsResult> {
    return this.requestWithRetry("GET", "/v1/statements", undefined, query);
  }

  /** One statement by id. Idempotent GET — retried. */
  getStatement(statementId: string, query?: GetStatementQuery): Promise<StatementDetail> {
    return this.requestWithRetry("GET", `/v1/statements/${pathId(statementId)}`, undefined, query);
  }

  /** A page of the typed graph (nodes + edges). Idempotent GET — retried. */
  graphFetch(query?: GraphFetchQuery): Promise<GraphPage> {
    return this.requestWithRetry("GET", "/v1/graph", undefined, query);
  }

  /** The active schema document. Idempotent GET — retried. */
  getSchema(query?: SchemaGetQuery): Promise<Schema> {
    return this.requestWithRetry("GET", "/v1/schema", undefined, query);
  }

  /** Upload a schema version. Mints a new version — not retried. */
  uploadSchema(input: SchemaUploadInput): Promise<SchemaUploadResult> {
    return this.requestOnce("POST", "/v1/schema", input);
  }

  /**
   * Validate a schema document without storing it. A dry run that writes
   * nothing, so it is idempotent despite being a POST — retried.
   */
  validateSchema(input: SchemaValidateInput): Promise<SchemaValidateResult> {
    return this.requestWithRetry("POST", "/v1/schema/validate", input);
  }

  /**
   * Replace the schema wholesale.
   *
   * Destructive: with `forceDropExisting` it drops the types the new document
   * omits, along with their data. Never retried — a retry after an ambiguous
   * failure could drop against a schema that the first attempt already
   * replaced.
   */
  replaceSchema(input: SchemaReplaceInput): Promise<SchemaReplaceResult> {
    return this.requestOnce("PUT", "/v1/schema", input);
  }

  /** Whether to retry after `attempt` (1-based) produced `err`. */
  private shouldRetry(attempt: number, err: BrainHttpError): boolean {
    // 429 is a "slow down", not a refusal: an idempotent call is safe to repeat
    // once the server's Retry-After has passed.
    return (
      attempt < this.retry.maxAttempts &&
      (err.status === 0 || err.status === 503 || err.status === 429)
    );
  }

  /** Milliseconds to wait after `attempt` (1-based) failed; a server hint wins. */
  private backoffMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.retry.maxDelayMs);
    }
    if (this.retry.baseDelayMs <= 0) return 0;
    return Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs);
  }

  /** Run an idempotent request, retrying `503`/transport per the policy. */
  private async requestWithRetry<T>(
    method: Method,
    path: string,
    body?: unknown,
    query?: Query,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let attempt = 1;
    for (;;) {
      try {
        return await this.requestOnce<T>(method, path, body, query, extraHeaders);
      } catch (e) {
        const err = e as ErrorWithRetryAfter;
        if (err instanceof BrainHttpError && this.shouldRetry(attempt, err)) {
          const delay = this.backoffMs(attempt, err.retryAfterMs);
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt += 1;
          continue;
        }
        throw e;
      }
    }
  }

  private async requestOnce<T>(
    method: Method,
    path: string,
    body?: unknown,
    query?: Query,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = path + encodeQuery(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      ...extraHeaders,
      authorization: `Bearer ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(toSnakeKeys(body));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.base + url, init);
    } catch (e) {
      // `cause` keeps the original error (and its stack) reachable; the message
      // alone loses everything about where a transport failure came from.
      //
      // The rule below only recognises the two-argument
      // `new Error(message, options)` shape, so it cannot see the `cause` in
      // `BrainHttpError`'s (status, code, message, options) constructor.
      // biome-ignore lint/style/useErrorCause: cause is passed in the options bag below
      throw new BrainHttpError(
        0,
        "transport",
        `request to ${this.base}${url} failed: ${describeThrown(e)}`,
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      const { code, message, fieldErrors } = parseErrorBody(res.status, text);
      const err: ErrorWithRetryAfter = new BrainHttpError(res.status, code, message, {
        fieldErrors,
      });
      // Attach a server Retry-After hint for the retry scheduler. Not part of
      // the public {status, code, message} shape.
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    return (text ? toCamelKeys(JSON.parse(text)) : undefined) as T;
  }
}

/** A fresh idempotency key for one logical write (reused across its retries). */
function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * Read an error body in either shape a Brain HTTP server sends: brain-edge's
 * `{ error: { code, message } }`, or the cloud gateway's RFC 9457
 * `application/problem+json` (`{ code, title, detail, errors[] }`).
 */
function parseErrorBody(
  status: number,
  text: string,
): {
  code: string;
  message: string;
  fieldErrors: { field: string; code?: string; message: string }[];
} {
  let code = "http_error";
  let message = text || `HTTP ${status}`;
  let fieldErrors: { field: string; code?: string; message: string }[] = [];
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    const nested = parsed?.error as { code?: string; message?: string } | undefined;
    if (nested && typeof nested === "object") {
      code = nested.code ?? code;
      message = nested.message ?? message;
    } else if (parsed && typeof parsed.code === "string") {
      code = parsed.code;
      const detail = typeof parsed.detail === "string" ? parsed.detail : undefined;
      const title = typeof parsed.title === "string" ? parsed.title : undefined;
      message = detail ?? title ?? message;
      if (Array.isArray(parsed.errors)) {
        fieldErrors = (parsed.errors as Record<string, unknown>[])
          .filter((e) => typeof e.field === "string" && typeof e.message === "string")
          .map((e) => ({
            field: e.field as string,
            ...(typeof e.code === "string" ? { code: e.code } : {}),
            message: e.message as string,
          }));
        // "one or more fields are invalid" says nothing; name the fields.
        if (fieldErrors.length > 0) {
          message = fieldErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
        }
      }
    }
  } catch {
    // not JSON — keep the raw text
  }
  return { code, message, fieldErrors };
}

/** `/v1/whoami` as either server sends it: brain-edge's permission flags, or
 * the gateway's bitset (1 recall · 2 encode · 4 forget; 0 = unrestricted). */
type WireWhoami = Omit<Whoami, "permissions"> & { permissions: Permissions | number };

const PERM_RECALL = 1;
const PERM_ENCODE = 2;
const PERM_FORGET = 4;

function normalizeWhoami(w: WireWhoami): Whoami {
  if (typeof w.permissions !== "number") return w as Whoami;
  const bits = w.permissions;
  const all = bits === 0;
  return {
    ...w,
    permissions: {
      canRecall: all || (bits & PERM_RECALL) !== 0,
      canEncode: all || (bits & PERM_ENCODE) !== 0,
      canForget: all || (bits & PERM_FORGET) !== 0,
      // The bitset carries no plan / reason / admin bits: only an
      // unrestricted key grants them.
      canPlan: all,
      canReason: all,
      canAdmin: all,
    },
  };
}
