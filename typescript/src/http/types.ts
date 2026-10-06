/**
 * The Brain HTTP contract — request/response shapes for {@link BrainHttpClient}.
 *
 * These are the edge's DTOs (`contract/http-routes.json`) field-for-field, but
 * spelled camelCase, as the rest of this SDK's types are. The wire's snake_case
 * is produced and consumed at a single transport seam inside the client, so a
 * snake_case key never appears in this file — see `toSnakeKeys` / `toCamelKeys`
 * in `client.ts`. The Rust and Python SDKs need no such split: snake_case is
 * idiomatic there, so their types match the wire by coincidence.
 *
 * Query types are the exception: a query string does not pass through that
 * seam, so the client snake_cases those parameter names as it builds the URL.
 */

/** A directed memory-graph edge kind. */
export type EdgeKind =
  | "caused"
  | "followed_by"
  | "derived_from"
  | "similar_to"
  | "contradicts"
  | "supports"
  | "references"
  | "part_of";

/** The shape a recall answer took. */
export type AnswerKind = "single" | "many" | "none";

// --- encode ---------------------------------------------------------------
export interface EncodeInput {
  text: string;
  session?: number;
  occurredAt?: number;
}
export interface EncodeResult {
  memoryId: string;
  wasDeduplicated: boolean;
  salience: number;
  kind: number;
  createdAtUnixNanos: number;
  autoEdgesAdded: number;
}

// --- recall ---------------------------------------------------------------
export interface RecallInput {
  query: string;
  /** `1..=1000` (the server rejects anything outside it). */
  maxResults?: number;
  subject?: string;
  /** Return Brain's read-pipeline trace as `RecallResult.trace` (cloud
   * gateway; ignored where unsupported). Several KB — leave off in hot paths. */
  includeTrace?: boolean;
}
export interface MemoryHit {
  memoryId: string;
  text: string;
  similarityScore: number;
  confidence: number;
  salience: number;
  kind: number;
  createdAtUnixNanos: number;
}
export interface RecallResult {
  answerKind: AnswerKind;
  memories: MemoryHit[];
  /** The read-pipeline trace as a JSON STRING (retrievers, fusion, filter
   * chain, rerank), when `includeTrace` was set and the server supports it.
   * A string because its ids are 128-bit integers a JSON number would round;
   * parse with a big-integer-safe reader. */
  trace?: string;
}

// --- forget ---------------------------------------------------------------
export interface ForgetInput {
  memoryId: string;
  hard?: boolean;
}
export interface ForgetResult {
  memoryId: string;
  wasAlreadyForgotten: boolean;
  edgesRemoved: number;
}

// --- link / unlink --------------------------------------------------------
export interface LinkInput {
  source: string;
  target: string;
  kind: EdgeKind;
  weight?: number;
}
export interface LinkResult {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  createdAtUnixNanos: number;
  alreadyExisted: boolean;
}
export interface UnlinkInput {
  source: string;
  target: string;
  kind: EdgeKind;
}
export interface UnlinkResult {
  source: string;
  target: string;
  kind: EdgeKind;
  removed: boolean;
}

// --- plan / reason --------------------------------------------------------
export interface Endpoint {
  text?: string;
  memoryId?: string;
}
export interface PlanInput {
  start: Endpoint;
  goal: Endpoint;
  /** Default 8; the cloud gateway accepts 1..=64. */
  maxSteps?: number;
  /** Default 5000; the cloud gateway accepts 1..=10000. */
  maxWallTimeMs?: number;
  /** Default 32; the cloud gateway accepts 1..=1024. */
  maxBranches?: number;
  /** `auto` (default), `astar`, `mcts` or `attractor_rollout`. */
  strategy?: string;
}
export interface PlanStep {
  stepIndex: number;
  memoryId: string;
  text: string;
  transitionKind: string;
  confidence: number;
  estimatedDistanceToGoal: number;
}
export interface PlanResult {
  steps: PlanStep[];
}
export interface ReasonInput {
  observation: Endpoint;
  /** Default 3; the cloud gateway accepts 1..=8. */
  depth?: number;
  /** Default 0.5, in 0..=1. */
  confidenceThreshold?: number;
  /** Default 10; the cloud gateway accepts 1..=100. */
  maxInferences?: number;
  /** Default 5000; the cloud gateway accepts 1..=10000. */
  budgetWallTimeMs?: number;
}
export interface InferenceStep {
  stepIndex: number;
  claim: string;
  supportingMemories: string[];
  contradictingMemories: string[];
  confidence: number;
  inferenceKind: string;
}
export interface ReasonResult {
  inferences: InferenceStep[];
}

