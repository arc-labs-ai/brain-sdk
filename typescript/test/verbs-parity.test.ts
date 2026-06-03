/**
 * Mock-server drive for the verbs that bring the TS SDK to parity with the
 * Rust + Python SDKs: unary read/edge/txn ops, a streamed LIST verb, the
 * streamed PLAN verb, and a long-lived SUBSCRIBE stream.
 *
 * The subscribe case is the load-bearing one: the mock pushes two events, then
 * EOS-closes the event stream only after it sees UNSUBSCRIBE. The client must
 * drain both events, observe end-of-stream, and leave no route behind.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient } from "../src/client.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  EventType,
  MemoryKindWire,
  PlanStatus,
  ResolutionOutcomeWire,
  type WelcomePayload,
  decodeAuth,
  decodeHello,
  decodeUnsubscribe,
  encodeAuthOk,
  encodeEntityGetResponse,
  encodeEntityListResponse,
  encodeEntityResolveResponse,
  encodeGetCapabilitiesResponse,
  encodeLinkResponse,
  encodePlanResponse,
  encodeSubscriptionEvent,
  encodeTxnBeginResponse,
  encodeTxnCommitResponse,
  encodeUnsubscribeResponse,
  encodeWelcome,
} from "../src/wire/types.js";

const ENTITY_ID = new Uint8Array(16).fill(0x11);
const TXN_ID = new Uint8Array(16).fill(0x77);

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

async function handshake(chan: FrameChannel): Promise<Uint8Array> {
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
  const auth = decodeAuth(authFrame.payload);
  const authOk: AuthOkPayload = {
    agentId: auth.agentId,
    boundShardId: 0,
    permissions: {
      canEncode: true,
      canRecall: true,
      canPlan: true,
      canReason: true,
      canForget: true,
      canAdmin: true,
    },
    serverTimeUnixNanos: 1n,
  };
  await chan.write({ opcode: Opcode.AuthOk, flags: FLAG_EOS, streamId: 0, payload: encodeAuthOk(authOk) });
  return auth.agentId;
}

/** All client op streams the mock saw (must be non-zero + odd). */
const seenStreamIds: number[] = [];

