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
import { connect as connectTls, rootCertificates } from "node:tls";

import {
  BrainTimeout,
  ConnectionClosed,
  ProtocolError,
  ServerError,
  TransportError,
  VersionMismatch,
} from "./errors.js";
import {
  decodeFrame,
  encodeFrame,
  FLAG_EOS,
  type Frame,
  FrameError,
  MAX_PAYLOAD_LEN,
} from "./wire/frame.js";
import { describeThrown } from "./describe.js";
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
 * Last-resort cleanup for a subscription handle that goes out of scope without
 * being closed. On a connection meant to stay up for days, each leaked route
 * keeps the pump buffering frames into an array nobody drains, so losing the
 * handle must still drop the route.
 *
 * Collection timing is the engine's to choose, so this is a backstop, never
 * the path a caller should rely on: `close()`, `unsubscribe()` and `await using`
 * all drop the route at a point the caller controls.
 */
const abandonedSubscriptions = new FinalizationRegistry<{
  conn: MuxConnection;
  streamId: number;
}>(({ conn, streamId }) => conn.dropRoute(streamId));

/**
 * A single-stream frame queue. Frames the pump routes here are buffered until a
 * `next()` consumes them; waiters are served in arrival order, and `fail()`
 * rejects every current and future waiter once the connection dies.
 */
class StreamSink {
  private readonly frames: Frame[] = [];
  private readonly waiters: {
    resolve: (f: Frame) => void;
    reject: (e: Error) => void;
  }[] = [];
  private failure: Error | null = null;

  push(frame: Frame): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  fail(err: Error): void {
    if (this.failure === null) this.failure = err;
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) waiter.reject(err);
  }

  next(): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<Frame>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

/** A connection that serves many concurrent requests over one socket. */
export class MuxConnection {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly routes = new Map<number, StreamSink>();
  private nextStreamId = 1;
  private closedError: Error | null = null;
  private idleTimeoutMs: number | undefined;
  private idleWatchdog: ReturnType<typeof setTimeout> | undefined;
  private lastFrameReceivedAt = 0;
  /**
   * The server's WELCOME `maxPayloadSize`, enforced before every write.
   *
   * A *policy* limit, not the frame format's structural 24-bit ceiling: a
   * server may advertise less than 16 MiB, and nothing checked it — all three
   * SDKs decoded this field and discarded it, so an oversize request went out
   * and came back as a server error, or killed the connection, instead of
   * failing locally with the number the server just supplied.
   *
   * Starts at the structural maximum; the handshake narrows it. Only handshake
   * frames are written before that, and those are small.
   */
  private maxPayloadSize = MAX_PAYLOAD_LEN;

