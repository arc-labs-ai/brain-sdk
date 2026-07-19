/**
 * Feature: ENCODE — write episodic memory (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 * Each test mints a fresh, isolated agent.
 */

import { describe, expect, it } from "vitest";

import { EncodeBuilder } from "../../src/verbs.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

describe.skipIf(T === null)("encode (integration)", () => {
  const t = T!;

  it("returns a durable id", async () => {
    const { client } = await connectFresh(t);
    try {
      const resp = await client.encode(new EncodeBuilder("The Eiffel Tower is in Paris.").build());
      // WAL-before-ack: a returned response means it was durably logged.
      expect(resp.lsn > 0n).toBe(true);
      expect(resp.salience).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it("carries context and event time", async () => {
    const { client } = await connectFresh(t);
    try {
      const req = new EncodeBuilder("We shipped v1 on launch day.")
        .context(42n)
        .occurredAt(1_700_000_000_000_000_000n)
        .build();
      const resp = await client.encode(req);
      expect(resp.lsn > 0n).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("is idempotent on identical text", async () => {
    const { client } = await connectFresh(t);
    try {
      const req = new EncodeBuilder("A fact I might repeat verbatim.").build();
      const first = await client.encode(req);
      const second = await client.encode(req);
      expect(first.lsn > 0n && second.lsn > 0n).toBe(true);
    } finally {
      await client.close();
    }
  });
});
