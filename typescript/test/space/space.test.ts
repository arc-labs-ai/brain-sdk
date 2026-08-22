/**
 * Feature: SPACE registry CRUD — create → list (present) → delete → list (gone),
 * plus the idempotent-replay and not-found edges (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline. Each
 * test mints a fresh, isolated agent, so the space it provisions is its own.
 *
 * Membership note: the harness binds a fresh key to a *raw* 16-byte space id
 * (`newId()`), which has no structured `"namespace:space"` string form, so the
 * server echoes an empty `space_id` string for it — and every fresh agent shares
 * the same `namespace`, so `list_spaces` returns every agent's row. We therefore
 * cannot single out our row by its string id. Instead the round-trip pins the
 * "gone after delete" contract behaviorally: a create after a delete reports
 * `created = true` (a still-present row would replay as `created = false`, which
 * the idempotent-replay test below confirms).
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { BrainClient } from "../../src/client.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

async function listSpaces(client: BrainClient): Promise<number> {
  const listed = await client.listSpaces({ limit: 0, actAs: null });
  expect(typeof listed.crossShardComplete).toBe("boolean");
  return listed.spaces.length;
}

describe.skipIf(T === null)("space (integration)", () => {
  const t = T!;

  it("crud round-trip: create → list → delete → re-create (proves gone)", async () => {
    const { client } = await connectFresh(t);
    try {
      const created = await client.createSpace({ metadata: null, requestId: newId(), actAs: null });
      // A never-before-provisioned effective space is genuinely new.
      expect(created.created).toBe(true);

      // list_spaces surfaces at least the space we just provisioned.
      expect(await listSpaces(client)).toBeGreaterThanOrEqual(1);

      const deleted = await client.deleteSpace({ requestId: newId(), actAs: null });
      expect(deleted.existed).toBe(true);
      expect(deleted.spaceId).toBe(created.spaceId);

      // The registry row is genuinely gone: re-creating provisions afresh
      // (created = true), where a surviving row would replay as created = false.
      const recreated = await client.createSpace({ metadata: null, requestId: newId(), actAs: null });
      expect(recreated.created).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("create is idempotent", async () => {
    const { client } = await connectFresh(t);
    try {
      const first = await client.createSpace({ metadata: null, requestId: newId(), actAs: null });
      expect(first.created).toBe(true);

      // A create for an existing space returns the existing row, created=false.
      const second = await client.createSpace({ metadata: null, requestId: newId(), actAs: null });
      expect(second.created).toBe(false);
      expect(second.spaceId).toBe(first.spaceId);
    } finally {
      await client.close();
    }
  });

  it("delete of a never-provisioned space reports absent", async () => {
    const { client } = await connectFresh(t);
    try {
      // Fresh agent that never provisioned or wrote: no registry row.
      const deleted = await client.deleteSpace({ requestId: newId(), actAs: null });
      expect(deleted.existed).toBe(false);
      expect(deleted.memoriesForgotten).toBe(0n);
    } finally {
      await client.close();
    }
  });
});