async function serveUnaryAndStreamed(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  // GET_CAPABILITIES.
  let f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.GetCapabilitiesReq);
  await chan.write({
    opcode: Opcode.GetCapabilitiesResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeGetCapabilitiesResponse({
      capabilities: {
        rerank: true,
        llmExtractor: false,
        classifierExtractor: true,
        patternExtractor: true,
        schemaNamespaces: ["people"],
        vectorDim: 384,
      },
    }),
  });

  // ENTITY_GET.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.EntityGetReq);
  await chan.write({
    opcode: Opcode.EntityGetResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeEntityGetResponse({
      entity: {
        entityId: ENTITY_ID,
        entityTypeId: 7,
        canonicalName: "Ada Lovelace",
        normalizedName: "ada lovelace",
        aliases: [],
        attributesBlob: new Uint8Array(0),
        mentionCount: 1,
        createdAtUnixNanos: 1n,
        updatedAtUnixNanos: 1n,
        mergedInto: new Uint8Array(16),
        embeddingVersion: 1,
        flags: 0,
      },
    }),
  });

  // ENTITY_RESOLVE.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.EntityResolveReq);
  await chan.write({
    opcode: Opcode.EntityResolveResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeEntityResolveResponse({
      outcome: ResolutionOutcomeWire.Resolved,
      tier: 1,
      confidence: 1.0,
      resolvedEntity: ENTITY_ID,
      candidateIds: [],
      auditId: new Uint8Array(16),
    }),
  });

  // LINK.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.LinkReq);
  await chan.write({
    opcode: Opcode.LinkResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeLinkResponse({
      source: 1n,
      target: 2n,
      kind: 0,
      weight: 0.5,
      createdAtUnixNanos: 9n,
      alreadyExisted: false,
    }),
  });

  // TXN_BEGIN then TXN_COMMIT.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.TxnBegin);
  await chan.write({
    opcode: Opcode.TxnBeginResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeTxnBeginResponse({ txnId: TXN_ID, timeoutSeconds: 30, startedAtUnixNanos: 5n }),
  });
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.TxnCommit);
  await chan.write({
    opcode: Opcode.TxnCommitResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeTxnCommitResponse({ txnId: TXN_ID, committedAtUnixNanos: 6n, operationsApplied: 1 }),
  });

  // ENTITY_LIST — two streamed frames, EOS on the last.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.EntityListReq);
  const mkItem = (b: number) => ({
    entity: {
      entityId: new Uint8Array(16).fill(b),
      entityTypeId: 7,
      canonicalName: `e${b}`,
      normalizedName: `e${b}`,
      aliases: [],
      attributesBlob: new Uint8Array(0),
      mentionCount: 0,
      createdAtUnixNanos: 0n,
      updatedAtUnixNanos: 0n,
      mergedInto: new Uint8Array(16),
      embeddingVersion: 0,
      flags: 0,
    },
  });
  await chan.write({
    opcode: Opcode.EntityListResp,
    flags: 0,
    streamId: f.streamId,
    payload: encodeEntityListResponse({
      items: [mkItem(0x01)],
      nextCursor: new Uint8Array([1]),
      cumulativeCount: 1,
      isFinal: false,
    }),
  });
  await chan.write({
    opcode: Opcode.EntityListResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeEntityListResponse({
      items: [mkItem(0x02)],
      nextCursor: new Uint8Array(0),
      cumulativeCount: 2,
      isFinal: true,
    }),
  });

  // PLAN — single EOS frame with two steps.
  f = await chan.read();
  seenStreamIds.push(f.streamId);
  expect(f.opcode).toBe(Opcode.PlanReq);
  await chan.write({
    opcode: Opcode.PlanResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodePlanResponse({
      steps: [
        {
          stepIndex: 0,
          memoryId: 1n,
          text: "start",
          transitionKind: { kind: "Initial" },
          confidence: 1.0,
          estimatedDistanceToGoal: 0.5,
        },
        {
          stepIndex: 1,
          memoryId: 2n,
          text: "goal",
          transitionKind: { kind: "Causal" },
          confidence: 0.9,
          estimatedDistanceToGoal: 0.0,
        },
      ],
      isFinal: true,
      planStatus: PlanStatus.GoalReached,
    }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

async function serveSubscription(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  // SUBSCRIBE — note the stream id; push two events on it, no EOS yet.
  const sub = await chan.read();
  expect(sub.opcode).toBe(Opcode.SubscribeReq);
  expect(sub.streamId % 2).toBe(1);
  const evStream = sub.streamId;

  const mkEvent = (id: bigint) =>
    encodeSubscriptionEvent({
      eventType: EventType.Encoded,
      memoryId: id,
      contextId: 1n,
      text: `event ${id}`,
      kind: MemoryKindWire.Episodic,
      salience: 0.5,
      timestampUnixNanos: id,
      lsn: id,
      graphPayload: null,
      edgePayload: null,
      stageKind: null,
      stageOutcome: null,
      stagePayload: null,
    });
  await chan.write({ opcode: Opcode.SubscribeEvent, flags: 0, streamId: evStream, payload: mkEvent(1n) });
  await chan.write({ opcode: Opcode.SubscribeEvent, flags: 0, streamId: evStream, payload: mkEvent(2n) });

  // UNSUBSCRIBE arrives on a fresh stream; reply on it, then EOS-close the
  // event stream so the client's iterator terminates.
  const unsub = await chan.read();
  expect(unsub.opcode).toBe(Opcode.UnsubscribeReq);
  expect(decodeUnsubscribe(unsub.payload).targetStreamId).toBe(evStream);
  await chan.write({
    opcode: Opcode.UnsubscribeResp,
    flags: FLAG_EOS,
    streamId: unsub.streamId,
    payload: encodeUnsubscribeResponse({ targetStreamId: evStream, finalLsn: 2n }),
  });
  await chan.write({ opcode: Opcode.SubscribeEvent, flags: FLAG_EOS, streamId: evStream, payload: new Uint8Array(0) });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

describe("parity verbs over a mock server", () => {
  it("unary + streamed verbs round-trip, all op streams non-zero + odd", async () => {
    seenStreamIds.length = 0;
    const { server, port } = await startServer(serveUnaryAndStreamed);
    try {
      const client = await BrainClient.connect("127.0.0.1", port);

      const caps = await client.capabilities();
      expect(caps.capabilities.vectorDim).toBe(384);
      expect(caps.capabilities.rerank).toBe(true);

      const entity = await client.getEntity({ entityId: ENTITY_ID });
      expect(entity.entity.canonicalName).toBe("Ada Lovelace");

      const resolved = await client.resolveEntity({
        candidateName: "Ada Lovelace",
        context: "",
        entityTypeHint: 1,
        allowCreate: false,
        requestId: new Uint8Array(16),
      });
      expect(resolved.outcome).toBe(ResolutionOutcomeWire.Resolved);
      expect([...resolved.resolvedEntity]).toEqual([...ENTITY_ID]);

      const link = await client.link({
        source: 1n,
        target: 2n,
        kind: 0,
        weight: 0.5,
        requestId: new Uint8Array(16),
        txnId: null,
      });
      expect(link.alreadyExisted).toBe(false);

      const begun = await client.txnBegin({ txnId: TXN_ID, timeoutSeconds: 30 });
      expect([...begun.txnId]).toEqual([...TXN_ID]);
      const committed = await client.txnCommit({ txnId: TXN_ID });
      expect(committed.operationsApplied).toBe(1);

      const entities = await client.listEntities({
        entityTypeId: 0,
        namePrefix: "",
        mentionCountMin: 0,
        includeTombstoned: false,
        includeMerged: false,
        limit: 100,
        cursor: new Uint8Array(0),
      });
      expect(entities.length).toBe(2);
      expect(entities[0]!.entity.canonicalName).toBe("e1");
      expect(entities[1]!.entity.canonicalName).toBe("e2");

      const steps = await client.plan({
        start: { kind: "ByText", text: "start" },
        goal: { kind: "ByText", text: "goal" },
        budget: { maxSteps: 4, maxWallTimeMs: 100, maxBranchesExplored: 8 },
        strategyHint: null,
        contextFilter: null,
        requestId: null,
        txnId: null,
      });
      expect(steps.length).toBe(2);
      expect(steps[1]!.text).toBe("goal");

      await client.close();

      expect(seenStreamIds.length).toBeGreaterThan(1);
      for (const id of seenStreamIds) {
        expect(id).not.toBe(0);
        expect(id % 2).toBe(1);
      }
    } finally {
      server.close();
    }
  });

  it("subscription drains pushed events, then EOS-closes with no leaked route", async () => {
    const { server, port } = await startServer(serveSubscription);
    try {
      const client = await BrainClient.connect("127.0.0.1", port);

      const sub = await client.subscribe({
        filter: { contexts: null, kinds: null, similarTo: null, agents: null },
        includeHistory: false,
        fromLsn: null,
        maxInflight: 8,
      });

      const first = await sub.nextEvent();
      expect(first).not.toBeNull();
      expect(first!.memoryId).toBe(1n);
      const second = await sub.nextEvent();
      expect(second!.memoryId).toBe(2n);

      const resp = await sub.unsubscribe();
      expect(resp.targetStreamId).toBe(sub.streamId);
      expect(resp.finalLsn).toBe(2n);

      // The server EOS-closed the event stream; the next pull ends iteration.
      const done = await sub.nextEvent();
      expect(done).toBeNull();

      await client.close();
    } finally {
      server.close();
    }
  });

  it("for-await drains a subscription via the async iterator", async () => {
    const { server, port } = await startServer(serveSubscription);
    try {
      const client = await BrainClient.connect("127.0.0.1", port);
      const sub = await client.subscribe({
        filter: { contexts: null, kinds: null, similarTo: null, agents: null },
        includeHistory: false,
        fromLsn: null,
        maxInflight: 8,
      });

      const drained: bigint[] = [];
      // Drive unsubscribe out-of-band so the server EOS-closes after 2 events.
      const reader = (async () => {
        for await (const ev of sub) {
          drained.push(ev.memoryId);
          if (drained.length === 2) await sub.unsubscribe();
        }
      })();
      await reader;

      expect(drained).toEqual([1n, 2n]);
      await client.close();
    } finally {
      server.close();
    }
  });
});