// --- identity -------------------------------------------------------------
export interface Permissions {
  canEncode: boolean;
  canRecall: boolean;
  canPlan: boolean;
  canReason: boolean;
  canForget: boolean;
  canAdmin: boolean;
}
export interface Whoami {
  namespace: string;
  spaceId: string;
  permissions: Permissions;
}
export interface Capabilities {
  rerank: boolean;
  llmExtractor: boolean;
  classifierExtractor: boolean;
  patternExtractor: boolean;
  schemaNamespaces: string[];
  vectorDim: number;
}

// --- memory list / inspect -------------------------------------------------

/** `GET /v1/memories` filters. Every field is optional; the edge defaults it. */
export interface MemoryListQuery {
  /** Page size, clamped to `1..=100` (default 50). */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** `desc` (default, newest first) or `asc`. */
  dir?: string;
  /** Include tombstoned memories (default false). */
  includeTombstoned?: boolean;
}
export interface MemoryListItem {
  memoryId: string;
  text: string;
  kind: number;
  state: number;
  createdAtUnixNanos: number;
  occurredAtUnixNanos: number;
  lastAccessedAtUnixNanos: number;
  salience: number;
  accessCount: number;
  statementCount: number;
  entityCount: number;
  relationCount: number;
}
export interface MemoryListPage {
  items: MemoryListItem[];
  /** Absent on the last page. */
  nextCursor?: string;
}

/** One extraction stage's record for `GET /v1/memories/{id}/inspect`. */
export interface StageRecord {
  memoryId: string;
  kind: number;
  salience: number;
  createdAtUnixNanos: number;
  occurredAtUnixNanos: number;
  vectorDim: number;
  textLen: number;
  lsn: number;
}
export interface StageKeywordField {
  field: string;
  terms: string[];
}
export interface StageGraphNode {
  id: string;
  name: string;
  kind: string;
  typeQname: string;
}
export interface StageGraphEdge {
  source: string;
  target: string;
  predicate: string;
  kind: string;
  confidence: number;
  /** Absent when the edge carries no event time. */
  eventAtUnixNanos?: number;
}
export interface StageGraph {
  nodes: StageGraphNode[];
  edges: StageGraphEdge[];
}
export interface StageArtifact {
  vector: number[];
  record: StageRecord | null;
  hypeQuestions: string[];
  keywordFields: StageKeywordField[];
  graph: StageGraph | null;
}
export interface MemoryInspect {
  found: boolean;
  memoryId: string;
  text: string;
  artifact: StageArtifact;
}

// --- entities --------------------------------------------------------------

/** `GET /v1/entities` filters. Omit a field to leave that filter off. */
export interface ListEntitiesQuery {
  /**
   * Entity-type filter. Effectively REQUIRED today: the edge and gateway pass
   * `0`/omitted through as "every type", but Brain v1.0 rejects that with
   * `400` ("entity_type_id filter is required"). Pass a real type id.
   */
  typeId?: number;
  /** Canonical-name prefix filter. */
  prefix?: string;
  /** Minimum mention count (`0`/omitted = no floor). */
  mentionCountMin?: number;
  /** Include tombstoned entities (default false). */
  includeTombstoned?: boolean;
  /** Include merged-away entities (default false). */
  includeMerged?: boolean;
  /** Page size; omitted → 100, clamped to `1..=1000`. */
  limit?: number;
  /** Resume after the previous page (its `nextCursor`). Keep the other
   * filters identical across pages — the cursor is bound to them. */
  cursor?: string;
}
export interface EntityDetail {
  entityId: string;
  entityTypeId: number;
  canonicalName: string;
  aliases: string[];
  mentionCount: number;
  createdAtUnixNanos: number;
  updatedAtUnixNanos: number;
  /** The entity this one was merged into, or `null`. */
  mergedInto: string | null;
}
export interface ListEntitiesResult {
  entities: EntityDetail[];
  count: number;
  /** Present when more rows follow; pass it back as `cursor`. */
  nextCursor?: string;
}
export interface CreateEntityInput {
  /** `>= 1` — `0` is not a type and is rejected (`422`). */
  entityTypeId: number;
  canonicalName: string;
  /** At most 64. */
  aliases?: string[];
}
export interface CreateEntityResult {
  entityId: string;
}
export interface ResolveEntityInput {
  candidateName: string;
  /** Free-text context to disambiguate with. */
  resolutionContext?: string;
  /** Entity-type hint; `0` (the default) resolves across every declared type. */
  typeHint?: number;
  /** Mint a new entity on a miss (default false — a pure read). */
  allowCreate?: boolean;
}
export interface ResolveEntityResult {
  outcome: string;
  tier: number;
  confidence: number;
  /** The resolved entity, or `null` when nothing matched. */
  entityId: string | null;
  candidateIds: string[];
}

