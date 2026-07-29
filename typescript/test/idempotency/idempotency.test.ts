/**
 * Feature: idempotency by request id — replaying a write with the same
 * `requestId` returns the cached response, not a second row (integration, real
 * server).
 *
 * This is what makes at-least-once client retries safe, and the SDK's own retry
 * layer depends on it. Ported from the Rust suite, which had it while the other
 * two SDKs did not.
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import { EncodeBuilder } from "../../src/verbs.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

describe.skipIf(T === null)("idempotency (integration)", () => {
  const t = T!;

  it("a replayed encode returns the same memory, not a second row", async () => {
    const { client } = await connectFresh(t);
    try {
      // One request value, so one requestId, sent twice: a retry, not a
      // second write.
      const req = new EncodeBuilder("A memory that must not double on retry.").build();
      const first = await client.encode(req);
      const second = await client.encode(req);

      expect(
        second.memoryId,
        "same requestId must return the same memory, not a second row",
      ).toBe(first.memoryId);
      expect(second.lsn, "the retry replays the cached response").toBe(first.lsn);
    } finally {
      await client.close();
    }
  });

  it("a replayed entity create resolves to the same entity", async () => {
    const { client } = await connectFresh(t);
    try {
      const req = {
        entityTypeId: 1,
        canonicalName: "Idempotent Ada",
        aliases: [],
        attributesBlob: new Uint8Array(0),
        sessionId: 0n,
        requestId: newId(),
        actAs: null,
      };
      const first = await client.createEntity(req);
      const second = await client.createEntity(req);

      expect(second.entityId, "same requestId must resolve to the same entity").toEqual(
        first.entityId,
      );
    } finally {
      await client.close();
    }
  });
});
