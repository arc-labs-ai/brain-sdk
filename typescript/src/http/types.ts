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
  occurred_at?: number;
}
export interface EncodeResult {
  memory_id: string;
  was_deduplicated: boolean;
  salience: number;
  kind: number;
  created_at_unix_nanos: number;
  auto_edges_added: number;
}

// --- recall ---------------------------------------------------------------
export interface RecallInput {
  query: string;
  max_results?: number;
  subject?: string;
}
export interface MemoryHit {
  memory_id: string;
  text: string;
  similarity_score: number;
  confidence: number;
  salience: number;
  kind: number;
  created_at_unix_nanos: number;
}
export interface RecallResult {
  answer_kind: AnswerKind;
  memories: MemoryHit[];
}

// --- forget ---------------------------------------------------------------
export interface ForgetInput {
  memory_id: string;
  hard?: boolean;
}
export interface ForgetResult {
  memory_id: string;
  was_already_forgotten: boolean;
  edges_removed: number;
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
  created_at_unix_nanos: number;
  already_existed: boolean;
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
  memory_id?: string;
}
export interface PlanInput {
  start: Endpoint;
  goal: Endpoint;
  max_steps?: number;
  max_wall_time_ms?: number;
  max_branches?: number;
  strategy?: string;
}
export interface PlanStep {
  step_index: number;
  memory_id: string;
  text: string;
  transition_kind: string;
  confidence: number;
  estimated_distance_to_goal: number;
}
export interface PlanResult {
  steps: PlanStep[];
}
export interface ReasonInput {
  observation: Endpoint;
  depth?: number;
  confidence_threshold?: number;
  max_inferences?: number;
  budget_wall_time_ms?: number;
}
export interface InferenceStep {
  step_index: number;
  claim: string;
  supporting_memories: string[];
  contradicting_memories: string[];
  confidence: number;
  inference_kind: string;
}
export interface ReasonResult {
  inferences: InferenceStep[];
}

// --- identity -------------------------------------------------------------
export interface Permissions {
  can_encode: boolean;
  can_recall: boolean;
  can_plan: boolean;
  can_reason: boolean;
  can_forget: boolean;
  can_admin: boolean;
}
export interface Whoami {
  namespace: string;
  space_id: string;
  permissions: Permissions;
}
export interface Capabilities {
  rerank: boolean;
  llm_extractor: boolean;
  classifier_extractor: boolean;
  pattern_extractor: boolean;
  schema_namespaces: string[];
  vector_dim: number;
}
