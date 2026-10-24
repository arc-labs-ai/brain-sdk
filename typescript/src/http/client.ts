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
import { Subscription } from "./sse.js";
import type {
  Capabilities,
  CreateEntityInput,
  CreateEntityResult,
  CreateRelationInput,
  CreateRelationResult,
  CreateSessionInput,
  CreateSpaceInput,
  CreateStatementInput,
  CreateStatementResult,
  DeleteSessionQuery,
  DropSchemaQuery,
  DropSchemaResult,
  EncodeInput,
  EncodeResult,
  EncodeVectorInput,
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
  ListExtractorsResult,
  ListRelationsQuery,
  ListRelationsResult,
  ListSchemasQuery,
  ListSchemasResult,
  ListSessionsQuery,
  ListSessionsResult,
  ListSpacesQuery,
  ListSpacesResult,
  ListStatementsQuery,
  ListStatementsResult,
  LlmCredential,
  LlmCredentialCheck,
  LlmCredentialDeleted,
  MaterializeProceduralInput,
  MaterializeProceduralResult,
  MemoryInspect,
  MemoryListPage,
  MemoryListQuery,
  MergeEntitiesInput,
  MergeEntitiesResult,
  PlanInput,
  PlanResult,
  PutLlmCredentialInput,
  QueryExplainResult,
  QueryInput,
  QueryTraceResult,
  ReasonInput,
  ReasonResult,
  RecallInput,
  RecallResult,
  RelationDetail,
  RenameEntityInput,
  ResolveEntityInput,
  ResolveEntityResult,
  RetireStatementQuery,
  RetractStatementResult,
  Schema,
  SchemaGetQuery,
  SchemaReplaceInput,
  SchemaReplaceResult,
  SchemaUploadInput,
  SchemaUploadResult,
  SchemaValidateInput,
  SchemaValidateResult,
  SessionErased,
  SessionProvision,
  SpaceErased,
  SpaceProvision,
  StatementDetail,
  StatementHistoryQuery,
  StatementHistoryResult,
  SubscribeQuery,
  SupersedeRelationResult,
  SupersedeStatementResult,
  TombstoneEntityQuery,
  TombstoneRelationQuery,
  TombstoneResult,
  TraverseInput,
  TraverseResult,
  UnlinkInput,
  UnlinkResult,
  UnmergeEntityResult,
  UpdateEntityInput,
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

  /* A PURE READ IS RETRYABLE, whatever its method.
   * `recall`, `plan`, `reason` and `traverse` are POSTs only because their filters need a body; none of them changes anything, so a transient 503/429 should be absorbed rather than raised at the caller.
   * `validate_schema` already worked this way — it is a dry run — and the other four were left behind.
   * What stays single-shot is what CREATES state: link, create_entity, resolve_entity (it can create), and the schema upload/replace. */
  /** Recall memories for a cue. */
  recall(input: RecallInput): Promise<RecallResult> {
    return this.requestWithRetry("POST", "/v1/recall", input);
  }

  /** Forget a memory.
   *
   * Retried like the reads: this DELETE's result type MODELS the repeat —
   * `wasAlreadyForgotten` is the documented answer the second time — so
   * repeating reaches the same end state, and a transient 503/429 on a
   * cleanup path should be absorbed rather than raised at the caller. */
  forget(input: ForgetInput): Promise<ForgetResult> {
    return this.requestWithRetry("DELETE", "/v1/memories", input);
  }

  /** Create/overwrite a directed edge between two memories. */
  link(input: LinkInput): Promise<LinkResult> {
    return this.requestOnce("POST", "/v1/links", input);
  }

  /** Remove a directed edge (idempotent).
   *
   * Retried for the same reason as `forget`: `removed: false` is the
   * documented answer when the edge was not there. */
  unlink(input: UnlinkInput): Promise<UnlinkResult> {
    return this.requestWithRetry("DELETE", "/v1/links", input);
  }

  /** Plan a path from a start state to a goal state. */
  plan(input: PlanInput): Promise<PlanResult> {
    return this.requestWithRetry("POST", "/v1/plan", input);
  }

  /** Infer over the graph from an observation. */
  reason(input: ReasonInput): Promise<ReasonResult> {
    return this.requestWithRetry("POST", "/v1/reason", input);
  }

  /** The identity Brain resolves from the credential. Idempotent GET — retried. */
  whoami(): Promise<Whoami> {
    return this.requestWithRetry<Whoami>("GET", "/v1/whoami");
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
    return this.requestWithRetry("POST", `/v1/entities/${pathId(entityId)}/traverse`, input);
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

  // --- space lifecycle -----------------------------------------------------
  //
  // All three act on the caller's effective space: Brain resolves it from the
  // credential and never takes it from the request, so none of them names one.

  /**
   * Provision the caller's space. Idempotent — read `created` to tell whether
   * this call made it.
   */
  createSpace(input?: CreateSpaceInput): Promise<SpaceProvision> {
    return this.requestWithRetry("POST", "/v1/spaces", input ?? {});
  }

  /**
   * The spaces in the caller's namespace.
   *
   * Check `crossShardComplete`: `false` means the listing covered one shard,
   * and treating a partial listing as complete is how a caller concludes a
   * space is gone.
   */
  listSpaces(query?: ListSpacesQuery): Promise<ListSpacesResult> {
    return this.requestWithRetry("GET", "/v1/spaces", undefined, query);
  }

  /** Erase the caller's space and everything under it. Hard, immediate. */
  deleteSpace(): Promise<SpaceErased> {
    // Retryable: a repeat reaches the same end state and answers
    // `existed: false`, which the result models.
    return this.requestWithRetry("DELETE", "/v1/spaces");
  }

  // --- session lifecycle ---------------------------------------------------

  /** Provision a session in the caller's space. Idempotent on the id. */
  createSession(input: CreateSessionInput): Promise<SessionProvision> {
    return this.requestWithRetry("POST", "/v1/sessions", input);
  }

  /** The sessions in the caller's space. */
  listSessions(query?: ListSessionsQuery): Promise<ListSessionsResult> {
    return this.requestWithRetry("GET", "/v1/sessions", undefined, query);
  }

  /** Erase a session. Soft unless `hard` is asked for by name. */
  deleteSession(sessionId: number, query?: DeleteSessionQuery): Promise<SessionErased> {
    return this.requestWithRetry(
      "DELETE",
      `/v1/sessions/${pathId(String(sessionId))}`,
      undefined,
      query,
    );
  }

  // --- entity authoring ----------------------------------------------------

  /**
   * Replace an entity's name, aliases and attribute blob.
   *
   * A REPLACE, not a patch: an omitted `aliases` or `attributes` CLEARS it.
   * {@link getEntity} returns both, so a read-modify-write round-trips.
   */
  updateEntity(entityId: string, input: UpdateEntityInput): Promise<EntityDetail> {
    // The same replace applied twice is the same end state.
    return this.requestWithRetry("PUT", `/v1/entities/${pathId(entityId)}`, input);
  }

  /**
   * Change an entity's canonical name. `moveToAlias` defaults to true on the
   * edge: a name an entity was known by is how a later mention still resolves
   * to it, so dropping it should be asked for.
   */
  renameEntity(entityId: string, input: RenameEntityInput): Promise<EntityDetail> {
    return this.requestWithRetry("POST", `/v1/entities/${pathId(entityId)}/rename`, input);
  }

  /**
   * Fold another entity into this one. `survivorId` is what remains.
   *
   * Reversible for `gracePeriodSeconds`, which the result carries so a caller
   * need not know the deployment's configuration.
   */
  mergeEntities(survivorId: string, input: MergeEntitiesInput): Promise<MergeEntitiesResult> {
    // Single-shot: a merge writes an audit record, and a retried one writes a
    // second.
    return this.requestOnce("POST", `/v1/entities/${pathId(survivorId)}/merge`, input);
  }

  /** Undo a merge. The id is the entity that was merged away. */
  unmergeEntity(mergedEntityId: string): Promise<UnmergeEntityResult> {
    return this.requestOnce("POST", `/v1/entities/${pathId(mergedEntityId)}/unmerge`);
  }

  /**
   * Tombstone an entity. The row stays and reads stop resolving to it, which
   * is what keeps statements that referenced it interpretable.
   */
  tombstoneEntity(entityId: string, query?: TombstoneEntityQuery): Promise<TombstoneResult> {
    return this.requestWithRetry("DELETE", `/v1/entities/${pathId(entityId)}`, undefined, query);
  }

  // --- statement authoring -------------------------------------------------

  /**
   * Assert a claim.
   *
   * Brain may recognise it as a revision of an existing claim and supersede
   * that one; `autoSuperseded` says when it did.
   */
  createStatement(input: CreateStatementInput): Promise<CreateStatementResult> {
    return this.requestOnce("POST", "/v1/statements", input);
  }

  /**
   * Replace a claim with a revised one, keeping both and the link between
   * them. The replacement is a whole statement rather than a patch.
   */
  supersedeStatement(
    statementId: string,
    input: CreateStatementInput,
  ): Promise<SupersedeStatementResult> {
    return this.requestOnce("POST", `/v1/statements/${pathId(statementId)}/supersede`, input);
  }

  /** Retire a claim. The row stays; reads stop returning it. */
  tombstoneStatement(statementId: string, query?: RetireStatementQuery): Promise<TombstoneResult> {
    return this.requestWithRetry(
      "DELETE",
      `/v1/statements/${pathId(statementId)}`,
      undefined,
      query,
    );
  }

  /**
   * Withdraw a claim. Stronger than {@link tombstoneStatement}: the content
   * itself is scheduled to be zeroed, and the result says when.
   */
  retractStatement(
    statementId: string,
    query?: RetireStatementQuery,
  ): Promise<RetractStatementResult> {
    return this.requestWithRetry(
      "POST",
      `/v1/statements/${pathId(statementId)}/retract`,
      undefined,
      query,
    );
  }

  /** Every version of one claim, oldest first. */
  statementHistory(
    statementId: string,
    query?: StatementHistoryQuery,
  ): Promise<StatementHistoryResult> {
    return this.requestWithRetry(
      "GET",
      `/v1/statements/${pathId(statementId)}/history`,
      undefined,
      query,
    );
  }

  // --- relation authoring --------------------------------------------------

  /** Assert a typed edge between two entities. */
  createRelation(input: CreateRelationInput): Promise<CreateRelationResult> {
    return this.requestOnce("POST", "/v1/relations", input);
  }

  /**
   * Replace an edge with a revised one.
   *
   * The replacement REPLACES the property blob, which is why
   * {@link getRelation} returns `properties` — a revision that only meant to
   * change validity can carry the old ones back.
   */
  supersedeRelation(
    relationId: string,
    input: CreateRelationInput,
  ): Promise<SupersedeRelationResult> {
    return this.requestOnce("POST", `/v1/relations/${pathId(relationId)}/supersede`, input);
  }

  /** Retire an edge. */
  tombstoneRelation(relationId: string, query?: TombstoneRelationQuery): Promise<TombstoneResult> {
    return this.requestWithRetry("DELETE", `/v1/relations/${pathId(relationId)}`, undefined, query);
  }

  // --- schema introspection + drop -----------------------------------------

  /**
   * The namespace's schema version history.
   *
   * Distinct from {@link getSchema}, which returns one document: this is what
   * a caller about to upload needs to see what it is adding to.
   */
  listSchemas(query?: ListSchemasQuery): Promise<ListSchemasResult> {
    return this.requestWithRetry("GET", "/v1/schemas", undefined, query);
  }

  /**
   * The extractors registered on the shard. Read-only: extraction is
   * always-on and cannot be toggled. Here so a caller reading `extractorId`
   * on a statement can find out what produced it.
   */
  listExtractors(): Promise<ListExtractorsResult> {
    return this.requestWithRetry("GET", "/v1/extractors");
  }

  /**
   * Drop one declared predicate or relation type.
   *
   * `kind` is `predicate` or `relation_type`. Entity types are not droppable:
   * they are global in the v1 storage model, so dropping one would race rows
   * in other namespaces.
   */
  dropSchema(kind: string, name: string, query?: DropSchemaQuery): Promise<DropSchemaResult> {
    return this.requestOnce(
      "DELETE",
      `/v1/schema/${pathId(kind)}/${pathId(name)}`,
      undefined,
      query,
    );
  }

  // --- memory extras -------------------------------------------------------

  /**
   * Store a memory with a caller-supplied embedding.
   *
   * `modelFingerprint` is required: vectors from different models are not
   * comparable, so a recall that mixed them would rank nonsense confidently.
   */
  encodeVector(input: EncodeVectorInput): Promise<EncodeResult> {
    return this.requestWithRetry("POST", "/v1/memories/vector", input, undefined, {
      "idempotency-key": newIdempotencyKey(),
    });
  }

  /**
   * Render the caller's remembered directives into a system-prompt block.
   *
   * Check `trimmedByBudget`: `true` means directives did not make it in, so
   * the block is not the whole set.
   */
  materializeProcedural(input?: MaterializeProceduralInput): Promise<MaterializeProceduralResult> {
    return this.requestWithRetry("POST", "/v1/procedural/materialize", input ?? {});
  }

  // --- query introspection -------------------------------------------------

  /**
   * The plan Brain would run, and its estimated cost. Does NOT run it.
   *
   * Pin `retrievers` to answer "what would THIS plan cost"; leaving it to
   * `auto` answers "what would the router pick today".
   */
  queryExplain(input: QueryInput): Promise<QueryExplainResult> {
    return this.requestWithRetry("POST", "/v1/query/explain", input);
  }

  /**
   * Run the query and report what happened, with the measured latency.
   * Unlike {@link queryExplain}, this costs what the query costs.
   */
  queryTrace(input: QueryInput): Promise<QueryTraceResult> {
    return this.requestWithRetry("POST", "/v1/query/trace", input);
  }

  // --- BYOK provider credentials -------------------------------------------

  /**
   * Register (or replace) this tenant's provider key.
   *
   * The edge verifies the key with the provider before storing it, and seals
   * it on arrival; it is never returned.
   */
  putLlmCredential(input: PutLlmCredentialInput): Promise<LlmCredential> {
    return this.requestOnce("PUT", "/v1/llm-credential", input);
  }

  /** What is installed for this tenant. Carries no key material. */
  getLlmCredential(): Promise<LlmCredential> {
    return this.requestWithRetry("GET", "/v1/llm-credential");
  }

  /**
   * Remove this tenant's provider key. `deleted: false` means there was
   * nothing there — which matters during an incident response.
   */
  deleteLlmCredential(): Promise<LlmCredentialDeleted> {
    return this.requestWithRetry("DELETE", "/v1/llm-credential");
  }

  /**
   * Check a key WITHOUT storing it. Nothing is written and nothing existing
   * is touched, so this is safe against a namespace that already has a
   * working credential.
   */
  testLlmCredential(input: PutLlmCredentialInput): Promise<LlmCredentialCheck> {
    return this.requestWithRetry("POST", "/v1/llm-credential/test", input);
  }

  /**
   * Re-check the key already stored. A key that worked at registration can be
   * revoked or run out of credit later, where the first sign is otherwise an
   * opaque upstream 401 on a write.
   */
  verifyLlmCredential(): Promise<LlmCredentialCheck> {
    return this.requestWithRetry("POST", "/v1/llm-credential/verify");
  }

  // --- change feed ---------------------------------------------------------

  /**
   * Open the caller's change feed.
   *
   * Returns a {@link Subscription} you iterate:
   *
   * ```ts
   * for await (const item of await client.subscribe()) {
   *   if (item.kind === "event") console.log(item.event.lsn);
   * }
   * ```
   *
   * Unsubscribing is closing it — the edge tears the Brain-side subscription
   * down when the response closes — and breaking out of the `for await` does
   * that for you.
   *
   * Every event carries an `lsn`, and the subscription remembers the last one
   * ({@link Subscription.lastEventId}). Pass it back as `fromLsn` on a
   * reconnect to resume exactly rather than replay or skip.
   *
   * Not retried, deliberately: a retry would reopen the feed at the original
   * position and re-deliver everything already seen. Where to resume is the
   * caller's decision, because only the caller knows where it got to.
   */
  async subscribe(query?: SubscribeQuery): Promise<Subscription> {
    return this.openStream("GET", "/v1/subscribe", {
      // Comma-separated on the wire, so a feed subscription is one readable
      // URL that survives being pasted into a shell.
      sessions: query?.sessions?.join(","),
      kinds: query?.kinds?.join(","),
      memories: query?.memories?.join(","),
      includeHistory: query?.includeHistory,
      fromLsn: query?.fromLsn,
      maxInflight: query?.maxInflight,
    });
  }

  /**
   * Open a streaming response rather than reading a body to completion.
   *
   * Separate from {@link requestOnce} because the two differ in every way
   * that matters: no retry, no body read, and no request timeout — a
   * subscription is long-lived by definition, and its liveness signal is the
   * edge's keep-alive comment rather than a deadline.
   */
  private async openStream(method: Method, path: string, query?: Query): Promise<Subscription> {
    const url = this.base + path + encodeQuery(query);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "text/event-stream",
        },
      });
    } catch (e) {
      // biome-ignore lint/style/useErrorCause: cause is passed in the options bag below
      throw new BrainHttpError(0, "transport", `subscribe to ${url} failed: ${describeThrown(e)}`, {
        cause: e,
      });
    }
    if (!res.ok) {
      const { code, message, fieldErrors } = parseErrorBody(res.status, await res.text());
      throw new BrainHttpError(res.status, code, message, { fieldErrors });
    }
    if (!res.body) {
      throw new BrainHttpError(0, "transport", `subscribe to ${url} returned no body`);
    }
    return new Subscription(res.body);
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
