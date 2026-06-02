/**
 * Ergonomic request builders for the v1 verbs.
 *
 * The wire interfaces in `./wire/types` mirror the protocol exactly — every
 * field present, in wire order. That is what the codec needs but a poor calling
 * convention: most fields have an obvious default and only a few matter per
 * call. These builders fill the defaults, mint a `requestId`, and expose just
 * the knobs a caller tunes. The verbs on `BrainClient` accept either a builder
 * (via `.build()`) or a hand-built wire object.
 */

import { newId } from "./client.js";
import {
  type EdgeRequest,
  type EncodeRequest,
  ForgetMode,
  type ForgetRequest,
  MemoryKindWire,
  type RecallRequest,
  type WireUuid,
} from "./wire/types.js";

/** Builder for an ENCODE request (defaults: semantic, context 0, dedup on). */
export class EncodeBuilder {
  private contextId = 0n;
  private kind: MemoryKindWire = MemoryKindWire.Semantic;
  private salienceHint = 0.5;
  private edges: EdgeRequest[] = [];
  private deduplicate = true;

  constructor(private readonly text: string) {}

  context(contextId: bigint): this {
    this.contextId = contextId;
    return this;
  }

  withKind(kind: MemoryKindWire): this {
    this.kind = kind;
    return this;
  }

  salience(salienceHint: number): this {
    this.salienceHint = salienceHint;
    return this;
  }

  edge(edge: EdgeRequest): this {
    this.edges.push(edge);
    return this;
  }

  dedup(deduplicate: boolean): this {
    this.deduplicate = deduplicate;
    return this;
  }

  /** Finish into a wire `EncodeRequest`, minting a fresh `requestId`. */
  build(): EncodeRequest {
    return {
      text: this.text,
      contextId: this.contextId,
      kind: this.kind,
      salienceHint: this.salienceHint,
      edges: this.edges,
      requestId: newId(),
      txnId: null,
      deduplicate: this.deduplicate,
    };
  }
}

/** Builder for a RECALL request (defaults: top 10, own agent, text + edges). */
export class RecallBuilder {
  private topKValue = 10;
  private confidenceThreshold = 0;
  private contextFilter: bigint[] | null = null;
  private ageBoundUnixNanos: bigint | null = null;
  private kindFilter: MemoryKindWire[] | null = null;
  private salienceFloor = 0;
  private includeEdges = true;
  private includeGraph = false;
  private includeText = true;
  private agentFilter: WireUuid[] = [];
  private includeOtherAgents = false;

  constructor(private readonly cueText: string) {}

  topK(topK: number): this {
    this.topKValue = topK;
    return this;
  }

  confidence(threshold: number): this {
    this.confidenceThreshold = threshold;
    return this;
  }

  contexts(contexts: bigint[]): this {
    this.contextFilter = contexts;
    return this;
  }

  kinds(kinds: MemoryKindWire[]): this {
    this.kindFilter = kinds;
    return this;
  }

  salience(floor: number): this {
    this.salienceFloor = floor;
    return this;
  }

  edges(include: boolean): this {
    this.includeEdges = include;
    return this;
  }

  graph(include: boolean): this {
    this.includeGraph = include;
    return this;
  }

  text(include: boolean): this {
    this.includeText = include;
    return this;
  }

  agents(agents: WireUuid[]): this {
    this.agentFilter = agents;
    return this;
  }

  otherAgents(include: boolean): this {
    this.includeOtherAgents = include;
    return this;
  }

  /** Finish into a wire `RecallRequest`, minting a fresh `requestId`. */
  build(): RecallRequest {
    return {
      cueText: this.cueText,
      topK: this.topKValue,
      confidenceThreshold: this.confidenceThreshold,
      contextFilter: this.contextFilter,
      ageBoundUnixNanos: this.ageBoundUnixNanos,
      kindFilter: this.kindFilter,
      salienceFloor: this.salienceFloor,
      includeEdges: this.includeEdges,
      includeGraph: this.includeGraph,
      includeText: this.includeText,
      requestId: newId(),
      txnId: null,
      agentFilter: this.agentFilter,
      includeOtherAgents: this.includeOtherAgents,
    };
  }
}

/** Builder for a FORGET request (defaults to a soft forget; `.hard()` zeroes). */
export class ForgetBuilder {
  private mode: ForgetMode = ForgetMode.Soft;

  constructor(private readonly memoryId: bigint) {}

  hard(): this {
    this.mode = ForgetMode.Hard;
    return this;
  }

  withMode(mode: ForgetMode): this {
    this.mode = mode;
    return this;
  }

  /** Finish into a wire `ForgetRequest`, minting a fresh `requestId`. */
  build(): ForgetRequest {
    return {
      memoryId: this.memoryId,
      mode: this.mode,
      requestId: newId(),
      txnId: null,
    };
  }
}
