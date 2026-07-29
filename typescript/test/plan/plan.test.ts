/**
 * Feature: PLAN and REASON — goal-directed traversal and inference over stored
 * memory (integration, real server).
 *
 * Both are streamed verbs; the client flattens the frames. The assertions are
 * on the shape a caller depends on — contiguous step indices, honored caps —
 * rather than on a path or an inference existing, since neither is guaranteed
 * for arbitrary inputs and a test that assumed one would fail against a correct
 * server.
 *
 * `confidenceThreshold` on REASON gates *traversal* — which premises reasoning
 * will follow — not the *output*, so a returned inference can carry a computed
 * confidence below it. No floor is asserted for that reason.
 *
 * Ported from the Rust suites, which had them while the other two SDKs did not.
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { EncodeBuilder } from "../../src/verbs.js";
import { PlanStrategy } from "../../src/wire/types.js";
import type { PlanBudget, PlanState } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

/**
 * The server caps `budget.maxSteps` at its configured `max_traversal_depth`
 * (10 by default) and rejects anything larger with a validation error, so a
 * realistic budget stays at or under that bound.
 */
const BUDGET: PlanBudget = {
  maxSteps: 8,
  maxWallTimeMs: 5_000,
  maxBranchesExplored: 256,
};

const MAX_INFERENCES = 32;

describe.skipIf(T === null)("plan and reason (integration)", () => {
  const t = T!;

  it("plans between two memories", async () => {
    const { client } = await connectFresh(t);
    try {
      const start = (await client.encode(new EncodeBuilder("Start: I am in Paris.").build()))
        .memoryId;
      const goal = (await client.encode(new EncodeBuilder("Goal: I want to reach Rome.").build()))
        .memoryId;

      const steps = await client.plan({
        start: { kind: "ByMemoryId", memoryId: start } as PlanState,
        goal: { kind: "ByMemoryId", memoryId: goal } as PlanState,
        budget: BUDGET,
        strategyHint: PlanStrategy.Auto,
        sessionFilter: null,
        requestId: null,
        txnId: null,
        trace: false,
        actAs: null,
      });

      // A path may or may not exist between two unlinked memories; either way
      // the server answers with a well-formed step list rather than erroring.
      steps.forEach((step, i) => {
        expect(step.stepIndex, "steps are contiguously indexed").toBe(i);
      });
    } finally {
      await client.close();
    }
  });

  it("plans toward a text goal", async () => {
    const { client } = await connectFresh(t);
    try {
      const start = (
        await client.encode(new EncodeBuilder("The project kicked off in January.").build())
      ).memoryId;

      const steps = await client.plan({
        start: { kind: "ByMemoryId", memoryId: start } as PlanState,
        goal: { kind: "ByText", text: "the project shipped" } as PlanState,
        budget: BUDGET,
        strategyHint: PlanStrategy.AStar,
        sessionFilter: null,
        requestId: null,
        txnId: null,
        trace: false,
        actAs: null,
      });

      steps.forEach((step, i) => {
        expect(step.stepIndex, "steps are contiguously indexed").toBe(i);
      });
    } finally {
      await client.close();
    }
  });

  it("reasons from a text observation, honoring the inference cap", async () => {
    const { client } = await connectFresh(t);
    try {
      const inferences = await client.reason({
        observation: { kind: "ByText", text: "the lights are off" },
        depth: 4,
        confidenceThreshold: 0.6,
        sessionFilter: null,
        maxInferences: MAX_INFERENCES,
        budgetWallTimeMs: 2_000,
        requestId: null,
        txnId: null,
        trace: false,
        actAs: null,
      });

      expect(
        inferences.length,
        "server must honor the maxInferences cap",
      ).toBeLessThanOrEqual(MAX_INFERENCES);
    } finally {
      await client.close();
    }
  });

  it("reasons from a stored memory", async () => {
    const { client } = await connectFresh(t);
    try {
      const memoryId = (
        await client.encode(new EncodeBuilder("The server room lost power at 3am.").build())
      ).memoryId;

      const inferences = await client.reason({
        observation: { kind: "ByMemoryId", memoryId },
        depth: 4,
        confidenceThreshold: 0.6,
        sessionFilter: null,
        maxInferences: MAX_INFERENCES,
        budgetWallTimeMs: 2_000,
        requestId: null,
        txnId: null,
        trace: false,
        actAs: null,
      });

      expect(inferences.length).toBeLessThanOrEqual(MAX_INFERENCES);
      inferences.forEach((step, i) => {
        expect(step.stepIndex, "inferences are contiguously indexed").toBe(i);
      });
    } finally {
      await client.close();
    }
  });
});
