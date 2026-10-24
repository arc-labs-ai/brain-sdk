/**
 * Multiplexed-connection concurrency test: two ENCODE requests in flight at
 * once, answered by the server in *reverse* order, must each route back to the
 * right caller by `streamId`. Proves the data-pump demux, not just a single
 * round-trip.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { MuxConnection } from "../../src/mux.js";
import { BrainClient, newId } from "../../src/client.js";
import { BrainTimeout } from "../../src/errors.js";
import { EncodeBuilder, RecallBuilder } from "../../src/verbs.js";
import { SERVER_AGENT_ID, TEST_AUTH } from "../common/_auth.js";
import { FrameChannel } from "../../src/transport.js";
import { FLAG_EOS, type Frame } from "../../src/wire/frame.js";
import { Opcode } from "../../src/wire/opcode.js";
import {
  type AuthOkPayload,
  AuthMethod,
  type AuthPayload,
  type EncodeRequest,
  WaitMode,
  type EncodeResponse,
  type HelloPayload,
  MemoryKindWire,
  type WelcomePayload,
  decodeAuth,
  decodeClientPong,
  decodeEncode,
  decodeEncodeResponse,
  decodeHello,
  encodeAuthOk,
  encodeEncode,
  encodeEncodeResponse,
  encodeServerPing,
  encodeWelcome,
} from "../../src/wire/types.js";

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

function encodeResponse(req: EncodeRequest, spaceId: Uint8Array): EncodeResponse {
  return {
    memoryId: req.sessionId,
    wasDeduplicated: false,
    salience: 0.5,
    autoEdgesAdded: 0,
    lsn: 1n,
    spaceId,
    sessionId: req.sessionId,
    kind: MemoryKindWire.Semantic,
    createdAtUnixNanos: 1n,
    edgesOutCount: 0,
    embeddingModelFp: new Uint8Array(16),
    pendingStages: [],
    hasActiveSchema: true,
  };
}

function encodeRequest(sessionId: bigint): EncodeRequest {
  return {
    text: `memory ${sessionId}`,
    sessionId,
    requestId: newId(),
    txnId: null,
    occurredAtUnixNanos: null,
    actAs: null,
    wait: WaitMode.Ack,
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
  // Client sends a credential but no agent id; the server assigns one.
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
    payload: encodeEncodeResponse(encodeResponse(r2, SERVER_AGENT_ID)),
  });
  await chan.write({
    opcode: Opcode.EncodeResp,
    flags: FLAG_EOS,
    streamId: f1.streamId,
    payload: encodeEncodeResponse(encodeResponse(r1, SERVER_AGENT_ID)),
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
        clientConnectionToken: null,
      };
      const auth: AuthPayload = {
        method: AuthMethod.Token,
        credentials: { kind: "Token", token: new TextEncoder().encode("opaque-token") },
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
      expect(ra.sessionId).toBe(100n);
      expect(rb.memoryId).toBe(200n);
      expect(rb.sessionId).toBe(200n);

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

// ===========================================================================
// Keepalive: the server's idle-timer SERVER_PING must be answered by the data
// pump with a CLIENT_PONG on stream 0 (echoing the server timestamp), or the
// real server would reap the connection. The client issues no op — the
// auto-reply must come purely from the pump.
// ===========================================================================

async function serveKeepalive(sock: net.Socket, resolvePong: (f: Frame) => void): Promise<void> {
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

  // Idle-timer heartbeat.
  await chan.write({
    opcode: Opcode.ServerPing,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeServerPing({ serverTimestampUnixNanos: 0xdead_beefn }),
  });

  // The pump must answer with CLIENT_PONG on stream 0. This is the only frame
  // the client sends.
  const f = await chan.read();
  resolvePong(f);
  sock.end();
}

describe("mux keepalive", () => {
  it("answers SERVER_PING with CLIENT_PONG on stream 0", async () => {
    let resolvePong!: (f: Frame) => void;
    const pongSeen = new Promise<Frame>((r) => {
      resolvePong = r;
    });
    const { server, port } = await startServer((sock) => serveKeepalive(sock, resolvePong));
    try {
      const hello: HelloPayload = {
        clientId: "keepalive-test",
        supportedVersions: [1],
        capabilities: { streaming: true, compressionZstd: false, serverPush: false },
        clientConnectionToken: null,
      };
      const auth: AuthPayload = {
        method: AuthMethod.Token,
        credentials: { kind: "Token", token: new TextEncoder().encode("opaque-token") },
      };
      // Hold `conn` alive while the pump answers SERVER_PING.
      const { conn } = await MuxConnection.connect("127.0.0.1", port, hello, auth);
      const pong = await pongSeen;
      expect(pong.opcode).toBe(Opcode.ClientPong);
      expect(pong.streamId).toBe(0);
      expect(decodeClientPong(pong.payload).serverTimestampUnixNanos).toBe(0xdead_beefn);
      conn.close();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The negotiated payload limit.
//
// WELCOME carries `maxPayloadSize`, a *server policy* limit distinct from the
// frame format's structural 24-bit ceiling. All three SDKs decoded this field
// and then discarded it, so a request over the server's limit went out on the
// wire and came back as a server error — or killed the connection — instead of
// failing locally with the number the server had just supplied.
//
// `rust/tests/mux/main.rs` and `python/tests/test_mux.py` assert the same
// property, so the three cannot drift apart on it again.
// ---------------------------------------------------------------------------

/** What the mock servers above advertise in WELCOME. */
const ADVERTISED_MAX = 1 << 20;