// --- traversal -------------------------------------------------------------
export interface TraverseInput {
  /** `outgoing` (default), `incoming`, or `both`. */
  direction?: string;
  /** Relation types to follow (empty/omitted = every type). */
  relationTypes?: string[];
  /** Max hop depth; omitted → 3, clamped to `1..=5`. */
  maxDepth?: number;
  /** Max nodes to visit; omitted → 100, clamped to `1..=1000`. */
  maxNodes?: number;
  /** Include superseded relations (default false). */
  includeSuperseded?: boolean;
}
export interface TraversalStep {
  relationId: string;
  from: string;
  to: string;
  relationType: string;
  depth: number;
}
export interface TraversalPath {
  steps: TraversalStep[];
}
export interface TraverseResult {
  paths: TraversalPath[];
  totalPaths: number;
  truncated: boolean;
}

// --- relations -------------------------------------------------------------

/** `GET /v1/entities/{id}/relations` filters; the anchor is the path id. */
export interface ListRelationsQuery {
  /** `from`/`outgoing`/`out` (default) or `to`/`incoming`/`in`. There is no
   * `both` (`400`): list each direction and merge. */
  direction?: string;
  /**
   * Relation-type filter; omitted = any type. Named `type` because that is the
   * query parameter the edge reads — its Rust field is `relation_type` with
   * `#[serde(rename = "type")]`, so the manifest's JSON name is what counts.
   */
  type?: string;
  /** Include superseded relations (default false). */
  includeSuperseded?: boolean;
  /** Include tombstoned relations (default false). */
  includeTombstoned?: boolean;
  /** Page size; omitted → 100, clamped to `1..=1000`. */
  limit?: number;
  /** Resume after the previous page (its `nextCursor`). Keep the other
   * filters identical across pages — the cursor is bound to them. */
  cursor?: string;
}
/** `GET /v1/relations/{id}` options. */
export interface GetRelationQuery {
  /** Follow supersession to the current chain head (default true). */
  followSupersession?: boolean;
}
export interface RelationDetail {
  relationId: string;
  relationType: string;
  fromEntity: string;
  toEntity: string;
  confidence: number;
  validFromUnixNanos: number;
  /** `0` = still valid. */
  validToUnixNanos: number;
  isSymmetric: boolean;
  tombstoned: boolean;
}
export interface ListRelationsResult {
  relations: RelationDetail[];
  count: number;
  /** Present when more rows follow; pass it back as `cursor`. */
  nextCursor?: string;
}

// --- statements ------------------------------------------------------------

/**
 * A statement's object: a tagged union discriminated by `kind`.
 *
 * The manifest's `enums` entry for `StatementObjectDto` carries
 * `tag = "kind", rename_all = "snake_case"`, so the tag rides in the object
 * alongside the variant's own fields: `{ kind: "entity", id }`.
 *
 * The tags are field *values*, not keys, so the camelCase seam leaves them
 * alone — `unix_nanos` on {@link StatementValue} stays `unix_nanos`, which is
 * what makes a `switch` on the discriminant safe.
 */
