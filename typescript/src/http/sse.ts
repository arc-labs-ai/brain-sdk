/**
 * The change feed over Server-Sent Events.
 *
 * {@link Subscription} is an async iterable, so `for await (const item of
 * feed)` is the whole loop — the shape a TypeScript caller expects, and the
 * counterpart to the wire client's `next()`.
 *
 * Unsubscribing is closing the subscription: the edge tears the Brain-side
 * subscription down when the HTTP response closes. `close()` does that, and
 * breaking out of a `for await` calls it for you through the iterator's
 * `return()`.
 *
 * Built on the `fetch` body stream — no `EventSource`, which cannot send an
 * `Authorization` header and so cannot reach an authenticated feed at all.
 */
import { BrainHttpError } from "./errors.js";
import { decodeJsonBody } from "./json.js";
import type { FeedItem, SubscriptionClosed, SubscriptionEvent } from "./types.js";

/** One dispatched SSE frame, before it is decoded. */
interface Frame {
  event: string | undefined;
  data: string;
}

/**
 * A live change feed.
 *
 * Holds the HTTP response open, so a caller that stops consuming it
 * backpressures the edge — which backpressures Brain — rather than letting
 * events pile up unbounded.
 */
export class Subscription implements AsyncIterable<FeedItem> {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  /** Bytes received but not yet forming a complete frame. */
  private buf = "";
  private eventName: string | undefined;
  private data: string[] = [];
  private lastId: string | undefined;
  private closed = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /**
   * The id of the most recent event — its LSN.
   *
   * Pass it as `fromLsn` on a reconnect to resume after it. Kept here so a
   * caller that loses the connection mid-loop still has it; the alternative
   * is tracking every event's lsn yourself purely to know where you were.
   */
  get lastEventId(): string | undefined {
    return this.lastId;
  }

  /** Close the feed. The edge unsubscribes from Brain when this lands. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reader.cancel().catch(() => {
      // Cancelling an already-broken stream is not a failure worth raising:
      // the caller asked for the feed to stop, and it has.
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<FeedItem> {
    try {
      for (;;) {
        // Anything already buffered may complete a frame without another
        // read — one TCP segment often carries several events.
        let frame = this.takeFrame();
        while (frame) {
          yield decode(frame);
          frame = this.takeFrame();
        }
        const { done, value } = await this.reader.read();
        if (done) {
          // A clean close with nothing pending ends the iteration: the edge
          // closes after its terminal event, which the caller has seen.
          return;
        }
        this.buf += this.decoder.decode(value, { stream: true });
      }
    } finally {
      // Covers `break`, `throw` and normal completion alike — the generator's
      // `return()` runs this, which is what makes breaking out of a
      // `for await` unsubscribe.
      await this.close();
    }
  }

  /** Pull one complete frame out of the buffer, if there is one. */
  private takeFrame(): Frame | undefined {
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) return undefined;
      // `\r\n` is as legal as `\n`; servers and proxies differ.
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);

      if (line === "") {
        // Blank line dispatches the frame.
        if (this.data.length === 0) {
          // A keep-alive comment produces no data; nothing to dispatch.
          this.eventName = undefined;
          continue;
        }
        const frame: Frame = { event: this.eventName, data: this.data.join("\n") };
        this.eventName = undefined;
        this.data = [];
        return frame;
      }

      // A comment — the keep-alive the edge sends on an idle feed.
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") this.eventName = value;
      else if (field === "id") this.lastId = value;
      else if (field === "data") this.data.push(value);
      // `retry` and anything unknown are ignored, per the SSE spec.
    }
  }
}

function decode(frame: Frame): FeedItem {
  let payload: unknown;
  try {
    payload = decodeJsonBody(frame.data);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: cause is passed in the options bag below
    throw new BrainHttpError(0, "transport", `decode subscription frame: ${String(e)}`, {
      cause: e,
    });
  }
  return frame.event === "closed"
    ? { kind: "closed", closed: payload as SubscriptionClosed }
    : { kind: "event", event: payload as SubscriptionEvent };
}
