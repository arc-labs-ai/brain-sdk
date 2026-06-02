/**
 * Multiplexed connection: many requests in flight at once over one socket.
 *
 * The one-at-a-time `Connection` sends a request and reads frames back in
 * order. A `MuxConnection` instead routes every inbound frame to the waiting
 * request by its `streamId`, so callers issue requests concurrently over one
 * shared connection. A single `data` pump decodes whole frames (a frame can
 * straddle socket reads) and dispatches each to the per-stream sink registered
 * for it; a socket error or peer close fails every outstanding request.
 *
 * `streamId` 0 is the handshake stream; the handshake registers a sink on it,
 * completes HELLO → WELCOME → AUTH → AUTH_OK, then releases it before request
 * streams (numbered from 1) are issued.
 */

import { createConnection, type Socket } from "node:net";

import {
  BrainError,
  BrainTimeout,
  ConnectionClosed,
  ProtocolError,
  ServerError,
  VersionMismatch,
} from "./errors.js";
import { decodeFrame, encodeFrame, FLAG_EOS, type Frame, FrameError } from "./wire/frame.js";
import { Opcode } from "./wire/opcode.js";
import {
  type AuthOkPayload,
  type AuthPayload,
  type HelloPayload,
  type WelcomePayload,
  decodeAuthOk,
  decodeError,
  decodeWelcome,
  encodeAuth,
  encodeHello,
} from "./wire/types.js";

import type { HandshakeOutcome } from "./connection.js";

const HANDSHAKE_STREAM_ID = 0;

/**
 * A single-stream frame queue. Frames the pump routes here are buffered until a
 * `next()` consumes them; `fail()` rejects the current and future waiters once
 * the connection dies.
 */
