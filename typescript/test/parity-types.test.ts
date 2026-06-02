/**
 * Round-trip (encode -> decode -> deep-equal) for every wire type added to
 * reach verb parity with the Rust + Python SDKs: LINK/UNLINK, PLAN, REASON,
 * TXN, GET_CAPABILITIES, ENTITY/STATEMENT read-side views, RELATION views,
 * SCHEMA get/list/validate, and the SUBSCRIBE event union (cognitive +
 * typed-graph + edge + stage variants).
 *
 * These ops have no conformance corpus, so correctness rides on the encoders
 * mirroring the Rust structs field-for-field; a stable round-trip plus the
 * shared CBOR codec (already corpus-pinned) is the drift guard here.
 */

import { describe, expect, it } from "vitest";

import {
  EdgeKindWire,
  EventType,
  MemoryKindWire,
  PlanStatus,
  PlanStrategy,
  ReasonStatus,
  StageAuditStatus,
  StageKind,
  StageOutcome,
  decodeEntityGetResponse,
  decodeEntityList,
  decodeEntityListResponse,
  decodeGetCapabilitiesResponse,
  decodeLink,
  decodeLinkResponse,
  decodePlan,
  decodePlanResponse,
  decodeReason,
  decodeReasonResponse,
  decodeRelationListFrom,
  decodeRelationListFromResponse,
  decodeRelationListTo,
  decodeSchemaGet,
  decodeSchemaGetResponse,
  decodeSchemaList,
  decodeSchemaListResponse,
  decodeSchemaValidate,
  decodeSchemaValidateResponse,
  decodeStatementGet,
  decodeStatementGetResponse,
  decodeStatementList,
  decodeStatementListResponse,
  decodeSubscribe,
  decodeSubscriptionEvent,
  decodeTxnAbort,
  decodeTxnAbortResponse,
  decodeTxnBegin,
  decodeTxnBeginResponse,
  decodeTxnCommit,
  decodeTxnCommitResponse,
  decodeUnlink,
  decodeUnlinkResponse,
  decodeUnsubscribe,
  decodeUnsubscribeResponse,
  encodeEntityGetResponse,
  encodeEntityList,
  encodeEntityListResponse,
  encodeGetCapabilitiesResponse,
  encodeLink,
  encodeLinkResponse,
  encodePlan,
  encodePlanResponse,
  encodeReason,
  encodeReasonResponse,
  encodeRelationListFrom,
  encodeRelationListFromResponse,
  encodeRelationListTo,
  encodeSchemaGet,
  encodeSchemaGetResponse,
  encodeSchemaList,
  encodeSchemaListResponse,
  encodeSchemaValidate,
  encodeSchemaValidateResponse,
  encodeStatementGet,
  encodeStatementGetResponse,
  encodeStatementList,
  encodeStatementListResponse,
  encodeSubscribe,
  encodeSubscriptionEvent,
  encodeTxnAbort,
  encodeTxnAbortResponse,
  encodeTxnBegin,
  encodeTxnBeginResponse,
  encodeTxnCommit,
  encodeTxnCommitResponse,
  encodeUnlink,
  encodeUnlinkResponse,
  encodeUnsubscribe,
  encodeUnsubscribeResponse,
  type EntityView,
  type RelationView,
  type StatementView,
  type SubscriptionEvent,
} from "../src/wire/types.js";

const ID16 = (b: number): Uint8Array => new Uint8Array(16).fill(b);

/** Encode, decode, and assert structural equality. */
function rt<T>(encode: (v: T) => Uint8Array, decode: (b: Uint8Array) => T, value: T): void {
  const decoded = decode(encode(value));
  expect(decoded).toEqual(value);
}

const ENTITY_VIEW: EntityView = {
  entityId: ID16(0x11),
  entityTypeId: 7,
  canonicalName: "Ada Lovelace",
  normalizedName: "ada lovelace",
  aliases: ["Ada"],
  attributesBlob: new Uint8Array([1, 2, 3]),
  mentionCount: 4,
  createdAtUnixNanos: 100n,
  updatedAtUnixNanos: 200n,
  mergedInto: new Uint8Array(16),
  embeddingVersion: 2,
  flags: 0,
};

const STATEMENT_VIEW: StatementView = {
  statementId: ID16(0x22),
  kind: "Fact",
  subject: ID16(0x11),
  subjectPendingAuditId: new Uint8Array(16),
  predicate: "born_in",
  object: { kind: "Value", value: { kind: "Integer", value: 1815n } },
  confidence: 0.75,
  evidence: { kind: "Inline", ids: [ID16(0x44)] },
  extractorId: 0,
  extractedAtUnixNanos: 5n,
  schemaVersion: 1,
  validFromUnixNanos: 0n,
  validToUnixNanos: 0xffffffffffffffffn,
  eventAtUnixNanos: 0n,
  version: 1,
  supersededBy: new Uint8Array(16),
  supersedes: new Uint8Array(16),
  chainRoot: ID16(0x22),
  tombstoned: false,
  tombstonedAtUnixNanos: 0n,
  tombstoneReason: 0,
  flags: 0,
  isStateful: true,
};

