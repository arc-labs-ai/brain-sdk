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
 * Deferred (later work): transparent reconnect of a dropped member, health-
 * checking. `close()` sends BYE + closes every member.
 */

import { BrainClient, type ClientConfig, newId } from "./client.js";
import { ProtocolError } from "./errors.js";

/** A fixed-size set of `BrainClient` connections handed out round-robin. */
export class Pool {
  private next = 0;

  private constructor(private readonly clients: BrainClient[]) {}

  /**
   * Open `size` connections to `host:port`, each running its own handshake, and
   * resolve the pool. A fresh `agentId` is minted per member (so they are
   * distinguishable server-side) unless `config` pins one. Rejects if
   * `size < 1`; on a mid-open failure, closes the members already opened and
   * re-throws.
   */
  static async connect(
    host: string,
    port: number,
    size: number,
    config: ClientConfig = {},
  ): Promise<Pool> {
    if (size < 1) {
      throw new ProtocolError("connection pool size must be >= 1");
    }
    const clients: BrainClient[] = [];
    try {
      for (let i = 0; i < size; i += 1) {
        // Distinct agent per socket unless the caller pinned one.
        const cfg: ClientConfig = { ...config, agentId: config.agentId ?? newId() };
        clients.push(await BrainClient.connect(host, port, cfg));
      }
    } catch (err) {
      // Best-effort close of the members opened so far before re-throwing.
      await Promise.allSettled(clients.map((c) => c.close()));
      throw err;
    }
    return new Pool(clients);
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

  /** Send BYE and close every pooled connection (best-effort). */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}