  private constructor(
    private readonly socket: Socket,
    private readonly requestTimeoutMs: number | undefined,
  ) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.failAll(new TransportError(err.message)));
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
      tls?:
        | {
            ca?: string | undefined;
            servername?: string | undefined;
          }
        | undefined;
    } = {},
  ): Promise<{ conn: MuxConnection; outcome: HandshakeOutcome }> {
    const socket =
      options.tls === undefined
        ? await connectTcp(host, port, options.connectTimeoutMs)
        : await connectTlsSocket(host, port, options.tls, options.connectTimeoutMs);
    socket.setNoDelay(true);
    const conn = new MuxConnection(socket, options.requestTimeoutMs);
    const outcome = await conn.handshake(hello, auth);
    return { conn, outcome };
  }

  /** Wrap an already-connected socket (used by tests over a pipe/loopback). */
  static overSocket(socket: Socket, requestTimeoutMs?: number): MuxConnection {
    return new MuxConnection(socket, requestTimeoutMs);
  }

  /** Whether the socket has failed or the peer has closed the connection. */
  get isClosed(): boolean {
    return this.closedError !== null;
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
      this.startIdleWatchdog(welcome.serverFeatures.idleTimeoutSeconds);
      if (!offered.includes(welcome.chosenVersion)) {
        throw new VersionMismatch(welcome.chosenVersion, offered);
      }

      await this.writeFrame(Opcode.Auth, HANDSHAKE_STREAM_ID, encodeAuth(auth));
      const authOkFrame = await this.expectReply(sink, Opcode.AuthOk);
      const authOk = decodeAuthOk(authOkFrame.payload);
      // A server that leaves this field at its default advertises 0. Zero is
      // not a meaningful payload cap — read literally it refuses every request
      // — so it means "unset", and the structural 24-bit ceiling stands in.
      // Reading it literally bricked the client against any such server.
      this.maxPayloadSize = welcome.serverFeatures.maxPayloadSize || MAX_PAYLOAD_LEN;
      return { welcome, authOk };
    } finally {
      this.routes.delete(HANDSHAKE_STREAM_ID);
    }
  }

  /**
   * Send one request and collect its response frames up to and including the
   * EOS frame. Safe to call concurrently; responses route back by `streamId`.
   *
   * `timeoutMs` raises the per-frame deadline for this one request. The mux
   * cannot tell which verb it is carrying, let alone that an ENCODE asked to
   * block on derivation; the client can, so the policy lives there and the
   * mechanism lives here.
   */
  async request(opcode: number, payload: Uint8Array, timeoutMs?: number): Promise<Frame[]> {
    if (this.closedError) throw this.closedError;
    const streamId = this.takeStreamId();
    const sink = new StreamSink();
    this.routes.set(streamId, sink);
    try {
      await this.writeFrame(opcode, streamId, payload);
      const frames: Frame[] = [];
      for (;;) {
        const frame = await this.nextFrame(sink, timeoutMs);
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

  /**
   * Send a CONNECTION-LEVEL request and collect its response frames.
   *
   * `PING`/`PONG`, like `HELLO` and `BYE`, are connection-level opcodes: the
   * server refuses them on any stream but 0 with
   * `connection-level opcode requires stream_id = 0`. They therefore cannot go
   * through {@link request}, which allocates an odd op-stream id — a `ping()`
   * built on that path never completed a round trip.
   *
   * Stream 0 is also the handshake stream, but it is free by the time any
   * request runs: `HELLO`/`AUTH` complete before this is reachable, and the
   * server's own `SERVER_PING` keepalive is intercepted by the pump before
   * routing, so it never lands in the table.
   */
  async requestOnConnection(opcode: number, payload: Uint8Array): Promise<Frame[]> {
    if (this.closedError) throw this.closedError;
    const sink = new StreamSink();
    this.routes.set(HANDSHAKE_STREAM_ID, sink);
    try {
      await this.writeFrame(opcode, HANDSHAKE_STREAM_ID, payload);
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
      this.routes.delete(HANDSHAKE_STREAM_ID);
    }
  }

  /** Send one request and require exactly one EOS response frame.
   * `timeoutMs` overrides the per-frame deadline as in {@link request}. */
  async requestOne(opcode: number, payload: Uint8Array, timeoutMs?: number): Promise<Frame> {
    const frames = await this.request(opcode, payload, timeoutMs);
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

  /**
   * Await the next frame routed to `sink` with no deadline.
   *
   * A subscription is long-lived by definition: a change feed is quiet by
   * design and may publish nothing for hours, so silence is not a fault — the
   * request deadline that bounds {@link request} would turn the normal case
   * into an error. The connection watchdog accepts two missed advertised idle
   * intervals before failing every route, while SERVER_PING frames refresh it.
   *
   * A socket error or peer close still settles it: the pump fails every live
   * sink.
   */
  awaitFrame(sink: StreamSink): Promise<Frame> {
    return sink.next();
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

  private nextFrame(sink: StreamSink, timeoutMs?: number): Promise<Frame> {
    // `undefined` means "the deadline this connection was configured with",
    // not "no deadline": an override exists to *raise* the limit for one
    // request, and a caller that wants an unbounded wait omits
    // `requestTimeoutMs` on the config.
    const deadlineMs = timeoutMs ?? this.requestTimeoutMs;
    if (deadlineMs === undefined) return sink.next();
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Fail the sink rather than only this promise: an abandoned waiter
        // would be resolved by the next frame to arrive and silently swallow
        // it. A request whose deadline has passed has its route dropped, so
        // there is nothing left on this stream to deliver.
        sink.fail(new BrainTimeout(deadlineMs));
      }, deadlineMs);
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
    if (payload.length > this.maxPayloadSize) {
      return Promise.reject(
        new ProtocolError(
          `payload is ${payload.length} bytes, over the ${this.maxPayloadSize} ` +
            "the server advertised at WELCOME",
        ),
      );
    }
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
        this.failAll(err instanceof Error ? err : new Error(describeThrown(err)));
        return;
      }
      // `rest` is a view onto the same tail; the consumed length is the shrink
      // in remaining bytes. Advancing `offset` (rather than reslicing here)
      // leaves frame-straddling correct: a partial trailing frame stays in
      // `this.buf` and is retried after the next chunk arrives.
      offset += this.buf.length - offset - decoded.rest.length;
      this.lastFrameReceivedAt = Date.now();
      if (this.idleTimeoutMs !== undefined) this.scheduleIdleWatchdog();
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
    if (this.idleWatchdog !== undefined) {
      clearTimeout(this.idleWatchdog);
      this.idleWatchdog = undefined;
    }
    if (this.closedError === null) this.closedError = err;
    for (const sink of this.routes.values()) sink.fail(err);
    this.routes.clear();
  }

  private startIdleWatchdog(idleTimeoutSeconds: number): void {
    if (idleTimeoutSeconds <= 0) return;
    this.idleTimeoutMs = idleTimeoutSeconds * 2 * 1000;
    this.lastFrameReceivedAt = Date.now();
    this.scheduleIdleWatchdog();
  }

  private scheduleIdleWatchdog(): void {
    const timeoutMs = this.idleTimeoutMs;
    if (timeoutMs === undefined) return;
    if (this.idleWatchdog !== undefined) clearTimeout(this.idleWatchdog);
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - this.lastFrameReceivedAt));
    this.idleWatchdog = setTimeout(() => {
      if (Date.now() - this.lastFrameReceivedAt < timeoutMs) {
        this.scheduleIdleWatchdog();
        return;
      }
      const err = new TransportError(`connection idle for ${timeoutMs}ms`);
      this.failAll(err);
      this.socket.destroy();
    }, remainingMs);
    this.idleWatchdog.unref?.();
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
    // A PONG is best effort: the connection is already failing if this write
    // does, and every real request has its own error path.
    void this.writeFrame(Opcode.ClientPong, HANDSHAKE_STREAM_ID, payload).catch(() => {
      /* ignored: liveness only */
    });
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
 * A handle that goes out of scope without being closed still drops its route
 * eventually. It cannot tell the server to stop pushing, so prefer
 * `await unsubscribe()` or `await using`.
 */
export class Subscription implements AsyncIterableIterator<SubscriptionEvent> {
  // Set once an EOS frame has been observed: the next `next()` short-circuits
  // to done without touching the (already-removed) route.
  private ended = false;
  // LSN of the most recent event handed to the caller: the cursor to resume a
  // severed feed from, as `SubscribeRequest.fromLsn`.
  private lastLsnValue: bigint | null = null;

  constructor(
    private readonly conn: MuxConnection,
    private readonly streamIdValue: number,
    private readonly sink: StreamSink,
  ) {
    abandonedSubscriptions.register(this, { conn, streamId: streamIdValue }, this);
  }

  /** The stream id the server pushes events on. */
  get streamId(): number {
    return this.streamIdValue;
  }

  /**
   * Await the next subscription event, or `null` once the stream completed.
   * Each pushed frame yields a {@link SubscriptionEvent}; a server ERROR
   * yields {@link ServerError}; and a connection drop before the stream was
   * closed yields {@link ConnectionClosed} or {@link TransportError}. A
   * severed feed is a failure, not an ending. `null` is returned only after a
   * server EOS or a local close. An EOS-flagged frame carrying an event yields
   * that event; the following call returns `null`. An EOS frame with an empty
   * payload ends the stream immediately.
   */
  async nextEvent(): Promise<SubscriptionEvent | null> {
    if (this.ended) return null;
    let frame: Frame;
    try {
      frame = await this.conn.awaitFrame(this.sink);
    } catch (err) {
      // A feed cut mid-stream is a failure, not an ending: the server is still
      // producing events this caller has stopped receiving. Only an EOS frame,
      // or a local close, ends a stream.
      this.close();
      throw err;
    }
    if (frame.opcode === Opcode.Error) {
      this.close();
      throw new ServerError(decodeError(frame.payload));
    }
    if ((frame.flags & FLAG_EOS) !== 0) {
      // Last frame on the stream; mark ended and drop the route.
      this.close();
      if (frame.payload.length === 0) return null;
    }
    const event = decodeSubscriptionEvent(frame.payload);
    this.lastLsnValue = event.lsn;
    return event;
  }

  /**
   * LSN of the last event this subscription delivered, or `null` before the
   * first one. Pass it as `SubscribeRequest.fromLsn` to resume a feed that was
   * cut mid-stream without re-reading what the caller already saw.
   */
  get lastLsn(): bigint | null {
    return this.lastLsnValue;
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
    abandonedSubscriptions.unregister(this);
    this.conn.dropRoute(this.streamIdValue);
  }

  /**
   * Scoped teardown for `await using`: stop the server pushing, then drop the
   * route. The UNSUBSCRIBE is best effort — a scope exit must not throw over a
   * connection that has already failed, and the route is dropped either way.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.ended) {
      try {
        await this.unsubscribe();
      } catch {
        /* ignored: a scope exit reports the body's failure, not the teardown's */
      }
    }
    this.close();
  }

  /**
   * Scoped teardown for `using`: drops the route only. Telling the server to
   * stop needs a round trip, so prefer `await using` where the caller can.
   */
  [Symbol.dispose](): void {
    this.close();
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

function connectTcp(host: string, port: number, timeoutMs: number | undefined): Promise<Socket> {
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
      reject(new TransportError(err.message));
    });
  });
}

function connectTlsSocket(
  host: string,
  port: number,
  options: { ca?: string | undefined; servername?: string | undefined },
  timeoutMs: number | undefined,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connectTls({
      host,
      port,
      servername: options.servername ?? host,
      ALPNProtocols: ["brain/1"],
      minVersion: "TLSv1.3",
      ...(options.ca === undefined ? {} : { ca: [...rootCertificates, options.ca] }),
    });
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
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new TransportError(err.message));
    });
  });
}