const RELATION_VIEW: RelationView = {
  relationId: ID16(0x33),
  chainRoot: ID16(0x33),
  relationType: "collaborated_with",
  fromEntity: ID16(0x11),
  toEntity: ID16(0x55),
  propertiesBlob: new Uint8Array(0),
  evidence: { kind: "Overflow", id: ID16(0x66) },
  extractorId: 1,
  extractedAtUnixNanos: 9n,
  confidence: 0.25,
  validFromUnixNanos: 0n,
  validToUnixNanos: 0xffffffffffffffffn,
  version: 1,
  supersededBy: new Uint8Array(16),
  supersedes: new Uint8Array(16),
  tombstoned: false,
  tombstonedAtUnixNanos: 0n,
  flags: 1,
};

describe("LINK / UNLINK round-trip", () => {
  it("link request + response", () => {
    rt(encodeLink, decodeLink, {
      source: 1n,
      target: 2n,
      kind: EdgeKindWire.Caused,
      weight: 0.5,
      requestId: ID16(0xaa),
      txnId: null,
    });
    rt(encodeLinkResponse, decodeLinkResponse, {
      source: 1n,
      target: 2n,
      kind: EdgeKindWire.Caused,
      weight: 0.5,
      createdAtUnixNanos: 42n,
      alreadyExisted: false,
    });
  });

  it("unlink request + response", () => {
    rt(encodeUnlink, decodeUnlink, {
      source: 3n,
      target: 4n,
      kind: EdgeKindWire.Contradicts,
      requestId: ID16(0xbb),
      txnId: ID16(0xcc),
    });
    rt(encodeUnlinkResponse, decodeUnlinkResponse, {
      source: 3n,
      target: 4n,
      kind: EdgeKindWire.Contradicts,
      removed: true,
    });
  });
});

describe("PLAN round-trip", () => {
  it("request with each PlanState variant", () => {
    rt(encodePlan, decodePlan, {
      start: { kind: "ByMemoryId", memoryId: 10n },
      goal: { kind: "ByVector", offset: 0, dim: 384 },
      budget: { maxSteps: 8, maxWallTimeMs: 1000, maxBranchesExplored: 64 },
      strategyHint: PlanStrategy.AStar,
      contextFilter: [1n, 2n],
      requestId: ID16(0x01),
      txnId: null,
    });
    rt(encodePlan, decodePlan, {
      start: { kind: "ByText", text: "start" },
      goal: { kind: "ByText", text: "goal" },
      budget: { maxSteps: 4, maxWallTimeMs: 500, maxBranchesExplored: 16 },
      strategyHint: null,
      contextFilter: null,
      requestId: null,
      txnId: null,
    });
  });

  it("response frame with transition variants", () => {
    rt(encodePlanResponse, decodePlanResponse, {
      steps: [
        {
          stepIndex: 0,
          memoryId: 5n,
          text: "first",
          transitionKind: { kind: "Initial" },
          confidence: 1.0,
          estimatedDistanceToGoal: 0.75,
        },
        {
          stepIndex: 1,
          memoryId: 6n,
          text: "second",
          transitionKind: { kind: "Other", value: "jump" },
          confidence: 0.5,
          estimatedDistanceToGoal: 0.125,
        },
      ],
      isFinal: true,
      planStatus: PlanStatus.GoalReached,
    });
  });
});

describe("REASON round-trip", () => {
  it("request + response frame", () => {
    rt(encodeReason, decodeReason, {
      observation: { kind: "ByText", text: "the sky darkened" },
      depth: 3,
      confidenceThreshold: 0.5,
      contextFilter: [9n],
      maxInferences: 10,
      budgetWallTimeMs: 2000,
      requestId: ID16(0x02),
      txnId: null,
    });
    rt(encodeReasonResponse, decodeReasonResponse, {
      inferences: [
        {
          stepIndex: 0,
          claim: "it will rain",
          supportingMemories: [1n, 2n],
          contradictingMemories: [],
          confidence: 0.75,
          inferenceKind: { kind: "CausalExplanation" },
        },
        {
          stepIndex: 1,
          claim: "bring an umbrella",
          supportingMemories: [],
          contradictingMemories: [3n],
          confidence: 0.25,
          inferenceKind: { kind: "Other", value: "heuristic" },
        },
      ],
      isFinal: true,
      reasonStatus: ReasonStatus.Complete,
    });
  });
});

