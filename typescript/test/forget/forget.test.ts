/**
 * Feature: FORGET — retire episodic memory (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 * Soft FORGET tombstones (invisible to recall, recoverable through the grace
 * window); hard FORGET zeroes the slot now.
 */

import { describe, expect, it } from "vitest";

import { EncodeBuilder, ForgetBuilder, RecallBuilder } from "../../src/verbs.js";
import { ForgetMode } from "../../src/wire/types.js";
import { connectFresh, itTarget, recallUntil } from "../common/harness.js";

const T = itTarget();

describe.skipIf(T === null)("forget (integration)", () => {
  const t = T!;

  it("soft forget removes a memory from recall", async () => {
    const { client } = await connectFresh(t);
    try {
      const id = (
        await client.encode(new EncodeBuilder("The meeting is scheduled for Tuesday.").build())
      ).memoryId;

      const req = new RecallBuilder("When is the meeting?").text(true).build();
      // Wait until it is actually recallable, so the post-forget assertion is
      // meaningful (not vacuously true because the index lagged).
      const before = await recallUntil(client, req, (a) => a.memories.some((m) => m.memoryId === id));
      expect(before.memories.some((m) => m.memoryId === id)).toBe(true);

      await client.forget(new ForgetBuilder(id).withMode(ForgetMode.Soft).build());

      const after = await recallUntil(client, req, (a) => !a.memories.some((m) => m.memoryId === id));
      expect(after.memories.some((m) => m.memoryId === id)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("hard forget is idempotent on a missing id", async () => {
    const { client } = await connectFresh(t);
    try {
      const id = (
        await client.encode(new EncodeBuilder("A secret worth zeroing immediately.").build())
      ).memoryId;

      // Hard FORGET zeroes the slot now; a retry is a lenient no-op success.
      await client.forget(new ForgetBuilder(id).hard().build());
      await client.forget(new ForgetBuilder(id).hard().build());
    } finally {
      await client.close();
    }
  });
});