export type StatementObject =
  | { kind: "entity"; id: string }
  | { kind: "value"; value: StatementValue }
  | { kind: "memory"; id: string }
  | { kind: "statement"; id: string };

/** A scalar statement value: a tagged union discriminated by `type`. */
export type StatementValue =
  | { type: "text"; value: string }
  | { type: "integer"; value: number }
  | { type: "float"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "unix_nanos"; value: number }
  | { type: "blob"; value: number[] };

/** `GET /v1/statements` filters. */
export interface ListStatementsQuery {
  /** Subject entity id (UUID); omitted = any subject. */
  subject?: string;
  /** Predicate filter; omitted = any predicate. */
  predicate?: string;
  /** Kind filter (`fact`, `preference`, …); omitted = any kind. */
  kind?: string;
  /** Minimum confidence (`0.0` = no floor). */
  minConfidence?: number;
  /** Only current (non-superseded) statements (default true). */
  onlyCurrent?: boolean;
  /** Include tombstoned statements (default false). */
  includeTombstoned?: boolean;
  /** Page size; omitted → 100, clamped to `1..=1000`. */
  limit?: number;
  /** Resume after the previous page (its `nextCursor`). Keep the other
   * filters identical across pages — the cursor is bound to them. */
  cursor?: string;
}
/** `GET /v1/statements/{id}` options. */
export interface GetStatementQuery {
  /** Follow supersession to the current chain head (default true). */
  followSupersession?: boolean;
}
export interface StatementDetail {
  statementId: string;
  kind: string;
  subject: string;
  predicate: string;
  object: StatementObject;
  confidence: number;
  /** When the content happened (`0` = unset). */
  eventAtUnixNanos: number;
  validFromUnixNanos: number;
  /** `0` = still valid. */
  validToUnixNanos: number;
  tombstoned: boolean;
}
export interface ListStatementsResult {
  statements: StatementDetail[];
  count: number;
  /** Present when more rows follow; pass it back as `cursor`. */
  nextCursor?: string;
}

// --- graph -----------------------------------------------------------------

/** `GET /v1/graph` options. */
export interface GraphFetchQuery {
  /** Page size, clamped to `1..=500` (default 200). */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Emit value-object statement nodes + `has_statement` edges. */
  includeStatements?: boolean;
  /** Emit source memory nodes + `mentions` edges. */
  includeMemories?: boolean;
  /** Emit memory↔memory edges. Requires `includeMemories`, else a 400. */
  includeMemoryEdges?: boolean;
  /** Include tombstoned statements/relations (default false). */
  includeTombstoned?: boolean;
}
export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  typeQname: string;
}
export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: string;
  label: string;
}
export interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Absent on the last page. */
  nextCursor?: string;
}

// --- schema ----------------------------------------------------------------

/** `GET /v1/schema` selector. */
export interface SchemaGetQuery {
  /** Namespace; omitted = the credential's default. */
  namespace?: string;
  /** Version; `0`/omitted = the current one. */
  version?: number;
}
export interface Schema {
  namespace: string;
  schemaVersion: number;
  schemaDocument: string;
  uploadedAtUnixNanos: number;
  validatorVersion: number;
}
export interface SchemaError {
  code: string;
  message: string;
  line: number;
  column: number;
  length: number;
  severity: number;
}
export interface SchemaUploadInput {
  schemaDocument: string;
  /** Validate without persisting (default false). */
  dryRun?: boolean;
  /** Accept a backward-incompatible change (default false). */
  allowBreaking?: boolean;
}
export interface SchemaUploadResult {
  namespace: string;
  schemaVersion: number;
  backwardCompatible: boolean;
  validationErrors: SchemaError[];
}
export interface SchemaValidateInput {
  schemaDocument: string;
}
export interface SchemaValidateResult {
  namespace: string;
  wouldBeVersion: number;
  validationErrors: SchemaError[];
}
export interface SchemaReplaceInput {
  schemaDocument: string;
  /** Required, and not defaulted by the edge: drop what the new schema omits. */
  forceDropExisting: boolean;
}
export interface SchemaReplaceResult {
  namespace: string;
  schemaVersion: number;
  droppedCount: number;
  validationErrors: SchemaError[];
}