describe("TXN round-trip", () => {
  it("begin / commit / abort", () => {
    rt(encodeTxnBegin, decodeTxnBegin, { txnId: ID16(0x10), timeoutSeconds: 30 });
    rt(encodeTxnBeginResponse, decodeTxnBeginResponse, {
      txnId: ID16(0x10),
      timeoutSeconds: 30,
      startedAtUnixNanos: 999n,
    });
    rt(encodeTxnCommit, decodeTxnCommit, { txnId: ID16(0x10) });
    rt(encodeTxnCommitResponse, decodeTxnCommitResponse, {
      txnId: ID16(0x10),
      committedAtUnixNanos: 1000n,
      operationsApplied: 3,
    });
    rt(encodeTxnAbort, decodeTxnAbort, { txnId: ID16(0x10) });
    rt(encodeTxnAbortResponse, decodeTxnAbortResponse, {
      txnId: ID16(0x10),
      operationsDiscarded: 2,
    });
  });
});

describe("GET_CAPABILITIES round-trip", () => {
  it("response", () => {
    rt(encodeGetCapabilitiesResponse, decodeGetCapabilitiesResponse, {
      capabilities: {
        rerank: true,
        llmExtractor: false,
        classifierExtractor: true,
        patternExtractor: true,
        schemaNamespaces: ["people", "places"],
        vectorDim: 384,
      },
    });
  });
});

describe("ENTITY read-side round-trip", () => {
  it("get response + list request/response", () => {
    rt(encodeEntityGetResponse, decodeEntityGetResponse, { entity: ENTITY_VIEW });
    rt(encodeEntityList, decodeEntityList, {
      entityTypeId: 7,
      namePrefix: "Ada",
      mentionCountMin: 1,
      includeTombstoned: false,
      includeMerged: false,
      limit: 100,
      cursor: new Uint8Array(0),
    });
    rt(encodeEntityListResponse, decodeEntityListResponse, {
      items: [{ entity: ENTITY_VIEW }],
      nextCursor: new Uint8Array([9, 9]),
      cumulativeCount: 1,
      isFinal: true,
    });
  });
});

describe("STATEMENT read-side round-trip", () => {
  it("get request/response + list request/response", () => {
    rt(encodeStatementGet, decodeStatementGet, {
      statementId: ID16(0x22),
      followSupersession: true,
    });
    rt(encodeStatementGetResponse, decodeStatementGetResponse, {
      statement: STATEMENT_VIEW,
      returnedViaSupersession: true,
    });
    rt(encodeStatementList, decodeStatementList, {
      subject: ID16(0x11),
      predicate: "born_in",
      kind: 1,
      minConfidence: 0.5,
      timeRangeStartUnixNanos: 0n,
      timeRangeEndUnixNanos: 0n,
      onlyCurrent: true,
      includeTombstoned: false,
      limit: 50,
      cursor: new Uint8Array(0),
    });
    rt(encodeStatementListResponse, decodeStatementListResponse, {
      items: [STATEMENT_VIEW],
      nextCursor: new Uint8Array(0),
      cumulativeCount: 1,
      isFinal: true,
    });
  });
});

describe("RELATION read-side round-trip", () => {
  it("list-from + list-to request/response", () => {
    rt(encodeRelationListFrom, decodeRelationListFrom, {
      fromEntity: ID16(0x11),
      relationTypeFilter: "",
      timeRangeStartUnixNanos: 0n,
      timeRangeEndUnixNanos: 0n,
      includeSuperseded: false,
      includeTombstoned: false,
      limit: 25,
      cursor: new Uint8Array(0),
    });
    rt(encodeRelationListFromResponse, decodeRelationListFromResponse, {
      items: [RELATION_VIEW],
      nextCursor: new Uint8Array(0),
      cumulativeCount: 1,
      isFinal: true,
    });
    rt(encodeRelationListTo, decodeRelationListTo, {
      toEntity: ID16(0x55),
      relationTypeFilter: "collaborated_with",
      timeRangeStartUnixNanos: 1n,
      timeRangeEndUnixNanos: 2n,
      includeSuperseded: true,
      includeTombstoned: true,
      limit: 25,
      cursor: new Uint8Array([7]),
    });
  });
});

