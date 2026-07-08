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
  type EncodeRequest,
  ForgetMode,
  type ForgetRequest,
  MemoryKindWire,
  type RecallRequest,
} from "./wire/types.js";

/** Builder for an ENCODE request (defaults: context 0). */
export class EncodeBuilder {
  private contextId = 0n;
  private occurredAtUnixNanos: bigint | null = null;

  constructor(private readonly text: string) {}

  context(contextId: bigint): this {
    this.contextId = contextId;
    return this;
  }

  /** Stamp the wall-clock time the remembered event occurred. */
  occurredAt(unixNanos: bigint): this {
    this.occurredAtUnixNanos = unixNanos;
    return this;
  }

  /** Finish into a wire `EncodeRequest`, minting a fresh `requestId`. */
  build(): EncodeRequest {
    return {
      text: this.text,
      contextId: this.contextId,
      requestId: newId(),
      txnId: null,
      occurredAtUnixNanos: this.occurredAtUnixNanos,
    };
  }
}

/** Builder for a RECALL request (defaults: 10 results). */
export class RecallBuilder {
  private subjectName = "";
  private maxResultsValue = 10;
  private confidenceThreshold = 0;
  private contextFilter: bigint[] | null = null;
  private ageBoundUnixNanos: bigint | null = null;
  private asOfRecordTimeUnixNanos: bigint | null = null;
  private kindFilter: MemoryKindWire[] | null = null;
  private salienceFloor = 0;
  private includeEdges = true;
  private includeGraph = false;
  private includeText = true;

  constructor(private readonly cueText: string) {}

  /** Name the subject to resolve facts about. */
  subject(name: string): this {
    this.subjectName = name;
    return this;
  }

  maxResults(maxResults: number): this {
    this.maxResultsValue = maxResults;
    return this;
  }

  /** Resolve against record-time state as of this instant (bi-temporal). */
  asOf(recordTimeUnixNanos: bigint): this {
    this.asOfRecordTimeUnixNanos = recordTimeUnixNanos;
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

  /** Finish into a wire `RecallRequest`, minting a fresh `requestId`. */
  build(): RecallRequest {
    return {
      cueText: this.cueText,
      subjectName: this.subjectName,
      maxResults: this.maxResultsValue,
      confidenceThreshold: this.confidenceThreshold,
      contextFilter: this.contextFilter,
      ageBoundUnixNanos: this.ageBoundUnixNanos,
      asOfRecordTimeUnixNanos: this.asOfRecordTimeUnixNanos,
      kindFilter: this.kindFilter,
      salienceFloor: this.salienceFloor,
      includeEdges: this.includeEdges,
      includeGraph: this.includeGraph,
      includeText: this.includeText,
      requestId: newId(),
      txnId: null,
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