/**
 * Completes the handshake, then reads until the peer goes away. Answers
 * nothing after AUTH_OK: an oversize request must be refused before it reaches
 * the socket, so this server must never see one.
 */
async function serveHandshakeOnly(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  await chan.write({
    opcode: Opcode.Welcome,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeWelcome({
      serverId: "mock-brain",
      chosenVersion: 1,
      connectionId: new Uint8Array(16).fill(0xab),
      capabilities: hello.capabilities,
      serverFeatures: {
        maxPayloadSize: ADVERTISED_MAX,
        maxConcurrentStreams: 256,
        idleTimeoutSeconds: 300,
        authMethods: [],
      },
    }),
  });

  await chan.read();
  await chan.write({
    opcode: Opcode.AuthOk,
    flags: FLAG_EOS,
    streamId: 0,
    payload: encodeAuthOk({
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
    }),
  });

  for (;;) {
    try {
      await chan.read();
    } catch {
      return;
    }
  }
}

describe("the negotiated payload limit", () => {
  it("refuses a payload over the advertised maximum locally", async () => {
    const { server, port } = await startServer(serveHandshakeOnly);
    try {
      const hello: HelloPayload = {
        clientId: "limit-test",
        supportedVersions: [1],
        capabilities: { streaming: true, compressionZstd: false, serverPush: false },
        clientConnectionToken: null,
      };
      const auth: AuthPayload = {
        method: AuthMethod.Token,
        credentials: { kind: "Token", token: new TextEncoder().encode("opaque-token") },
      };
      const { conn, outcome } = await MuxConnection.connect("127.0.0.1", port, hello, auth);
      expect(outcome.welcome.serverFeatures.maxPayloadSize).toBe(ADVERTISED_MAX);

      const oversize = new Uint8Array(ADVERTISED_MAX + 1);
      // The message must name the SERVER's number, not a local constant —
      // that is the whole point of enforcing the negotiated value.
      await expect(conn.requestOne(Opcode.EncodeReq, oversize)).rejects.toThrow(
        new RegExp(`${ADVERTISED_MAX}.*WELCOME`),
      );

      conn.close();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Two deadlines, not one.
//
// A read and a derived write are two different populations, so they get two
// deadlines. `ClientConfig.requestTimeoutMs` is right for a read (milliseconds)
// and far too tight for an ENCODE that asked to block on derivation: measured
// against a live server,
// three `WaitMode.Derived` encodes in isolation took 26.9s (~9s each), and a
// ten-way concurrent burst put three of the ten past 30s, the slowest at
// 45.5s. So the
// caller doing the correct thing — a derived write is the only way to get
// read-your-writes — was the one that hit a client-side BrainTimeout.
//
// The mux cannot see a wait mode, so it only grew the *mechanism*: a
// per-request deadline. The policy (which number an ENCODE gets) lives in the
// client. `serveHandshakeOnly` never answers a request, so the deadline that
// fires is the only thing under test.
//
// `python/tests/mux/test_mux.py`, `python/tests/aio_mux/test_aio_mux.py` and
// `rust/tests/mux/main.rs` assert the same properties.
// ---------------------------------------------------------------------------

// Scaled down from the shipped 30s / 120s: the ratio is what matters, and a
// test that waits out the real numbers is a test nobody runs.
const FLAT_MS = 150;
const DERIVED_MS = 800;

describe("the derived-write deadline", () => {
  it("lets one request override the connection default", async () => {
    const { server, port } = await startServer(serveHandshakeOnly);
    try {
      const hello: HelloPayload = {
        clientId: "deadline-test",
        supportedVersions: [1],
        capabilities: { streaming: true, compressionZstd: false, serverPush: false },
        clientConnectionToken: null,
      };
      const auth: AuthPayload = {
        method: AuthMethod.Token,
        credentials: { kind: "Token", token: new TextEncoder().encode("opaque-token") },
      };
      const { conn } = await MuxConnection.connect("127.0.0.1", port, hello, auth, {
        requestTimeoutMs: FLAT_MS,
      });

      await expect(
        conn.requestOne(Opcode.EncodeReq, encodeEncode(encodeRequest(1n))),
      ).rejects.toThrow(new BrainTimeout(FLAT_MS).message);

      await expect(
        conn.requestOne(Opcode.EncodeReq, encodeEncode(encodeRequest(2n)), DERIVED_MS),
      ).rejects.toThrow(new BrainTimeout(DERIVED_MS).message);

      conn.close();
    } finally {
      server.close();
    }
  });

  it("gives a derived encode the derived deadline", async () => {
    const { server, port } = await startServer(serveHandshakeOnly);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, {
        auth: TEST_AUTH,
        requestTimeoutMs: FLAT_MS,
        derivedWriteTimeoutMs: DERIVED_MS,
      });
      const started = Date.now();
      await expect(
        client.encode(new EncodeBuilder("a derived write").wait(WaitMode.Derived).build()),
      ).rejects.toThrow(new BrainTimeout(DERIVED_MS).message);
      // The number alone could come from anywhere; the wall clock proves the
      // request really outlived the flat deadline rather than reporting one
      // value and enforcing another.
      expect(Date.now() - started).toBeGreaterThanOrEqual(FLAT_MS * 2);
    } finally {
      server.close();
    }
  });

  it("leaves an ack encode and a read on the flat deadline", async () => {
    // The point of a second number is that it is *not* applied to everything:
    // raising the flat default instead would make every read hang for two
    // minutes on a dead connection.
    const { server, port } = await startServer(serveHandshakeOnly);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, {
        auth: TEST_AUTH,
        requestTimeoutMs: FLAT_MS,
        derivedWriteTimeoutMs: DERIVED_MS,
      });
      const started = Date.now();
      await expect(client.encode(new EncodeBuilder("an ordinary write").build())).rejects.toThrow(
        new BrainTimeout(FLAT_MS).message,
      );
      await expect(client.recall(new RecallBuilder("a cue").build())).rejects.toThrow(
        new BrainTimeout(FLAT_MS).message,
      );
      expect(Date.now() - started).toBeLessThan(DERIVED_MS);
    } finally {
      server.close();
    }
  });
});