describe("SCHEMA read-side round-trip", () => {
  it("get / list / validate", () => {
    rt(encodeSchemaGet, decodeSchemaGet, { namespace: "people", version: 0 });
    rt(encodeSchemaGetResponse, decodeSchemaGetResponse, {
      namespace: "people",
      schemaVersion: 3,
      schemaDocument: "entity Person {}",
      sourceBlob: new Uint8Array([1, 2]),
      uploadedAtUnixNanos: 77n,
      validatorVersion: 1,
    });
    rt(encodeSchemaList, decodeSchemaList, {
      namespace: "people",
      limit: 0,
      cursor: new Uint8Array(0),
    });
    rt(encodeSchemaListResponse, decodeSchemaListResponse, {
      namespace: "people",
      items: [
        {
          schemaVersion: 3,
          uploadedAtUnixNanos: 77n,
          validatorVersion: 1,
          hasSourceText: true,
        },
      ],
      total: 1,
      nextCursor: new Uint8Array(0),
      isFinal: true,
    });
    rt(encodeSchemaValidate, decodeSchemaValidate, { schemaDocument: "entity Person {}" });
    rt(encodeSchemaValidateResponse, decodeSchemaValidateResponse, {
      namespace: "people",
      wouldBeVersion: 4,
      validationErrors: [
        { code: "E001", message: "bad", line: 1, column: 2, length: 3, severity: 1 },
      ],
    });
  });
});

describe("SUBSCRIBE round-trip", () => {
  it("subscribe request with filter", () => {
    rt(encodeSubscribe, decodeSubscribe, {
      filter: {
        contexts: [1n, 2n],
        kinds: [MemoryKindWire.Semantic],
        similarTo: { referenceMemoryId: 5n, threshold: 0.75 },
        agents: [ID16(0x01)],
      },
      includeHistory: true,
      fromLsn: 100n,
      maxInflight: 64,
    });
    rt(encodeSubscribe, decodeSubscribe, {
      filter: { contexts: null, kinds: null, similarTo: null, agents: null },
      includeHistory: false,
      fromLsn: null,
      maxInflight: 8,
    });
  });

  it("unsubscribe request + response", () => {
    rt(encodeUnsubscribe, decodeUnsubscribe, { targetStreamId: 5 });
    rt(encodeUnsubscribeResponse, decodeUnsubscribeResponse, {
      targetStreamId: 5,
      finalLsn: 999n,
    });
  });

  it("cognitive event (no graph/edge/stage payload)", () => {
    const ev: SubscriptionEvent = {
      eventType: EventType.Encoded,
      memoryId: 42n,
      contextId: 1n,
      text: "remembered",
      kind: MemoryKindWire.Episodic,
      salience: 0.5,
      timestampUnixNanos: 123n,
      lsn: 7n,
      graphPayload: null,
      edgePayload: null,
      stageKind: null,
      stageOutcome: null,
      stagePayload: null,
    };
    rt(encodeSubscriptionEvent, decodeSubscriptionEvent, ev);
  });

  it("typed-graph event (graph_payload populated)", () => {
    const ev: SubscriptionEvent = {
      eventType: EventType.EntityCreated,
      memoryId: 0n,
      contextId: 0n,
      text: "",
      kind: MemoryKindWire.Semantic,
      salience: 0.0,
      timestampUnixNanos: 1n,
      lsn: 2n,
      graphPayload: {
        kind: "EntityCreated",
        value: { entityId: ID16(0x11), entityTypeId: 7, canonicalName: "Ada" },
      },
      edgePayload: null,
      stageKind: null,
      stageOutcome: null,
      stagePayload: null,
    };
    rt(encodeSubscriptionEvent, decodeSubscriptionEvent, ev);
  });

  it("edge event (edge_payload populated)", () => {
    const ev: SubscriptionEvent = {
      eventType: EventType.EdgeAdded,
      memoryId: 0n,
      contextId: 0n,
      text: "",
      kind: MemoryKindWire.Semantic,
      salience: 0.0,
      timestampUnixNanos: 1n,
      lsn: 2n,
      graphPayload: null,
      edgePayload: {
        fromKind: 0,
        fromId: ID16(0x01),
        toKind: 1,
        toId: ID16(0x02),
        edgeKindTag: 2,
        edgeKindByte: 0,
        relationTypeId: 9,
        weight: 0.5,
        relationId: ID16(0x03),
        supersededRelationId: null,
        origin: 1,
      },
      stageKind: null,
      stageOutcome: null,
      stagePayload: null,
    };
    rt(encodeSubscriptionEvent, decodeSubscriptionEvent, ev);
  });

  it("stage-completed event (stage fields populated)", () => {
    const ev: SubscriptionEvent = {
      eventType: EventType.StageCompleted,
      memoryId: 42n,
      contextId: 1n,
      text: "",
      kind: MemoryKindWire.Episodic,
      salience: 0.0,
      timestampUnixNanos: 1n,
      lsn: 2n,
      graphPayload: null,
      edgePayload: null,
      stageKind: StageKind.Extractor,
      stageOutcome: StageOutcome.Ok,
      stagePayload: {
        kind: "Extractor",
        value: {
          entityCount: 2,
          statementCount: 3,
          relationCount: 1,
          auditStatus: StageAuditStatus.Succeeded,
          errorMessage: "",
        },
      },
    };
    rt(encodeSubscriptionEvent, decodeSubscriptionEvent, ev);
  });
});
