/**
 * Verb round-trip tests: RECALL streaming and FORGET against an in-process
 * mock server, plus the ergonomic builders' defaults.
 *
 * RECALL is the streaming case: the mock server replies with two `RECALL_RESP`
 * frames on the request's stream, the first without EOS and the second with it,
 * and the client must collect both and flatten their results.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient } from "../src/client.js";
import { SERVER_AGENT_ID, TEST_AUTH } from "./_auth.js";
import { ForgetBuilder, RecallBuilder } from "../src/verbs.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  ForgetMode,
  type ForgetResponse,
  MemoryKindWire,
  type MemoryResult,
  type RecallResponseFrame,
  type WelcomePayload,
  decodeAuth,
  decodeForget,
  decodeHello,
  decodeRecall,
  encodeAuthOk,
  encodeForgetResponse,
  encodeRecallResponse,
  encodeWelcome,
} from "../src/wire/types.js";

function sampleResult(tag: number, text: string): MemoryResult {
  return {
    memoryId: BigInt(tag),
    text,
    similarityScore: 0.9,
    confidence: 0.8,
    salience: 0.5,
    kind: MemoryKindWire.Semantic,
    agentId: new Uint8Array(16).fill(tag),
    contextId: 0n,
    createdAtUnixNanos: 1n,
    lastAccessedAtUnixNanos: 1n,
    edges: null,
    contributingRetrievers: [],
    fusedScore: 0.7,
    rerankScore: null,
    salienceInitial: 0.5,
    accessCount: 0,
    lsn: 1n,
    flags: 0,
    consolidatedAtUnixNanos: null,
    occurredAtUnixNanos: null,
    edgesOutCount: 0,
    edgesInCount: 0,
    graph: null,
  };
}

async function serveRecallForget(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);

  // Handshake.
  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    sessionId: new Uint8Array(16).fill(0xcd),
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
      canAdmin: false,
      canActAs: false,
    },
    namespace: "",
    serverTimeUnixNanos: 1n,
  };
  await chan.write({ opcode: Opcode.AuthOk, flags: FLAG_EOS, streamId: 0, payload: encodeAuthOk(authOk) });

  // RECALL: two streamed frames, EOS only on the second.
  const recallFrame = await chan.read();
  expect(recallFrame.opcode).toBe(Opcode.RecallReq);
  const recall = decodeRecall(recallFrame.payload);
  expect(recall.cueText).toBe("dark mode");
  const sid = recallFrame.streamId;

  const first: RecallResponseFrame = {
    answerKind: "Many",
    memories: [sampleResult(0xaa, "first hit")],
    isFinal: false,
    cumulativeCount: 1,
    estimatedRemaining: 1,
  };
  await chan.write({ opcode: Opcode.RecallResp, flags: 0, streamId: sid, payload: encodeRecallResponse(first) });

  const second: RecallResponseFrame = {
    answerKind: "Many",
    memories: [sampleResult(0xbb, "second hit")],
    isFinal: true,
    cumulativeCount: 2,
    estimatedRemaining: 0,
  };
  await chan.write({ opcode: Opcode.RecallResp, flags: FLAG_EOS, streamId: sid, payload: encodeRecallResponse(second) });

  // FORGET: single frame.
  const forgetFrame = await chan.read();
  expect(forgetFrame.opcode).toBe(Opcode.ForgetReq);
  const forget = decodeForget(forgetFrame.payload);
  const resp: ForgetResponse = {
    memoryId: forget.memoryId,
    wasAlreadyForgotten: false,
    edgesRemoved: 3,
  };
  await chan.write({
    opcode: Opcode.ForgetResp,
    flags: FLAG_EOS,
    streamId: forgetFrame.streamId,
    payload: encodeForgetResponse(resp),
  });

  // BYE.
  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

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

describe("verbs", () => {
  it("recall streams and flattens, then forget", async () => {
    const { server, port } = await startServer(serveRecallForget);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const answer = await client.recall(new RecallBuilder("dark mode").maxResults(5).build());
      expect(answer.answerKind).toBe("Many");
      expect(answer.memories.length).toBe(2);
      expect(answer.memories[0]!.text).toBe("first hit");
      expect(answer.memories[1]!.text).toBe("second hit");

      const resp = await client.forget(new ForgetBuilder(0xaan).build());
      expect(resp.memoryId).toBe(0xaan);
      expect(resp.edgesRemoved).toBe(3);

      await client.close();
    } finally {
      server.close();
    }
  });

  it("builder defaults are sane", () => {
    const recall = new RecallBuilder("hi").build();
    expect(recall.maxResults).toBe(10);
    expect(recall.includeText).toBe(true);
    expect(recall.includeEdges).toBe(true);
    expect(recall.txnId).toBeNull();
    expect(recall.requestId).not.toBeNull();

    const forget = new ForgetBuilder(7n).build();
    expect(forget.memoryId).toBe(7n);
    expect(forget.mode).toBe(ForgetMode.Soft);
    expect(new ForgetBuilder(7n).hard().build().mode).toBe(ForgetMode.Hard);
  });
});
