/**
 * Feature: QUERY introspection — explain (plan) and trace (execution)
 * (integration, real server).
 *
 * Carries the regression test for the bug this suite's absence allowed. The
 * server's `RetrieverWire` encodes as the **variant-name string**, not its
 * discriminant, and TypeScript was sending integers — so every QUERY_EXPLAIN
 * and QUERY_TRACE from this SDK was rejected outright. Nothing caught it
 * because QUERY has no conformance vector, TypeScript had no query integration
 * suite at all, and the one Rust test that existed used `Auto` — a bare string
 * in either encoding, so it exercised nothing.
 *
 * Every case here therefore uses `Explicit`. A real server is the only oracle
 * that rejects a wrong encoding; reverting the fix makes it answer
 * `invalid type: integer 0, expected enum`.
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import { EncodeBuilder } from "../../src/verbs.js";
import type { QueryRequest, RetrieverWire } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

function query(text: string, retrievers: RetrieverWire[]): QueryRequest {
  return {
    text,
    entityAnchor: null,
    kindFilter: [],
    predicateFilter: [],
    sessionFilter: null,
    timeFilter: null,
    asOfRecordTimeUnixNanos: null,
    confidenceMin: null,
    includeTombstoned: false,
    includeSuperseded: false,
    limit: 10,
    retrievers: { kind: "Explicit", retrievers },
    fusionConfig: null,
    requestId: newId(),
  };
}

describe.skipIf(T === null)("query introspection (integration)", () => {
  const t = T!;

  it("explain returns a plan with explicit retrievers", async () => {
    const { client } = await connectFresh(t);
    try {
      const resp = await client.queryExplain({ query: query("coffee", ["Semantic", "Graph"]) });
      expect(resp.planText.length, "explain returns a non-empty plan").toBeGreaterThan(0);
      expect(resp.estimatedCostMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it("trace returns an execution trace with explicit retrievers", async () => {
    const { client } = await connectFresh(t);
    try {
      await client.encode(new EncodeBuilder("Espresso is a concentrated coffee.").build());
      const resp = await client.queryTrace({ query: query("coffee", ["Lexical"]) });
      expect(resp.traceText.length, "trace returns a non-empty trace").toBeGreaterThan(0);
      expect(resp.totalLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  // Each variant on its own: a single combined request would let one bad name
  // hide behind a good one, depending on the order the server validates them.
  it.each(["Semantic", "Lexical", "Graph"] as RetrieverWire[])(
    "the server accepts retriever %s",
    async (name) => {
      const { client } = await connectFresh(t);
      try {
        const resp = await client.queryExplain({ query: query("anything", [name]) });
        expect(resp.planText.length, `server rejected retriever ${name}`).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    },
  );
});
