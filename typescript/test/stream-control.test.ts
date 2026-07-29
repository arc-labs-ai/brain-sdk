/**
 * SCHEMA_REPLACE and CANCEL_STREAM round-trips against an in-process mock
 * server.
 *
 * Neither verb is in the vendored conformance corpus, so unlike the rest of the
 * wire surface they have no byte-level drift guard. Until Brain regenerates the
 * corpus with them, this test is the only thing pinning their opcodes and
 * payload shapes — which is why it asserts the numeric opcode rather than the
 * enum, so a renumbering upstream fails here instead of silently.
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
  type CancelStreamAck,
  type SchemaReplaceResponse,
  type WelcomePayload,
  decodeAuth,
  decodeCancelStream,
  decodeHello,
  decodeSchemaReplace,
  encodeAuthOk,
  encodeCancelStreamAck,
  encodeSchemaReplaceResponse,
  encodeWelcome,
} from "../src/wire/types.js";

/** The stream the client asks the server to stop. */
const TARGET_STREAM = 7;

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

async function serve(sock: net.Socket): Promise<void> {
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
      maxConcurrentStreams: 64,
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
      canAdmin: true,
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

  // SCHEMA_REPLACE.
  let f = await chan.read();
  expect(f.opcode, "SCHEMA_REPLACE opcode").toBe(0x0127);
  const replaceReq = decodeSchemaReplace(f.payload);
  expect(replaceReq.schemaDocument).toBe("entity Person {}");
  expect(
    replaceReq.forceDropExisting,
    "the SDK must not send forceDropExisting=false — the server rejects it",
  ).toBe(true);
  const replaceResp: SchemaReplaceResponse = {
    namespace: "app",
    schemaVersion: 4,
    droppedCount: 129,
    validationErrors: [],
  };
  await chan.write({
    opcode: Opcode.SchemaReplaceResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeSchemaReplaceResponse(replaceResp),
  });

  // CANCEL_STREAM — rides its own stream id, names the target in the body.
  f = await chan.read();
  expect(f.opcode, "CANCEL_STREAM opcode").toBe(0x0050);
  const cancelReq = decodeCancelStream(f.payload);
  expect(cancelReq.targetStreamId).toBe(TARGET_STREAM);
  expect(cancelReq.reason).toBe("ClientUnneeded");
  expect(
    f.streamId,
    "cancel must not ride the stream it is cancelling, or it queues behind the very frames it is trying to stop",
  ).not.toBe(TARGET_STREAM);
  const ack: CancelStreamAck = {
    targetStreamId: TARGET_STREAM,
    cancelledAtUnixNanos: 1234n,
  };
  await chan.write({
    opcode: Opcode.CancelStreamAck,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeCancelStreamAck(ack),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
}

describe("stream control", () => {
  it("round-trip SCHEMA_REPLACE and CANCEL_STREAM", async () => {
    const { server, port } = await startServer(serve);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const replaced = await client.replaceSchema({
        schemaDocument: "entity Person {}",
        forceDropExisting: true,
        requestId: newId(),
      });
      expect(replaced.schemaVersion).toBe(4);
      expect(
        replaced.droppedCount,
        "droppedCount is the whole point of the verb — it is how a caller learns how much the swap destroyed",
      ).toBe(129);

      const ack = await client.cancelStream(TARGET_STREAM);
      expect(ack.targetStreamId).toBe(TARGET_STREAM);
      expect(ack.cancelledAtUnixNanos).toBe(1234n);

      await client.close();
    } finally {
      server.close();
    }
  });
});