class StreamSink {
  private readonly frames: Frame[] = [];
  private waiter: { resolve: (f: Frame) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  push(frame: Frame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  fail(err: Error): void {
    if (this.failure === null) this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  next(): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<Frame>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

/** A connection that serves many concurrent requests over one socket. */
export class MuxConnection {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly routes = new Map<number, StreamSink>();
  private nextStreamId = 1;
  private closedError: Error | null = null;

  private constructor(
    private readonly socket: Socket,
    private readonly requestTimeoutMs: number | undefined,
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.failAll(new BrainError(err.message)));
    socket.on("close", () => this.failAll(new ConnectionClosed()));
  }

  /**
   * Connect to `host:port`, run the handshake, and return a live multiplexed
   * connection. `connectTimeoutMs` bounds the TCP connect; `requestTimeoutMs`
   * is the per-response deadline applied to every later request.
   */
  static async connect(
    host: string,
    port: number,
    hello: HelloPayload,
    auth: AuthPayload,
    options: {
      connectTimeoutMs?: number | undefined;
      requestTimeoutMs?: number | undefined;
    } = {},
  ): Promise<{ conn: MuxConnection; outcome: HandshakeOutcome }> {
    const socket = await connectTcp(host, port, options.connectTimeoutMs);
    socket.setNoDelay(true);
    const conn = new MuxConnection(socket, options.requestTimeoutMs);
    const outcome = await conn.handshake(hello, auth);
    return { conn, outcome };
  }

  /** Wrap an already-connected socket (used by tests over a pipe/loopback). */
  static overSocket(socket: Socket, requestTimeoutMs?: number): MuxConnection {
    return new MuxConnection(socket, requestTimeoutMs);
  }

  /** Run the client side of the handshake on stream 0. */
  async handshake(hello: HelloPayload, auth: AuthPayload): Promise<HandshakeOutcome> {
    const offered = [...hello.supportedVersions];
    const sink = new StreamSink();
    this.routes.set(HANDSHAKE_STREAM_ID, sink);
    try {
      await this.writeFrame(Opcode.Hello, HANDSHAKE_STREAM_ID, encodeHello(hello));
      const welcomeFrame = await this.expectReply(sink, Opcode.Welcome);
      const welcome = decodeWelcome(welcomeFrame.payload);
      if (!offered.includes(welcome.chosenVersion)) {
        throw new VersionMismatch(welcome.chosenVersion, offered);
      }

      await this.writeFrame(Opcode.Auth, HANDSHAKE_STREAM_ID, encodeAuth(auth));
      const authOkFrame = await this.expectReply(sink, Opcode.AuthOk);
      const authOk = decodeAuthOk(authOkFrame.payload);
      return { welcome, authOk };
    } finally {
      this.routes.delete(HANDSHAKE_STREAM_ID);
    }
  }

  /**
   * Send one request and collect its response frames up to and including the
   * EOS frame. Safe to call concurrently; responses route back by `streamId`.
   */
  async request(opcode: number, payload: Uint8Array): Promise<Frame[]> {
    if (this.closedError) throw this.closedError;
    const streamId = this.takeStreamId();
    const sink = new StreamSink();
    this.routes.set(streamId, sink);
    try {
      await this.writeFrame(opcode, streamId, payload);
      const frames: Frame[] = [];
      for (;;) {
        const frame = await this.nextFrame(sink);
        if (frame.opcode === Opcode.Error) {
          throw new ServerError(decodeError(frame.payload));
        }
        frames.push(frame);
        if ((frame.flags & FLAG_EOS) !== 0) return frames;
      }
    } finally {
      this.routes.delete(streamId);
    }
  }

  /** Send one request and require exactly one EOS response frame. */
  async requestOne(opcode: number, payload: Uint8Array): Promise<Frame> {
    const frames = await this.request(opcode, payload);
    if (frames.length !== 1) {
      throw new ProtocolError(`expected a single response frame, got ${frames.length}`);
    }
    return frames[0]!;
  }

  /** Send BYE to end the session cleanly. The server closes without a reply. */
  async sendBye(): Promise<void> {
    await this.writeFrame(Opcode.Bye, HANDSHAKE_STREAM_ID, new Uint8Array(0));
  }

  /** Destroy the underlying socket. */
  close(): void {
    this.socket.destroy();
  }

  // ---- internals ----

  private nextFrame(sink: StreamSink): Promise<Frame> {
    if (this.requestTimeoutMs === undefined) return sink.next();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new BrainTimeout(this.requestTimeoutMs!)),
        this.requestTimeoutMs,
      );
      sink.next().then(
        (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private async expectReply(sink: StreamSink, expected: number): Promise<Frame> {
    const frame = await this.nextFrame(sink);
    if (frame.opcode === Opcode.Error) {
      throw new ServerError(decodeError(frame.payload));
    }
    if (frame.opcode !== expected) {
      throw new ProtocolError(
        `expected opcode 0x${expected.toString(16).padStart(4, "0")}, got ` +
          `0x${frame.opcode.toString(16).padStart(4, "0")}`,
      );
    }
    return frame;
  }

  private writeFrame(opcode: number, streamId: number, payload: Uint8Array): Promise<void> {
    // Every client request is a single EOS-terminated frame.
    const bytes = encodeFrame(opcode, streamId, FLAG_EOS, payload);
    return new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  private onData(chunk: Buffer): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    for (;;) {
      let decoded: { frame: Frame; rest: Uint8Array };
      try {
        decoded = decodeFrame(this.buf);
      } catch (err) {
        if (err instanceof FrameError && err.kind === "Truncated") break;
        // Any other codec error desynchronizes the stream — fatal.
        this.failAll(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.buf = decoded.rest;
      // Route to the request that owns this stream; an unknown id is a late
      // frame for a cancelled/timed-out request and is dropped.
      this.routes.get(decoded.frame.streamId)?.push(decoded.frame);
    }
  }

  private failAll(err: Error): void {
    if (this.closedError === null) this.closedError = err;
    for (const sink of this.routes.values()) sink.fail(err);
    this.routes.clear();
  }

  private takeStreamId(): number {
    const id = this.nextStreamId;
    // 32-bit wire field; wrap past the max back to 1 (0 stays the handshake).
    this.nextStreamId = this.nextStreamId >= 0xffff_ffff ? 1 : this.nextStreamId + 1;
    return id;
  }
}

function connectTcp(
  host: string,
  port: number,
  timeoutMs: number | undefined,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new BrainTimeout(timeoutMs));
          }, timeoutMs)
        : undefined;
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new BrainError(err.message));
    });
  });
}
