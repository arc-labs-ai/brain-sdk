/**
 * Multiplexed-connection concurrency test: two ENCODE requests in flight at
 * once, answered by the server in *reverse* order, must each route back to the
 * right caller by `streamId`. Proves the data-pump demux, not just a single
 * round-trip.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { MuxConnection } from "../src/mux.js";
import { newId } from "../src/client.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type AuthPayload,
  type EncodeRequest,
  type EncodeResponse,
  type HelloPayload,
  MemoryKindWire,
  type WelcomePayload,
  decodeAuth,
  decodeEncode,
  decodeEncodeResponse,
  decodeHello,
  encodeAuthOk,
  encodeEncode,
  encodeEncodeResponse,
  encodeWelcome,
} from "../src/wire/types.js";

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

function encodeResponse(req: EncodeRequest, agentId: Uint8Array): EncodeResponse {
  return {
    memoryId: req.contextId,
    wasDeduplicated: false,
    salience: 0.5,
    autoEdgesAdded: 0,
    lsn: 1n,
    agentId,
    contextId: req.contextId,
    kind: req.kind,
    createdAtUnixNanos: 1n,
    edgesOutCount: 0,
    embeddingModelFp: new Uint8Array(16),
    pendingStages: [],
    hasActiveSchema: true,
  };
}

function encodeRequest(contextId: bigint): EncodeRequest {
  return {
    text: `memory ${contextId}`,
    contextId,
    kind: MemoryKindWire.Semantic,
    salienceHint: 0.5,
    edges: [],
    requestId: newId(),
    txnId: null,
    deduplicate: true,
  };
}

/** Stream ids the mock server observed on inbound client op frames. */
const observedStreamIds: number[] = [];

/** Handshake, read BOTH ENCODE requests, then reply in reverse receipt order. */
async function serveTwoConcurrent(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);

  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    sessionId: new Uint8Array(16).fill(0xab),
    capabilities: hello.capabilities,
    serverFeatures: {
      maxPayloadSize: 1 << 20,
      maxConcurrentStreams: 256,
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
      canAdmin: false,
    },
    serverTimeUnixNanos: 1n,
  };
  await chan.write({ opcode: Opcode.AuthOk, flags: FLAG_EOS, streamId: 0, payload: encodeAuthOk(authOk) });

  // Read both requests before answering either, then answer in reverse order.
  const f1 = await chan.read();
  observedStreamIds.push(f1.streamId);
  const r1 = decodeEncode(f1.payload);
  const f2 = await chan.read();
  observedStreamIds.push(f2.streamId);
  const r2 = decodeEncode(f2.payload);

  await chan.write({
    opcode: Opcode.EncodeResp,
    flags: FLAG_EOS,
    streamId: f2.streamId,
    payload: encodeEncodeResponse(encodeResponse(r2, auth.agentId)),
  });
  await chan.write({
    opcode: Opcode.EncodeResp,
    flags: FLAG_EOS,
    streamId: f1.streamId,
    payload: encodeEncodeResponse(encodeResponse(r1, auth.agentId)),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

describe("mux connection", () => {
  it("two requests in flight route back correctly despite reverse-order replies", async () => {
    const { server, port } = await startServer(serveTwoConcurrent);
    try {
      const hello: HelloPayload = {
        clientId: "mux-test",
        supportedVersions: [1],
        capabilities: { streaming: true, compressionZstd: false, serverPush: false },
        clientSessionToken: null,
      };
      const agentId = newId();
      const auth: AuthPayload = {
        method: 2, // AuthMethod.None
        agentId,
        credentials: { kind: "None" },
      };
      const { conn, outcome } = await MuxConnection.connect("127.0.0.1", port, hello, auth);
      expect(outcome.welcome.chosenVersion).toBe(1);

      // Fire both concurrently on the shared connection.
      const [fa, fb] = await Promise.all([
        conn.requestOne(Opcode.EncodeReq, encodeEncode(encodeRequest(100n))),
        conn.requestOne(Opcode.EncodeReq, encodeEncode(encodeRequest(200n))),
      ]);

      const ra = decodeEncodeResponse(fa.payload);
      const rb = decodeEncodeResponse(fb.payload);
      // Despite reverse-order replies, each response routed to its request.
      expect(ra.memoryId).toBe(100n);
      expect(ra.contextId).toBe(100n);
      expect(rb.memoryId).toBe(200n);
      expect(rb.contextId).toBe(200n);

      await conn.sendBye();
      conn.close();

      // Client op streams MUST be non-zero and ODD (the server rejects
      // even/zero as BadFrame). Two requests on the one connection step the
      // allocator by 2, staying odd: 1, 3.
      expect(observedStreamIds.length).toBe(2);
      for (const id of observedStreamIds) {
        expect(id).not.toBe(0);
        expect(id % 2).toBe(1);
      }
      expect(observedStreamIds).toEqual([1, 3]);
    } finally {
      server.close();
    }
  });
});
