/**
 * A fixed-size connection pool over `BrainClient`.
 *
 * Each `BrainClient` is already a *multiplexed* connection — one socket serving
 * many concurrent requests demultiplexed by `streamId` — so a pool isn't needed
 * for concurrency. What a pool buys is **socket-level parallelism**: spreading
 * load across N independent TCP connections (and thus N server-side connection
 * slots), and isolating a single slow or stalled socket from the rest of the
 * workload.
 *
 * `Pool.connect` opens `size` connections up front, each running its own
 * handshake. `get()` hands back a `BrainClient` round-robin; callers issue
 * verbs on it directly (its methods are concurrency-safe over the mux pump).
 *
 * `getHealthy()` additionally replaces a member whose socket has died (the
 * server restarted, the peer hung up) before handing it out — `get()` stays
 * the zero-overhead path for callers who do their own error handling.
 * `close()` sends BYE + closes every member.
 */

import { BrainClient, type ClientConfig } from "./client.js";
import { ProtocolError } from "./errors.js";

/** A fixed-size set of `BrainClient` connections handed out round-robin. */
export class Pool {
  private next = 0;

  /** Guards one reconnect per slot, so a burst of callers finding the same
   * dead member opens one socket rather than N. */
  private readonly reconnecting: (Promise<BrainClient> | null)[];

  private constructor(
    private readonly clients: BrainClient[],
    private readonly host: string,
    private readonly port: number,
    private readonly config: ClientConfig,
  ) {
    this.reconnecting = new Array(clients.length).fill(null);
  }

  /**
   * Open `size` connections to `host:port`, each running its own handshake, and
   * resolve the pool. Every member shares the config's credential, so the
   * server binds them to the same agent; they remain individually identifiable
   * by session id. Rejects if `size < 1`; on a mid-open failure, closes the
   * members already opened and re-throws.
   */
  static async connect(
    host: string,
    port: number,
    size: number,
    config: ClientConfig,
  ): Promise<Pool> {
    if (size < 1) {
      throw new ProtocolError("connection pool size must be >= 1");
    }
    const clients: BrainClient[] = [];
    try {
      for (let i = 0; i < size; i += 1) {
        clients.push(await BrainClient.connect(host, port, config));
      }
    } catch (err) {
      // Best-effort close of the members opened so far before re-throwing.
      await Promise.allSettled(clients.map((c) => c.close()));
      throw err;
    }
    return new Pool(clients, host, port, config);
  }

  /** The number of pooled connections. */
  size(): number {
    return this.clients.length;
  }

  /** Borrow the next connection, round-robin. */
  get(): BrainClient {
    const client = this.clients[this.next % this.clients.length]!;
    this.next += 1;
    return client;
  }

  /**
   * Borrow the next connection, reconnecting it first if its socket has died.
   *
   * A pooled member outlives any single request, so a server restart leaves
   * every borrower holding the same dead socket until the process is bounced.
   * This checks `isClosed` and dials a replacement in place. Requests already
   * in flight on the old connection fail as before; new ones get the fresh
   * socket.
   *
   * Concurrent callers that land on the same dead slot share one reconnect
   * rather than opening a socket each.
   */
  async getHealthy(): Promise<BrainClient> {
    const idx = this.next % this.clients.length;
    this.next += 1;
    const current = this.clients[idx]!;
    if (!current.isClosed) {
      return current;
    }
    const inFlight = this.reconnecting[idx];
    if (inFlight) {
      return inFlight;
    }
    const attempt = (async () => {
      try {
        const fresh = await BrainClient.connect(this.host, this.port, this.config);
        this.clients[idx] = fresh;
        return fresh;
      } finally {
        this.reconnecting[idx] = null;
      }
    })();
    this.reconnecting[idx] = attempt;
    return attempt;
  }

  /** Send BYE and close every pooled connection (best-effort). */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}
