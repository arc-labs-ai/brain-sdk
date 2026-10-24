/**
 * PING must go out on stream 0.
 *
 * `ping()` used to travel the unary path, which allocates an odd op-stream id.
 * Brain classifies PING/PONG as connection-level alongside HELLO/AUTH/BYE and
 * refuses them anywhere but stream 0 with
 * `connection-level opcode requires stream_id = 0`, so the probe could never
 * complete a round trip against a real server.
 *
 * Only live traffic surfaced the bug — the rule lives in the server's dispatch
 * layer, and a mock answers a wrong-stream PING quite happily. What a mock
 * *can* pin is the stream id the client chose, which is exactly the thing that
 * was wrong. This test asserts it directly so the fix cannot quietly revert.
 */

import * as net from "node:net";
import { describe, expect, it } from "vitest";

import { BrainClient } from "../../src/client.js";
import { FrameChannel } from "../../src/transport.js";
import { FLAG_EOS } from "../../src/wire/frame.js";
import { Opcode } from "../../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type WelcomePayload,
  decodeAuth,
  decodePing,
  encodeAuthOk,
  encodePong,
  encodeWelcome,
  decodeHello,
} from "../../src/wire/types.js";
import { SERVER_AGENT_ID } from "../common/_auth.js";

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

/** The stream id the mock saw the PING arrive on. */
let pingStreamId = -1;

async function servePing(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);

  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    connectionId: new Uint8Array(16).fill(0xab),
    capabilities: hello.capabilities,
    serverFeatures: {
      maxPayloadSize: 1 << 20,
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
  decodeAuth(authFrame.payload);
  const authOk: AuthOkPayload = {
    spaceId: SERVER_AGENT_ID,
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
  await chan.write({
    opcode: Opcode.AuthOk,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeAuthOk(authOk),
  });

  const pingFrame = await chan.read();
  pingStreamId = pingFrame.streamId;
  const ping = decodePing(pingFrame.payload);
  await chan.write({
    opcode: Opcode.Pong,
    flags: FLAG_EOS,
    // Echo on whatever stream it arrived on, so a wrong-stream PING still
    // round-trips here and the assertion below is the only thing that fails.
    streamId: pingFrame.streamId,
    payload: encodePong({
      clientTimestampUnixNanos: ping.clientTimestampUnixNanos,
      serverTimestampUnixNanos: 123n,
    }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

describe("ping", () => {
  it("travels on the connection stream, not an op stream", async () => {
    const { server, port } = await startServer(servePing);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, {
        auth: { kind: "token", token: new TextEncoder().encode("opaque-token") },
      });
      const pong = await client.ping();
      expect(pong.serverTimestampUnixNanos).toBe(123n);
      await client.close();

      expect(pingStreamId).toBe(0);
    } finally {
      server.close();
    }
  });
});
