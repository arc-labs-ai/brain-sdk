/**
 * Async frame transport over a Node socket.
 *
 * A `FrameChannel` wraps a `net.Socket` and turns its byte stream into whole
 * frames. Incoming data accumulates in a buffer; every time a complete frame
 * decodes it is delivered to the next waiting `read()` (or queued until one
 * arrives). A frame can straddle `data` events — the codec's `Truncated`
 * signal means "wait for more bytes". Any other frame-codec error, a socket
 * error, or a peer close fails all pending and future reads.
 */

import type { Socket } from "node:net";

import { ConnectionClosed } from "./errors.js";
import { decodeFrame, encodeFrame, type Frame, FrameError } from "./wire/frame.js";

interface Waiter {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
}

/** Turns a socket's byte stream into ordered, whole-frame reads. */
/**
 * Render a non-`Error` thrown value for a message.
 *
 * `String(value)` collapses every object to the literal `[object Object]`,
 * which is the whole content of the message when a codec failure has already
 * desynchronized the stream and the thrown value is the only clue left.
 */
export function describeThrown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export class FrameChannel {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly ready: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.fail(err));
    socket.on("close", () => this.fail(new ConnectionClosed()));
  }

  /** Read the next whole frame, awaiting more bytes if necessary. */
  read(): Promise<Frame> {
    const queued = this.ready.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<Frame>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /** Serialize and write one frame; resolves once the bytes are flushed. */
  write(frame: Frame): Promise<void> {
    const bytes = encodeFrame(frame.opcode, frame.streamId, frame.flags, frame.payload);
    return new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Destroy the underlying socket. */
  close(): void {
    this.socket.destroy();
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
        this.fail(err instanceof Error ? err : new Error(describeThrown(err)));
        return;
      }
      this.buf = decoded.rest;
      this.deliver(decoded.frame);
    }
  }

  private deliver(frame: Frame): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(frame);
    } else {
      this.ready.push(frame);
    }
  }

  private fail(err: Error): void {
    if (this.failure === null) this.failure = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(this.failure);
    }
  }
}

/** Reject `promise` with `onTimeout()` if it does not settle within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number | undefined,
  onTimeout: () => Error,
): Promise<T> {
  if (ms === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        // Forwarding the wrapped promise's own rejection, not creating one:
        // whatever it rejected with is what the caller must see.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(err);
      },
    );
  });
}
