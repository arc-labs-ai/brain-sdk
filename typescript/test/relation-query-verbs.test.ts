/**
 * Round-trips for the data-plane verbs added to reach parity with the Rust SDK:
 * ENCODE_VECTOR_DIRECT, the relation lifecycle (RELATION_GET / SUPERSEDE /
 * TOMBSTONE / TRAVERSE), and the query debug surface (QUERY_EXPLAIN /
 * QUERY_TRACE). Each is driven over one connection against an in-process mock
 * server that decodes the request and encodes a reply, so the test exercises
 * both the client verb wiring and every new codec end to end.
 *
 * These ops have no conformance corpus, so correctness rides on the codecs
 * mirroring the Rust structs field-for-field; a stable request-decode /
 * response-decode round-trip over the shared (corpus-pinned) CBOR codec is the
 * drift guard here.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient, newId } from "../src/client.js";
import { SERVER_AGENT_ID, TEST_AUTH } from "./_auth.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type EncodeResponse,
  MemoryKindWire,
  type QueryExplainResponse,
  type QueryTraceResponse,
  type RelationGetResponse,
  type RelationSupersedeResponse,
  type RelationTombstoneResponse,
  type RelationTraverseResponseFrame,
  type RelationView,
  type WelcomePayload,
  decodeAuth,
  decodeEncodeVectorDirect,
  decodeHello,
  decodeQueryExplain,
  decodeQueryTrace,
  decodeRelationGet,
  decodeRelationSupersede,
  decodeRelationTombstone,
  decodeRelationTraverse,
  encodeAuthOk,
  encodeEncodeResponse,
  encodeQueryExplainResponse,
  encodeQueryTraceResponse,
  encodeRelationGetResponse,
  encodeRelationSupersedeResponse,
  encodeRelationTombstoneResponse,
  encodeRelationTraverseResponse,
  encodeWelcome,
} from "../src/wire/types.js";

const ENTITY_ID = new Uint8Array(16).fill(0x11);
const RELATION_ID = new Uint8Array(16).fill(0x33);
const NEW_RELATION_ID = new Uint8Array(16).fill(0x44);

const RELATION_VIEW: RelationView = {
  relationId: RELATION_ID,
  chainRoot: RELATION_ID,
  relationType: "collaborated_with",
  fromEntity: ENTITY_ID,
  toEntity: new Uint8Array(16).fill(0x66),
  propertiesBlob: new Uint8Array(0),
  evidence: { kind: "Inline", ids: [] },
  extractorId: 1,
  extractedAtUnixNanos: 9n,
  confidence: 0.8,
  validFromUnixNanos: 0n,
  validToUnixNanos: 0xffffffffffffffffn,
  version: 2,
  supersededBy: new Uint8Array(16),
  supersedes: new Uint8Array(16),
  tombstoned: false,
  tombstonedAtUnixNanos: 0n,
  flags: 0,
};

function startServer(
  handler: (sock: net.Socket) => Promise<void>,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => void handler(sock));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

async function handshake(chan: FrameChannel): Promise<void> {
  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    sessionId: new Uint8Array(16).fill(0xab),
    capabilities: hello.capabilities,
    serverFeatures: {
      maxPayloadSize: 1 << 20,
      maxConcurrentStreams: 64,
      idleTimeoutSeconds: 300,
      authMethods: [],
    },
  };
  await chan.write({ opcode: Opcode.Welcome, flags: FLAG_EOS, streamId: 0, payload: encodeWelcome(welcome) });

  const authFrame = await chan.read();
  decodeAuth(authFrame.payload);
  const authOk: AuthOkPayload = {
    agentId: SERVER_AGENT_ID,
    boundShardId: 0,
    permissions: {
      canEncode: true,
      canRecall: true,
      canPlan: true,
      canReason: true,
      canForget: true,
      canAdmin: true,
    },
    namespace: "",
    serverTimeUnixNanos: 1n,
  };
  await chan.write({ opcode: Opcode.AuthOk, flags: FLAG_EOS, streamId: 0, payload: encodeAuthOk(authOk) });
}

async function serve(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  // ENCODE_VECTOR_DIRECT.
  let f = await chan.read();
  expect(f.opcode).toBe(Opcode.EncodeVectorDirectReq);
  const evd = decodeEncodeVectorDirect(f.payload);
  expect(evd.text).toBe("pre-embedded");
  expect(evd.vector).toEqual([0.5, -0.25, 1.0]);
  const encResp: EncodeResponse = {
    memoryId: 7n,
    wasDeduplicated: false,
    salience: 0.5,
    autoEdgesAdded: 0,
    lsn: 1n,
    agentId: SERVER_AGENT_ID,
    contextId: 0n,
    kind: MemoryKindWire.Semantic,
    createdAtUnixNanos: 5n,
    edgesOutCount: 0,
    embeddingModelFp: new Uint8Array(16),
    pendingStages: [],
    hasActiveSchema: true,
  };
  await chan.write({ opcode: Opcode.EncodeVectorDirectResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeEncodeResponse(encResp) });

  // RELATION_GET.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.RelationGetReq);
  expect(decodeRelationGet(f.payload).followSupersession).toBe(true);
  const getResp: RelationGetResponse = { relation: RELATION_VIEW, returnedViaSupersession: true };
  await chan.write({ opcode: Opcode.RelationGetResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeRelationGetResponse(getResp) });

  // RELATION_SUPERSEDE.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.RelationSupersedeReq);
  expect(decodeRelationSupersede(f.payload).newRelation.relationType).toBe("mentored");
  const supResp: RelationSupersedeResponse = { newRelationId: NEW_RELATION_ID, version: 3 };
  await chan.write({ opcode: Opcode.RelationSupersedeResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeRelationSupersedeResponse(supResp) });

  // RELATION_TOMBSTONE.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.RelationTombstoneReq);
  expect(decodeRelationTombstone(f.payload).reason).toBe("merged away");
  const tombResp: RelationTombstoneResponse = { tombstonedAtUnixNanos: 123n };
  await chan.write({ opcode: Opcode.RelationTombstoneResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeRelationTombstoneResponse(tombResp) });

  // RELATION_TRAVERSE (streamed; single EOS frame).
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.RelationTraverseReq);
  expect(decodeRelationTraverse(f.payload).maxDepth).toBe(2);
  const travResp: RelationTraverseResponseFrame = {
    paths: [
      {
        steps: [
          {
            relationId: RELATION_ID,
            from: ENTITY_ID,
            to: new Uint8Array(16).fill(0x66),
            relationType: "collaborated_with",
            depth: 1,
          },
        ],
      },
    ],
    totalPaths: 1,
    truncated: false,
    isFinal: true,
  };
  await chan.write({ opcode: Opcode.RelationTraverseResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeRelationTraverseResponse(travResp) });

  // QUERY_EXPLAIN.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.QueryExplainReq);
  expect(decodeQueryExplain(f.payload).query.text).toBe("who mentored whom");
  const explainResp: QueryExplainResponse = { planText: "semantic ∪ graph", estimatedCostMs: 1.25 };
  await chan.write({ opcode: Opcode.QueryExplainResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeQueryExplainResponse(explainResp) });

  // QUERY_TRACE.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.QueryTraceReq);
  expect(decodeQueryTrace(f.payload).query.text).toBe("trace me");
  const traceResp: QueryTraceResponse = { traceText: "stage: semantic 0.4ms", totalLatencyMs: 2.5 };
  await chan.write({ opcode: Opcode.QueryTraceResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeQueryTraceResponse(traceResp) });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

const QUERY_BASE = {
  entityAnchor: null,
  kindFilter: [],
  predicateFilter: [],
  timeFilter: null,
  asOfRecordTimeUnixNanos: null,
  confidenceMin: null,
  includeTombstoned: false,
  includeSuperseded: false,
  limit: 10,
  retrievers: { kind: "Auto" as const },
  fusionConfig: null,
};

describe("relation lifecycle + query variant verbs", () => {
  it("round-trip ENCODE_VECTOR_DIRECT / RELATION_* / QUERY_*", async () => {
    const { server, port } = await startServer(serve);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const enc = await client.encodeVectorDirect({
        text: "pre-embedded",
        vector: [0.5, -0.25, 1.0],
        modelFingerprint: new Uint8Array(16).fill(0x01),
        contextId: 0n,
        kind: MemoryKindWire.Semantic,
        salienceHint: 0.5,
        edges: [],
        requestId: newId(),
        txnId: null,
        deduplicate: false,
      });
      expect(enc.memoryId).toBe(7n);

      const got = await client.getRelation({ relationId: RELATION_ID, followSupersession: true });
      expect(got.returnedViaSupersession).toBe(true);
      expect([...got.relation.relationId]).toEqual([...RELATION_ID]);

      const sup = await client.supersedeRelation({
        oldRelationId: RELATION_ID,
        newRelation: {
          relationType: "mentored",
          fromEntity: ENTITY_ID,
          toEntity: new Uint8Array(16).fill(0x66),
          propertiesBlob: new Uint8Array(0),
          evidence: { kind: "Inline", ids: [] },
          extractorId: 0,
          confidence: 0.9,
          validFromUnixNanos: 0n,
          validToUnixNanos: 0xffffffffffffffffn,
          requestId: newId(),
        },
        requestId: newId(),
      });
      expect([...sup.newRelationId]).toEqual([...NEW_RELATION_ID]);
      expect(sup.version).toBe(3);

      const tomb = await client.tombstoneRelation({
        relationId: RELATION_ID,
        reason: "merged away",
        requestId: newId(),
      });
      expect(tomb.tombstonedAtUnixNanos).toBe(123n);

      const paths = await client.traverseRelations({
        startEntity: ENTITY_ID,
        relationTypes: ["collaborated_with"],
        direction: 2,
        maxDepth: 2,
        maxNodes: 100,
        timeAtUnixNanos: 0n,
        includeSuperseded: false,
        requestId: newId(),
      });
      expect(paths.length).toBe(1);
      expect(paths[0]!.steps[0]!.relationType).toBe("collaborated_with");

      const explain = await client.queryExplain({
        query: { text: "who mentored whom", requestId: newId(), ...QUERY_BASE },
      });
      expect(explain.planText).toBe("semantic ∪ graph");
      expect(explain.estimatedCostMs).toBeCloseTo(1.25);

      const trace = await client.queryTrace({
        query: { text: "trace me", requestId: newId(), ...QUERY_BASE },
      });
      expect(trace.traceText).toBe("stage: semantic 0.4ms");
      expect(trace.totalLatencyMs).toBeCloseTo(2.5);

      await client.close();
    } finally {
      server.close();
    }
  });
});
