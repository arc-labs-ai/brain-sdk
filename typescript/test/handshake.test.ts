/**
 * Handshake + round-trip tests.
 *
 * Each test stands up an in-process mock server on a loopback socket that
 * speaks the server side of the protocol (HELLO -> WELCOME -> AUTH -> AUTH_OK,
 * then one ENCODE -> ENCODE_RESP, then BYE) and drives a real `BrainClient`
 * against it — exercising the TCP connect, transport, handshake, and
 * request/response paths without needing a Linux `brain-server`.
 *
 * `live server handshake` runs the same flow against a real server when
 * `BRAIN_TEST_ADDR=host:port` is set, and is skipped otherwise.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient, newId } from "../src/client.js";
import { VersionMismatch } from "../src/errors.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type EncodeResponse,
  type EncodeRequest,
  MemoryKindWire,
  StageKind,
  type WelcomePayload,
  decodeAuth,
  decodeEncode,
  decodeHello,
  encodeAuthOk,
  encodeEncodeResponse,
  encodeWelcome,
} from "../src/wire/types.js";

const MEMORY_ID = 0x0102030405060708090a0b0c0d0e0f10n;
const SESSION_ID = new Uint8Array(16).fill(0xab);

function startServer(
  handler: (sock: net.Socket) => Promise<void>,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      void handler(sock);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

async function serveOne(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);

  const helloFrame = await chan.read();
  expect(helloFrame.opcode).toBe(Opcode.Hello);
  const hello = decodeHello(helloFrame.payload);
  expect(hello.supportedVersions).toContain(1);

  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    sessionId: SESSION_ID,
    capabilities: hello.capabilities,
    serverFeatures: {
      maxPayloadSize: 16 * 1024 * 1024,
      maxConcurrentStreams: 256,
      idleTimeoutSeconds: 300,
      authMethods: [],
    },
  };
  await chan.write({
    opcode: Opcode.Welcome,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeWelcome(welcome),
  });

  const authFrame = await chan.read();
  expect(authFrame.opcode).toBe(Opcode.Auth);
  const auth = decodeAuth(authFrame.payload);

  const authOk: AuthOkPayload = {
    agentId: auth.agentId,
    boundShardId: 3,
    permissions: {
      canEncode: true,
      canRecall: true,
      canPlan: true,
      canReason: true,
      canForget: true,
      canAdmin: false,
    },
    serverTimeUnixNanos: 1_700_000_000_000_000_000n,
  };
  await chan.write({
    opcode: Opcode.AuthOk,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeAuthOk(authOk),
  });

  const encFrame = await chan.read();
  expect(encFrame.opcode).toBe(Opcode.EncodeReq);
  const enc = decodeEncode(encFrame.payload);

  const resp: EncodeResponse = {
    memoryId: MEMORY_ID,
    wasDeduplicated: false,
    salience: 0.75,
    autoEdgesAdded: 0,
    lsn: 42n,
    agentId: auth.agentId,
    contextId: enc.contextId,
    kind: enc.kind,
    createdAtUnixNanos: 1_700_000_000_000_000_001n,
    edgesOutCount: 0,
    embeddingModelFp: new Uint8Array(16).fill(0x22),
    pendingStages: [StageKind.AutoEdge, StageKind.Extractor],
    hasActiveSchema: true,
  };
  await chan.write({
    opcode: Opcode.EncodeResp,
    flags: FLAG_EOS,
    streamId: encFrame.streamId,
    payload: encodeEncodeResponse(resp),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

function sampleEncodeRequest(): EncodeRequest {
  return {
    text: "the user prefers dark mode",
    contextId: 9n,
    kind: MemoryKindWire.Semantic,
    salienceHint: 0.5,
    edges: [],
    requestId: newId(),
    txnId: null,
    deduplicate: true,
  };
}

describe("connection / handshake", () => {
  it("connect + handshake + encode round-trip against a mock server", async () => {
    const { server, port } = await startServer(serveOne);
    try {
      const client = await BrainClient.connect("127.0.0.1", port);

      const s = client.session;
      expect(s.chosenVersion).toBe(1);
      expect(s.serverId).toBe("mock-brain");
      expect(s.boundShardId).toBe(3);
      expect([...s.sessionId]).toEqual([...SESSION_ID]);
      expect(s.permissions.canEncode).toBe(true);
      expect(s.permissions.canAdmin).toBe(false);
      expect(s.serverFeatures.maxConcurrentStreams).toBe(256);

      const req = sampleEncodeRequest();
      const resp = await client.encode(req);
      expect(resp.memoryId).toBe(MEMORY_ID);
      expect(resp.lsn).toBe(42n);
      expect(resp.contextId).toBe(req.contextId);
      expect([...resp.agentId]).toEqual([...client.agentId]);
      expect(resp.pendingStages).toEqual([StageKind.AutoEdge, StageKind.Extractor]);

      await client.close();
    } finally {
      server.close();
    }
  });

  it("rejects a server that chooses an unoffered version", async () => {
    const { server, port } = await startServer(async (sock) => {
      const chan = new FrameChannel(sock);
      const helloFrame = await chan.read();
      const hello = decodeHello(helloFrame.payload);
      const welcome: WelcomePayload = {
        serverId: "mock-brain",
        chosenVersion: 99, // never offered by the client
        sessionId: new Uint8Array(16),
        capabilities: hello.capabilities,
        serverFeatures: {
          maxPayloadSize: 0,
          maxConcurrentStreams: 0,
          idleTimeoutSeconds: 0,
          authMethods: [],
        },
      };
      await chan.write({
        opcode: Opcode.Welcome,
        flags: FLAG_EOS,
        streamId: 0,
        payload: encodeWelcome(welcome),
      });
    });

    try {
      let caught: unknown;
      try {
        await BrainClient.connect("127.0.0.1", port);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(VersionMismatch);
      expect((caught as VersionMismatch).chosen).toBe(99);
    } finally {
      server.close();
    }
  });

  const liveAddr = process.env.BRAIN_TEST_ADDR;
  (liveAddr ? it : it.skip)("live server handshake", async () => {
    const idx = liveAddr!.lastIndexOf(":");
    const host = liveAddr!.slice(0, idx);
    const port = Number(liveAddr!.slice(idx + 1));
    const client = await BrainClient.connect(host, port);
    expect(client.session.chosenVersion).toBe(1);
    expect(client.session.permissions.canEncode).toBe(true);
    await client.close();
  });
});
