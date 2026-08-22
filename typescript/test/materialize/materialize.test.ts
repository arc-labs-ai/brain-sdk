/**
 * Feature: MATERIALIZE_PROCEDURAL — assemble a procedural-memory system block
 * for the caller's space (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline. Each
 * test mints a fresh, isolated agent so the candidate pool it materializes over
 * is entirely its own. The corpus is tiny and extraction is LLM-driven and
 * best-effort, so the count/content assertions are lenient — the contract pinned
 * here is the round-trip and the response shape, not a specific extraction.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { BrainClient } from "../../src/client.js";
import { EncodeBuilder } from "../../src/verbs.js";
import type { MaterializeProceduralResponse } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

function materialize(
  client: BrainClient,
  categories: string[],
  minConfidence = 0,
): Promise<MaterializeProceduralResponse> {
  return client.materializeProcedural({
    spaceId: client.spaceId,
    sessionFilter: null,
    topK: 10,
    minConfidence,
    categories,
    requestId: newId(),
  });
}

function assertShape(resp: MaterializeProceduralResponse): void {
  // The server always renders a system block (a header even when nothing was
  // distilled), so we pin the field's type, not its emptiness.
  expect(typeof resp.systemBlock).toBe("string");
  expect(Array.isArray(resp.statementIds)).toBe(true);
  for (const sid of resp.statementIds) expect(sid).toBeInstanceOf(Uint8Array);
  expect(typeof resp.totalCandidates).toBe("number");
  expect(Number.isInteger(resp.totalCandidates)).toBe(true);
  expect(resp.totalCandidates).toBeGreaterThanOrEqual(0);
  expect(typeof resp.trimmedByBudget).toBe("boolean");
  // The returned statement set never exceeds the candidate pool, nor top_k.
  expect(resp.statementIds.length).toBeLessThanOrEqual(resp.totalCandidates);
  expect(resp.statementIds.length).toBeLessThanOrEqual(10);
}

describe.skipIf(T === null)("materialize (integration)", () => {
  const t = T!;

  it("round-trip: encode source memories → materialize a coherent block", async () => {
    const { client } = await connectFresh(t);
    try {
      // Instruction-shaped memories give the extractor procedural material.
      // `wait(Derived)` blocks until async extraction finishes, so the
      // statements are on disk before we materialize — no visibility race.
      for (const text of [
        "I always prefer concise answers over long explanations.",
        "When writing code, I like thorough comments and small functions.",
        "I dislike being interrupted with clarifying questions mid-task.",
      ]) {
        const resp = await client.encode(new EncodeBuilder(text).wait().build());
        expect(resp.lsn > 0n).toBe(true);
      }

      const proc = await materialize(client, []);
      assertShape(proc);
    } finally {
      await client.close();
    }
  });

  it("on an empty space returns a well-formed empty block, not an error", async () => {
    const { client } = await connectFresh(t);
    try {
      const proc = await materialize(client, ["style"], 0.5);
      assertShape(proc);
      expect(proc.totalCandidates).toBe(0);
      expect(proc.statementIds).toEqual([]);
      // Nothing to trim when there are no candidates.
      expect(proc.trimmedByBudget).toBe(false);
    } finally {
      await client.close();
    }
  });
});
