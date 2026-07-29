/**
 * Multiplexed connection: many requests in flight at once over one socket.
 *
 * A `MuxConnection` routes every inbound frame to the waiting request by its
 * `streamId`, so callers issue requests concurrently over one shared
 * connection — no serial one-at-a-time request/response discipline. A single
 * `data` pump decodes whole frames (a frame can
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
  type AuthPayload,
  type HelloPayload,
  type SubscribeRequest,
  type SubscriptionEvent,
  type UnsubscribeResponse,
  decodeAuthOk,
  decodeError,
  decodeServerPing,
  encodeBye,
  decodeSubscriptionEvent,
  decodeUnsubscribeResponse,
  decodeWelcome,
  encodeAuth,
  encodeClientPong,
  encodeHello,
  encodeSubscribe,
  encodeUnsubscribe,
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

  /**
   * Open a long-lived subscription (SUBSCRIBE). Allocates a stream id,
   * registers its route, sends the SUBSCRIBE frame as one EOS frame, and
   * returns a {@link Subscription} the caller drains with `next()` (or
   * `for await`). Unlike {@link request}, this does NOT collect to EOS — the
   * server pushes events until the client unsubscribes.
   */
  async subscribe(request: SubscribeRequest): Promise<Subscription> {
    if (this.closedError) throw this.closedError;
    const streamId = this.takeStreamId();
    const sink = new StreamSink();
    this.routes.set(streamId, sink);
    try {
      await this.writeFrame(Opcode.SubscribeReq, streamId, encodeSubscribe(request));
    } catch (err) {
      this.routes.delete(streamId);
      throw err;
    }
    return new Subscription(this, streamId, sink);
  }

  /**
   * Number of live routes in the table. Test/diagnostics hook: a clean
   * subscription teardown must leave no leaked route behind.
   */
  routeCount(): number {
    return this.routes.size;
  }

  /** Send BYE to end the session cleanly. The server closes without a reply. */
  async sendBye(): Promise<void> {
    // A CBOR map, not an empty payload: the server decodes this as a
    // ByeRequest, and zero bytes is not valid CBOR.
    await this.writeFrame(Opcode.Bye, HANDSHAKE_STREAM_ID, encodeBye({ reason: null }));
  }

  // ---- subscription support (consumed by `Subscription`, same module) ----

  /** Await the next frame routed to `sink`, honoring the request timeout. */
  awaitFrame(sink: StreamSink): Promise<Frame> {
    return this.nextFrame(sink);
  }

  /** Drop the route for `streamId` (subscription teardown). */
  dropRoute(streamId: number): void {
    this.routes.delete(streamId);
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
        (e: unknown) => {
          clearTimeout(timer);
          // Forwarding the wrapped promise's own rejection, not creating one:
          // whatever it rejected with is what the caller must see.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
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
    // Concatenate the new chunk onto whatever leftover bytes remained from the
    // last drain — once per chunk, not once per frame. Frame consumption then
    // advances a read offset into this single buffer; we only re-slice (compact)
    // the unconsumed tail once, after the drain loop, instead of reallocating
    // the whole pending buffer on every frame. This keeps a busy stream of many
    // small frames at amortized-linear cost rather than O(n²).
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    let offset = 0;
    for (;;) {
      let decoded: { frame: Frame; rest: Uint8Array };
      try {
        decoded = decodeFrame(this.buf.subarray(offset));
      } catch (err) {
        if (err instanceof FrameError && err.kind === "Truncated") break;
        // Any other codec error desynchronizes the stream — fatal.
        this.failAll(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // `rest` is a view onto the same tail; the consumed length is the shrink
      // in remaining bytes. Advancing `offset` (rather than reslicing here)
      // leaves frame-straddling correct: a partial trailing frame stays in
      // `this.buf` and is retried after the next chunk arrives.
      offset += this.buf.length - offset - decoded.rest.length;
      // Server idle-timer heartbeat: answer with CLIENT_PONG on stream 0 so an
      // idle connection isn't reaped. Otherwise route to the request that owns
      // this stream; an unknown id is a late frame for a cancelled/timed-out
      // request and is dropped.
      if (decoded.frame.opcode === Opcode.ServerPing) {
        this.answerServerPing(decoded.frame);
      } else {
        this.routes.get(decoded.frame.streamId)?.push(decoded.frame);
      }
    }
    // Compact once: drop the bytes consumed this drain, keep the partial tail.
    this.buf = offset === 0 ? this.buf : this.buf.subarray(offset);
  }

  private failAll(err: Error): void {
    if (this.closedError === null) this.closedError = err;
    for (const sink of this.routes.values()) sink.fail(err);
    this.routes.clear();
  }

  /**
   * Answer a SERVER_PING with a CLIENT_PONG on stream 0, echoing the server
   * timestamp (0 if the payload can't be decoded — the server only needs a
   * frame to reset its idle timer). Best-effort: a write failure surfaces as
   * the next socket error/close.
   */
  private answerServerPing(frame: Frame): void {
    let serverTs = 0n;
    try {
      serverTs = decodeServerPing(frame.payload).serverTimestampUnixNanos;
    } catch {
      serverTs = 0n;
    }
    const payload = encodeClientPong({
      serverTimestampUnixNanos: serverTs,
      clientTimestampUnixNanos: nowUnixNanos(),
    });
    void this.writeFrame(Opcode.ClientPong, HANDSHAKE_STREAM_ID, payload).catch(() => {});
  }

  private takeStreamId(): number {
    // Client-initiated op streams MUST be non-zero and ODD (stream 0 is the
    // connection/handshake stream; the server rejects even/zero client streams
    // as BadFrame). Start at 1 and step by 2 so every request on a reused
    // connection (pool, REPL) stays odd, wrapping back to 1 at the u32 max.
    const id = this.nextStreamId;
    this.nextStreamId = this.nextStreamId + 2 > 0xffff_ffff ? 1 : this.nextStreamId + 2;
    return id;
  }
}

/**
 * A live server-push subscription stream. Drain events with {@link next} or by
 * iterating with `for await`; call {@link unsubscribe} for a clean teardown —
 * the server then EOS-closes the event stream, which {@link next} observes as
 * end-of-stream (`null`).
 *
 * Dropping a subscription without unsubscribing leaks no route once {@link close}
 * (or the async-iterator's return path) deregisters it. Prefer
 * `await unsubscribe()` before closing so the server stops pushing.
 */
export class Subscription implements AsyncIterableIterator<SubscriptionEvent> {
  // Set once an EOS frame has been observed: the next `next()` short-circuits
  // to done without touching the (already-removed) route.
  private ended = false;

  constructor(
    private readonly conn: MuxConnection,
    private readonly streamIdValue: number,
    private readonly sink: StreamSink,
  ) {}

  /** The stream id the server pushes events on. */
  get streamId(): number {
    return this.streamIdValue;
  }

  /**
   * Await the next subscription event, or `null` once the stream has ended
   * (the server EOS-closed it, or the connection dropped). An EOS-flagged frame
   * carrying an event yields that event; the following call returns `null`. An
   * EOS frame with an empty payload ends the stream immediately.
   */
  async nextEvent(): Promise<SubscriptionEvent | null> {
    if (this.ended) return null;
    let frame: Frame;
    try {
      frame = await this.conn.awaitFrame(this.sink);
    } catch (err) {
      this.ended = true;
      this.conn.dropRoute(this.streamIdValue);
      if (err instanceof ConnectionClosed) return null;
      throw err;
    }
    if (frame.opcode === Opcode.Error) {
      this.ended = true;
      this.conn.dropRoute(this.streamIdValue);
      throw new ServerError(decodeError(frame.payload));
    }
    if ((frame.flags & FLAG_EOS) !== 0) {
      // Last frame on the stream; mark ended and drop the route.
      this.ended = true;
      this.conn.dropRoute(this.streamIdValue);
      if (frame.payload.length === 0) return null;
    }
    return decodeSubscriptionEvent(frame.payload);
  }

  /**
   * Tear the subscription down cleanly: send UNSUBSCRIBE on a fresh stream and
   * await its UNSUBSCRIBE_RESP. The server then EOS-closes the event stream,
   * which a subsequent {@link nextEvent} observes as `null`.
   */
  async unsubscribe(): Promise<UnsubscribeResponse> {
    const frame = await this.conn.requestOne(
      Opcode.UnsubscribeReq,
      encodeUnsubscribe({ targetStreamId: this.streamIdValue }),
    );
    if (frame.opcode !== Opcode.UnsubscribeResp) {
      throw new ProtocolError(
        `expected UNSUBSCRIBE_RESP (0x${Opcode.UnsubscribeResp.toString(16)}), got ` +
          `0x${frame.opcode.toString(16)}`,
      );
    }
    return decodeUnsubscribeResponse(frame.payload);
  }

  /**
   * Deregister the subscription's route so a forgotten handle doesn't leak a
   * route-table entry. Does not send UNSUBSCRIBE — call {@link unsubscribe}
   * first for a clean shutdown.
   */
  close(): void {
    this.ended = true;
    this.conn.dropRoute(this.streamIdValue);
  }

  // ---- async iteration ----

  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    const event = await this.nextEvent();
    if (event === null) return { done: true, value: undefined };
    return { done: false, value: event };
  }

  // Not `async`: closing is synchronous, and the `AsyncIterableIterator`
  // contract only asks for a promise.
  return(): Promise<IteratorResult<SubscriptionEvent>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SubscriptionEvent> {
    return this;
  }
}

/** Wall-clock nanoseconds since the Unix epoch (ms precision). Stamps CLIENT_PONG. */
function nowUnixNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
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
