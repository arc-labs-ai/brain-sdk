/**
 * Mock-server drive for verbs that have a type + client method + conformance
 * corpus vector but were missing a live-or-mock integration test:
 *
 *   - SCHEMA_DROP  (client.dropSchema)   — incl. the lenient re-drop no-op shape
 *   - SCHEMA_LIST  (client.listSchemas)  — a streamed page of versions
 *   - EXTRACTOR_LIST (client.extractorList)
 *   - TXN_ABORT    (client.txnAbort)     — only begin/commit were exercised
 *
 * Plus a client-initiated PING via `client.ping()` (PING -> PONG), distinct from
 * the SERVER_PING -> CLIENT_PONG keepalive the mux auto-answers (see mux.ts /
 * mux.test.ts): the PONG routes back by stream id through the normal unary path.
 *
 * Like stream-control.test.ts, several of these verbs are thinly guarded at the
 * byte level, so the mock asserts the numeric opcode — a renumbering upstream
 * fails here instead of silently.
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
  type WelcomePayload,
  decodeAuth,
  decodeExtractorList,
  decodeHello,
  decodePing,
  decodeSchemaDrop,
  decodeSchemaList,
  decodeTxnAbort,
  encodeAuthOk,
  encodeExtractorListResponse,
  encodePong,
  encodeSchemaDropResponse,
  encodeSchemaListResponse,
  encodeTxnAbortResponse,
  encodeWelcome,
} from "../src/wire/types.js";

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

async function handshake(chan: FrameChannel): Promise<void> {
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
}

async function serveSchemaDrop(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  // First SCHEMA_DROP: a declared type actually removed -> dropped=true, new
  // version, no live rows blocking it.
  let f = await chan.read();
  expect(f.opcode, "SCHEMA_DROP opcode").toBe(0x0125);
  let req = decodeSchemaDrop(f.payload);
  expect(req.namespace).toBe("app");
  expect(req.targetName).toBe("likes");
  await chan.write({
    opcode: Opcode.SchemaDropResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeSchemaDropResponse({
      namespace: "app",
      schemaVersion: 5,
      targetKind: req.targetKind,
      targetName: req.targetName,
      dropped: true,
      liveRows: 0,
      validationErrors: [],
    }),
  });

  // Second SCHEMA_DROP of the same, now-absent type: the server's lenient
  // re-drop is a no-op -> dropped=false, schemaVersion=0.
  f = await chan.read();
  expect(f.opcode, "SCHEMA_DROP opcode (re-drop)").toBe(0x0125);
  req = decodeSchemaDrop(f.payload);
  await chan.write({
    opcode: Opcode.SchemaDropResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeSchemaDropResponse({
      namespace: "app",
      schemaVersion: 0,
      targetKind: req.targetKind,
      targetName: req.targetName,
      dropped: false,
      liveRows: 0,
      validationErrors: [],
    }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

async function serveSchemaList(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  const f = await chan.read();
  expect(f.opcode, "SCHEMA_LIST opcode").toBe(0x0122);
  const req = decodeSchemaList(f.payload);
  expect(req.namespace).toBe("app");
  // Two streamed frames, EOS on the last.
  await chan.write({
    opcode: Opcode.SchemaListResp,
    flags: 0,
    streamId: f.streamId,
    payload: encodeSchemaListResponse({
      namespace: "app",
      items: [
        {
          schemaVersion: 1,
          uploadedAtUnixNanos: 100n,
          validatorVersion: 1,
          hasSourceText: true,
        },
      ],
      total: 2,
      nextCursor: new Uint8Array([1]),
      isFinal: false,
    }),
  });
  await chan.write({
    opcode: Opcode.SchemaListResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeSchemaListResponse({
      namespace: "app",
      items: [
        {
          schemaVersion: 2,
          uploadedAtUnixNanos: 200n,
          validatorVersion: 1,
          hasSourceText: false,
        },
      ],
      total: 2,
      nextCursor: new Uint8Array(0),
      isFinal: true,
    }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

async function serveExtractorList(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  const f = await chan.read();
  expect(f.opcode, "EXTRACTOR_LIST opcode").toBe(0x0124);
  // Empty request body — the registry is server-side state.
  decodeExtractorList(f.payload);
  await chan.write({
    opcode: Opcode.ExtractorListResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeExtractorListResponse({
      items: [
        {
          extractorId: 1,
          namespace: "brain",
          name: "pattern",
          kind: 0,
          schemaVersion: 1,
          createdAtUnixNanos: 10n,
        },
        {
          extractorId: 2,
          namespace: "brain",
          name: "classifier",
          kind: 1,
          schemaVersion: 1,
          createdAtUnixNanos: 20n,
        },
      ],
      total: 2,
      isFinal: true,
    }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

async function serveTxnAbort(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);

  const f = await chan.read();
  expect(f.opcode, "TXN_ABORT opcode").toBe(0x0042);
  const req = decodeTxnAbort(f.payload);
  expect([...req.txnId]).toEqual([...TXN_ID]);
  await chan.write({
    opcode: Opcode.TxnAbortResp,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodeTxnAbortResponse({ txnId: TXN_ID, operationsDiscarded: 3 }),
  });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

describe("schema-drop over a mock server", () => {
  it("decodes both the drop and the lenient re-drop no-op shape", async () => {
    const { server, port } = await startServer(serveSchemaDrop);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const dropped = await client.dropSchema({
        namespace: "app",
        targetKind: 0,
        targetName: "likes",
        force: false,
        requestId: newId(),
      });
      expect(dropped.dropped).toBe(true);
      expect(dropped.schemaVersion, "a real drop bumps the namespace to a new active version").toBe(
        5,
      );

      const reDropped = await client.dropSchema({
        namespace: "app",
        targetKind: 0,
        targetName: "likes",
        force: false,
        requestId: newId(),
      });
      expect(
        reDropped.dropped,
        "re-dropping an already-absent type is a lenient no-op, not an error",
      ).toBe(false);
      expect(reDropped.schemaVersion, "a no-op drop reports version 0").toBe(0);

      await client.close();
    } finally {
      server.close();
    }
  });
});

describe("schema-list over a mock server", () => {
  it("flattens a streamed page of schema versions", async () => {
    const { server, port } = await startServer(serveSchemaList);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const versions = await client.listSchemas({
        namespace: "app",
        limit: 0,
        cursor: new Uint8Array(0),
      });
      expect(versions.length).toBe(2);
      expect(versions[0]!.schemaVersion).toBe(1);
      expect(versions[0]!.hasSourceText).toBe(true);
      expect(versions[1]!.schemaVersion).toBe(2);
      expect(versions[1]!.hasSourceText).toBe(false);

      await client.close();
    } finally {
      server.close();
    }
  });
});

describe("extractor-list over a mock server", () => {
  it("returns the always-on extractor registry", async () => {
    const { server, port } = await startServer(serveExtractorList);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const resp = await client.extractorList();
      expect(resp.total).toBe(2);
      expect(resp.isFinal).toBe(true);
      expect(resp.items.map((i) => i.name)).toEqual(["pattern", "classifier"]);
      expect(resp.items.map((i) => i.kind)).toEqual([0, 1]);

      await client.close();
    } finally {
      server.close();
    }
  });
});

describe("txn-abort over a mock server", () => {
  it("discards a transaction and reports the discarded op count", async () => {
    const { server, port } = await startServer(serveTxnAbort);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });

      const aborted = await client.txnAbort({ txnId: TXN_ID });
      expect([...aborted.txnId]).toEqual([...TXN_ID]);
      expect(
        aborted.operationsDiscarded,
        "operationsDiscarded is how a caller learns how much the abort threw away",
      ).toBe(3);

      await client.close();
    } finally {
      server.close();
    }
  });
});

/**
 * Client-initiated PING (`client.ping()`) → PONG, driven through the real
 * BrainClient + mux. Distinct from the server's idle-timer SERVER_PING keepalive
 * (auto-answered with CLIENT_PONG by the mux): this is an on-demand round-trip
 * whose PONG routes back by stream id through the normal unary path. The mock
 * echoes the client timestamp so the caller can measure RTT.
 */
