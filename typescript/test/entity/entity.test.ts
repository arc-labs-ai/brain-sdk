/**
 * Feature: typed-graph ENTITY lifecycle — create → update → rename → merge →
 * unmerge → tombstone (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { BrainClient } from "../../src/client.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

async function createEntity(client: BrainClient, name: string): Promise<Uint8Array> {
  const r = await client.createEntity({
    entityTypeId: 1,
    canonicalName: name,
    aliases: [],
    attributesBlob: new Uint8Array(),
    requestId: newId(),
  });
  return r.entityId;
}

describe.skipIf(T === null)("entity (integration)", () => {
  const t = T!;

  it("update → rename → tombstone", async () => {
    const { client } = await connectFresh(t);
    try {
      const id = await createEntity(client, "Ada");

      const updated = await client.updateEntity({
        entityId: id,
        canonicalName: "Ada Lovelace",
        aliases: ["Ada"],
        attributesBlob: new TextEncoder().encode("role=mathematician"),
        requestId: newId(),
      });
      expect(updated.entity.canonicalName).toBe("Ada Lovelace");

      const renamed = await client.renameEntity({
        entityId: id,
        newCanonicalName: "Countess Lovelace",
        moveToAlias: true,
        requestId: newId(),
      });
      expect(renamed.entity.canonicalName).toBe("Countess Lovelace");
      expect(renamed.entity.aliases).toContain("Ada Lovelace");

      const ts = await client.tombstoneEntity({
        entityId: id,
        reason: "test cleanup",
        requestId: newId(),
      });
      expect(ts.tombstonedAtUnixNanos > 0n).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("merge → unmerge", async () => {
    const { client } = await connectFresh(t);
    try {
      const survivor = await createEntity(client, "NYC");
      const merged = await createEntity(client, "New York City");

      const m = await client.mergeEntities({
        survivor,
        merged,
        confidence: 0.95,
        reason: "same city",
        requestId: newId(),
      });
      expect(m.gracePeriodSeconds > 0n).toBe(true);

      const u = await client.unmergeEntity({ mergedEntity: merged, requestId: newId() });
      expect([...u.restoredEntityId]).toEqual([...merged]);
    } finally {
      await client.close();
    }
  });
});
