/**
 * The Brain HTTP contract — request/response shapes for {@link BrainHttpClient}.
 *
 * Field names are the JSON wire names (snake_case), identical across the Rust,
 * Python, and TypeScript SDKs so the contract is the same everywhere.
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
  maxResults?: number;
  subject?: string;
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
  maxSteps?: number;
  maxWallTimeMs?: number;
  maxBranches?: number;
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
  depth?: number;
  confidenceThreshold?: number;
  maxInferences?: number;
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