async function servePing(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);
  await handshake(chan);
  const f = await chan.read();
  expect(f.opcode, "PING opcode").toBe(0x0010);
  const req = decodePing(f.payload);
  await chan.write({
    opcode: Opcode.Pong,
    flags: FLAG_EOS,
    streamId: f.streamId,
    payload: encodePong({
      clientTimestampUnixNanos: req.clientTimestampUnixNanos,
      serverTimestampUnixNanos: 42n,
    }),
  });
}

describe("client-initiated PING over a mock server", () => {
  it("client.ping() sends PING and decodes the PONG echo", async () => {
    const nonce = 0xdead_beefn;
    const { server, port } = await startServer(servePing);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });
      const pong = await client.ping({ clientTimestampUnixNanos: nonce });
      expect(pong.clientTimestampUnixNanos, "PONG echoes the client nonce").toBe(nonce);
      expect(pong.serverTimestampUnixNanos).toBe(42n);
      await client.close();
    } finally {
      server.close();
    }
  });

  it("client.ping() defaults the client timestamp to a real wall-clock value", async () => {
    let seen = 0n;
    const serve = async (sock: net.Socket): Promise<void> => {
      const chan = new FrameChannel(sock);
      await handshake(chan);
      const f = await chan.read();
      seen = decodePing(f.payload).clientTimestampUnixNanos;
      await chan.write({
        opcode: Opcode.Pong,
        flags: FLAG_EOS,
        streamId: f.streamId,
        payload: encodePong({ clientTimestampUnixNanos: seen, serverTimestampUnixNanos: 7n }),
      });
    };
    const { server, port } = await startServer(serve);
    try {
      const client = await BrainClient.connect("127.0.0.1", port, { auth: TEST_AUTH });
      const pong = await client.ping();
      expect(seen > 0n, "ping() defaulted to a real timestamp").toBe(true);
      expect(pong.clientTimestampUnixNanos, "PONG echoes the defaulted timestamp").toBe(seen);
      await client.close();
    } finally {
      server.close();
    }
  });
});
