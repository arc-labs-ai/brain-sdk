/**
 * Connection-pool integration test: a pool of 3 opens 3 independent sockets,
 * and round-robin `get()` spreads requests across all three. The mock server
 * tags each accepted connection with its accept order and echoes that tag as
 * the ENCODE response's `memoryId`, so the client can prove which socket served
 * each request — three round-robin encodes must touch all three.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { newId } from "../src/client.js";
import { SERVER_AGENT_ID, TEST_AUTH } from "./_auth.js";
import { ProtocolError } from "../src/errors.js";
import { Pool } from "../src/pool.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type EncodeRequest,
  WaitMode,
  type EncodeResponse,
  MemoryKindWire,
  type WelcomePayload,
  decodeAuth,
  decodeEncode,
  decodeHello,
  encodeAuthOk,
  encodeEncodeResponse,
  encodeWelcome,
} from "../src/wire/types.js";

/** Serve one pooled connection, tagging its ENCODE replies with `tag`. */
async function serveMember(sock: net.Socket, tag: bigint): Promise<void> {
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

  for (;;) {
    let frame;
    try {
      frame = await chan.read();
    } catch {
      return;
    }
    if (frame.opcode === Opcode.Bye) return;
    if (frame.opcode !== Opcode.EncodeReq) continue;
    const req = decodeEncode(frame.payload);
    const resp: EncodeResponse = {
      memoryId: tag,
      wasDeduplicated: false,
      salience: 0.5,
      autoEdgesAdded: 0,
      lsn: 1n,
      agentId: SERVER_AGENT_ID,
      contextId: req.contextId,
      kind: MemoryKindWire.Semantic,
      createdAtUnixNanos: 1n,
      edgesOutCount: 0,
      embeddingModelFp: new Uint8Array(16),
      pendingStages: [],
      hasActiveSchema: true,
    };
    await chan.write({
      opcode: Opcode.EncodeResp,
      flags: FLAG_EOS,
      streamId: frame.streamId,
      payload: encodeEncodeResponse(resp),
    });
  }
}

function request(): EncodeRequest {
  return {
    text: "pooled",
    contextId: 1n,
    requestId: newId(),
    txnId: null,
    occurredAtUnixNanos: null,
    actAs: null,
    wait: WaitMode.Ack,
  };
}

describe("connection pool", () => {
  it("spreads requests across all members", async () => {
    const size = 3;
    const server = net.createServer();
    let accepted = 0;
    server.on("connection", (sock) => {
      const tag = BigInt(accepted);
      accepted += 1;
      void serveMember(sock, tag);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const pool = await Pool.connect("127.0.0.1", port, size, { auth: TEST_AUTH });
      expect(pool.size()).toBe(size);

      // Three round-robin encodes should touch three distinct sockets, so the
      // returned memoryIds (each the serving socket's tag) cover {0n, 1n, 2n}.
      const seen = new Set<bigint>();
      for (let i = 0; i < size; i += 1) {
        const client = pool.get();
        const resp = await client.encode(request());
        seen.add(resp.memoryId);
      }
      expect([...seen].sort()).toEqual([0n, 1n, 2n]);
      await pool.close();
    } finally {
      server.close();
    }
  });

  it("rejects zero size", async () => {
    let caught: unknown;
    try {
      await Pool.connect("127.0.0.1", 1, 0, { auth: TEST_AUTH });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
  });
});
