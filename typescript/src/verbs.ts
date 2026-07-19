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
  type ActAs,
  type EncodeRequest,
  ForgetMode,
  type ForgetRequest,
  MemoryKindWire,
  type RecallRequest,
  WaitMode,
  type WireUuid,
} from "./wire/types.js";

/** Builder for an ENCODE request (defaults: context 0). */
export class EncodeBuilder {
  private contextId = 0n;
  private occurredAtUnixNanos: bigint | null = null;
  private actAsIdentity: ActAs | null = null;
  private waitMode: WaitMode = WaitMode.Ack;
  private allowDups = false;

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

  /** Set the write-completion mode. `Derived` (the default when called) blocks
   * until async derivation completes and the ENCODE response carries the full
   * synchronous write-analysis trace; `Ack` returns after the durable ack. */
  wait(mode: WaitMode = WaitMode.Derived): this {
    this.waitMode = mode;
    return this;
  }

  /** Run this encode as an effective `(namespace, agentId)` on behalf of the
   * connection principal. Per-request, so one pooled service key can serve
   * many tenants. Requires the connection's `canActAs` grant server-side. */
  actAs(namespace: string, agentId: WireUuid): this {
    this.actAsIdentity = { namespace, agentId };
    return this;
  }

  /** Opt out of content dedup and force a distinct memory. By default Brain
   * dedupes byte-identical text on `(agentId, contextId, BLAKE3(text))` and
   * returns the existing memory (`wasDeduplicated = true`) without writing.
   * Call this when the same text is a genuinely distinct observation that must
   * coexist (e.g. the same fact re-stated at a different `occurredAt`). */
  allowDuplicates(allow = true): this {
    this.allowDups = allow;
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
      actAs: this.actAsIdentity,
      wait: this.waitMode,
      allowDuplicates: this.allowDups,
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
  private traceEnabled = false;
  private actAsIdentity: ActAs | null = null;

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

  /** Opt into the per-stage read-pipeline trace on the final RECALL response. */
  trace(enable = true): this {
    this.traceEnabled = enable;
    return this;
  }

  /** Run this recall as an effective `(namespace, agentId)` on behalf of the
   * connection principal. Per-request; requires the connection's `canActAs`
   * grant server-side. */
  actAs(namespace: string, agentId: WireUuid): this {
    this.actAsIdentity = { namespace, agentId };
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
      trace: this.traceEnabled,
      actAs: this.actAsIdentity,
    };
  }
}

/** Builder for a FORGET request (defaults to a soft forget; `.hard()` zeroes). */
export class ForgetBuilder {
  private mode: ForgetMode = ForgetMode.Soft;
  private actAsIdentity: ActAs | null = null;

  constructor(private readonly memoryId: bigint) {}

  hard(): this {
    this.mode = ForgetMode.Hard;
    return this;
  }

  withMode(mode: ForgetMode): this {
    this.mode = mode;
    return this;
  }

  /** Run this forget as an effective `(namespace, agentId)` on behalf of the
   * connection principal. Per-request; requires the connection's `canActAs`
   * grant server-side. */
  actAs(namespace: string, agentId: WireUuid): this {
    this.actAsIdentity = { namespace, agentId };
    return this;
  }

  /** Finish into a wire `ForgetRequest`, minting a fresh `requestId`. */
  build(): ForgetRequest {
    return {
      memoryId: this.memoryId,
      mode: this.mode,
      requestId: newId(),
      txnId: null,
      actAs: this.actAsIdentity,
    };
  }
}
