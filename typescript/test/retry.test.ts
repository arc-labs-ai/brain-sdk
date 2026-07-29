/**
 * Retry helper tests: backoff schedule (unit) and an integration round-trip
 * where a server returns a retryable `ResourceExhausted` ERROR once, then
 * succeeds — recovered transparently by `withRetry` wrapping a verb call, with
 * the *same* `requestId` resent both times (idempotent retry).
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient } from "../src/client.js";
import { SERVER_AGENT_ID, TEST_AUTH } from "./_auth.js";
import { ServerError } from "../src/errors.js";
import { ForgetBuilder } from "../src/verbs.js";
import { backoffMs, NO_RETRY, withRetry, type RetryPolicy } from "../src/retry.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS, type Frame } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  ErrorCategoryWire,
  type ErrorResponse,
  type ForgetResponse,
  type WelcomePayload,
  decodeAuth,
  decodeForget,
  decodeHello,
  encodeAuthOk,
  encodeError,
  encodeForgetResponse,
  encodeWelcome,
} from "../src/wire/types.js";

async function handshake(chan: FrameChannel): Promise<void> {
  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    connectionId: new Uint8Array(16).fill(0xee),
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

describe("retry policy", () => {
  it("exponential backoff doubles and caps", () => {
    const p: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffMs(p, 1, null)).toBe(100);
    expect(backoffMs(p, 2, null)).toBe(200);
    expect(backoffMs(p, 3, null)).toBe(400);
    expect(backoffMs(p, 4, null)).toBe(800);
    expect(backoffMs(p, 5, null)).toBe(1000); // 1600 capped
  });

  it("server retryAfter overrides and is capped", () => {
    const p: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2000 };
    expect(backoffMs(p, 1, 500)).toBe(500);
    expect(backoffMs(p, 1, 99_000)).toBe(2000);
  });

  it("NO_RETRY is a single attempt with no backoff", () => {
    expect(NO_RETRY.maxAttempts).toBe(1);
    expect(backoffMs(NO_RETRY, 1, null)).toBeNull();
  });
});

describe("withRetry integration", () => {
  it("recovers a ResourceExhausted forget and resends the same requestId", async () => {
    let firstRequestId: Uint8Array | undefined;
    const { server, port } = await startServer(async (sock) => {
      const chan = new FrameChannel(sock);
      await handshake(chan);

      const first = await chan.read();
      expect(first.opcode).toBe(Opcode.ForgetReq);
      firstRequestId = decodeForget(first.payload).requestId;
      const err: ErrorResponse = {
        code: 0x0073,
        category: ErrorCategoryWire.ResourceExhausted,
        message: "slow down",
        details: null,
        retryAfterMs: 5,
      };
      await chan.write({
        opcode: Opcode.Error,
        flags: FLAG_EOS,
        streamId: first.streamId,
        payload: encodeError(err),
      });

      const second = await chan.read();
      expect(second.opcode).toBe(Opcode.ForgetReq);
      const secondReq = decodeForget(second.payload);
      // Same request_id proves the retry is idempotent.
      expect([...secondReq.requestId]).toEqual([...firstRequestId]);
      const resp: ForgetResponse = {
        memoryId: secondReq.memoryId,
        wasAlreadyForgotten: false,
        edgesRemoved: 1,
      };
      await chan.write({
        opcode: Opcode.ForgetResp,
        flags: FLAG_EOS,
        streamId: second.streamId,
        payload: encodeForgetResponse(resp),
      });

      const bye = await chan.read();
      expect(bye.opcode).toBe(Opcode.Bye);
      sock.end();
    });

    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });
      const req = new ForgetBuilder(0xbeefn).build();
      const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
      const resp = await withRetry(() => client.forget(req), policy);
      expect(resp.memoryId).toBe(0xbeefn);
      expect(resp.edgesRemoved).toBe(1);
      await client.close();
    } finally {
      server.close();
    }
  });

  it("gives up after maxAttempts and surfaces the server error", async () => {
    const { server, port } = await startServer(async (sock) => {
      const chan = new FrameChannel(sock);
      await handshake(chan);
      for (;;) {
        let frame: Frame;
        try {
          frame = await chan.read();
        } catch {
          return;
        }
        if (frame.opcode === Opcode.Bye) return;
        const err: ErrorResponse = {
          code: 0x0091,
          category: ErrorCategoryWire.Unavailable,
          message: "busy",
          details: null,
          retryAfterMs: null,
        };
        await chan.write({
          opcode: Opcode.Error,
          flags: FLAG_EOS,
          streamId: frame.streamId,
          payload: encodeError(err),
        });
      }
    });

    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });
      const req = new ForgetBuilder(1n).build();
      const policy: RetryPolicy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
      let caught: unknown;
      try {
        await withRetry(() => client.forget(req), policy);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ServerError);
      expect((caught as ServerError).category).toBe(ErrorCategoryWire.Unavailable);
      await client.close();
    } finally {
      server.close();
    }
  });
});
