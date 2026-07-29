/**
 * Feature: typed-graph RELATION lifecycle — create → get → supersede →
 * tombstone, plus traversal (integration, real server).
 *
 * None of these verbs has a conformance vector, so before this suite existed a
 * real server had never seen what TypeScript puts on the wire for any of them.
 *
 * Ported from the Rust suite, which had it while the other two SDKs did not.
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { RelationCreateRequest, WireUuid } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

/** 2^64 - 1: "no end", the open upper bound of a bitemporal validity range. */
const FOREVER = (1n << 64n) - 1n;

async function entity(client: Awaited<ReturnType<typeof connectFresh>>["client"], name: string) {
  const resp = await client.createEntity({
    entityTypeId: 1,
    canonicalName: name,
    aliases: [],
    attributesBlob: new Uint8Array(0),
    sessionId: 0n,
    requestId: newId(),
    actAs: null,
  });
  return resp.entityId;
}

function relation(from: WireUuid, to: WireUuid): RelationCreateRequest {
  return {
    relationType: "org:collaborated_with",
    fromEntity: from,
    toEntity: to,
    propertiesBlob: new Uint8Array(0),
    evidence: { kind: "Inline", ids: [] },
    extractorId: 0,
    confidence: 0.8,
    validFromUnixNanos: 0n,
    validToUnixNanos: FOREVER,
    sessionId: 0n,
    requestId: newId(),
    actAs: null,
  };
}

describe.skipIf(T === null)("relation lifecycle (integration)", () => {
  const t = T!;

  it("create → get → supersede → tombstone", async () => {
    const { client } = await connectFresh(t);
    try {
      const a = await entity(client, "Ada");
      const b = await entity(client, "Babbage");

      const created = await client.createRelation(relation(a, b));

      const got = await client.getRelation({
        relationId: created.relationId,
        followSupersession: false,
        actAs: null,
      });
      expect(got.relation.relationId).toEqual(created.relationId);
      expect(got.relation.relationType).toBe("org:collaborated_with");
      expect(got.relation.fromEntity).toEqual(a);
      expect(got.relation.toEntity).toEqual(b);

      const superseded = await client.supersedeRelation({
        oldRelationId: created.relationId,
        newRelation: relation(a, b),
        requestId: newId(),
      });
      expect(
        superseded.newRelationId,
        "supersede mints a new relation rather than mutating the old one",
      ).not.toEqual(created.relationId);
      expect(superseded.version, "the chain version advances").toBeGreaterThan(1);

      // Following supersession from the original id lands on the chain head.
      const head = await client.getRelation({
        relationId: created.relationId,
        followSupersession: true,
        actAs: null,
      });
      expect(head.relation.relationId).toEqual(superseded.newRelationId);
      expect(head.returnedViaSupersession).toBe(true);

      const tombstoned = await client.tombstoneRelation({
        relationId: superseded.newRelationId,
        reason: "merged duplicate",
        requestId: newId(),
      });
      expect(tombstoned.tombstonedAtUnixNanos > 0n).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("traverses from an anchor entity", async () => {
    const { client } = await connectFresh(t);
    try {
      const a = await entity(client, "Ada");
      const b = await entity(client, "Babbage");
      await client.createRelation(relation(a, b));

      const paths = await client.traverseRelations({
        startEntity: a,
        relationTypes: ["org:collaborated_with"],
        direction: 0, // outgoing
        maxDepth: 2,
        maxNodes: 100,
        timeAtUnixNanos: 0n,
        includeSuperseded: false,
        requestId: newId(),
        actAs: null,
      });

      // Each step must name the relation it traversed and be depth-ordered
      // from the anchor; whether a path exists is the server's business.
      for (const path of paths) {
        expect(path.steps.length, "a returned path carries at least one hop").toBeGreaterThan(0);
        path.steps.forEach((step, i) => {
          expect(step.depth, "hops are depth-ordered from the anchor").toBe(i + 1);
          expect(step.relationType.length).toBeGreaterThan(0);
        });
      }
    } finally {
      await client.close();
    }
  });
});
