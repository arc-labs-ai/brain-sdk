/**
 * Feature: RECALL — read episodic memory (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 * ENCODE is durable on ack but the semantic index becomes searchable a beat
 * later, so these use `recallUntil` to poll for read-your-writes visibility.
 */

import { describe, expect, it } from "vitest";

import { EncodeBuilder, RecallBuilder } from "../../src/verbs.js";
import { connectFresh, itTarget, recallUntil } from "../common/harness.js";

const T = itTarget();

describe.skipIf(T === null)("recall (integration)", () => {
  const t = T!;

  it("finds what was encoded", async () => {
    const { client } = await connectFresh(t);
    try {
      const stored = (
        await client.encode(new EncodeBuilder("My favorite programming language is Rust.").build())
      ).memoryId;

      const req = new RecallBuilder("What language do I like?").maxResults(10).text(true).build();
      const answer = await recallUntil(client, req, (a) =>
        a.memories.some((m) => m.memoryId === stored),
      );
      expect(answer.answerKind).not.toBe("None");
      expect(answer.memories.some((m) => m.memoryId === stored)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("respects the maxResults cap", async () => {
    const { client } = await connectFresh(t);
    try {
      for (let i = 0; i < 8; i++) {
        await client.encode(new EncodeBuilder(`Fact number ${i} about coffee brewing.`).build());
      }
      const req = new RecallBuilder("coffee").maxResults(3).text(true).build();
      const answer = await recallUntil(client, req, (a) => a.memories.length > 0);
      expect(answer.memories.length).toBeGreaterThan(0);
      expect(answer.memories.length).toBeLessThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("accepts a confidence threshold", async () => {
    const { client } = await connectFresh(t);
    try {
      await client.encode(new EncodeBuilder("The capital of Japan is Tokyo.").build());
      const req = new RecallBuilder("capital of Japan").confidence(0).text(true).build();
      const answer = await recallUntil(client, req, (a) => a.memories.length > 0);
      expect(answer.memories.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
