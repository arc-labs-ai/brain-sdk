/**
 * Feature: typed-graph STATEMENT lifecycle — create → supersede → history →
 * tombstone / retract (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 * Predicates must be namespaced ("namespace:name"); tombstone/retract reason
 * codes are 1..=4.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { BrainClient } from "../../src/client.js";
import type { StatementCreateRequest } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

async function subject(client: BrainClient): Promise<Uint8Array> {
  const r = await client.createEntity({
    entityTypeId: 1,
    canonicalName: "Ada",
    aliases: [],
    attributesBlob: new Uint8Array(),
    requestId: newId(),
  });
  return r.entityId;
}

function fact(subj: Uint8Array, obj: string): StatementCreateRequest {
  return {
    kind: "Fact",
    subject: subj,
    predicate: "org:works_on",
    object: { kind: "Value", value: { kind: "Text", value: obj } },
    confidence: 0.9,
    evidence: { kind: "Inline", ids: [] },
    extractorId: 0,
    validFromUnixNanos: 0n,
    validToUnixNanos: 0xffffffffffffffffn,
    eventAtUnixNanos: 0n,
    schemaVersion: 1,
    requestId: newId(),
  };
}

describe.skipIf(T === null)("statement (integration)", () => {
  const t = T!;

  it("supersede builds a history chain", async () => {
    const { client } = await connectFresh(t);
    try {
      const subj = await subject(client);
      const first = await client.createStatement(fact(subj, "brain"));

      const superseded = await client.supersedeStatement({
        oldStatementId: first.statementId,
        newStatement: fact(subj, "brain-db"),
        requestId: newId(),
      });
      expect([...superseded.chainRoot]).toEqual([...first.chainRoot]);
      expect(superseded.version).toBeGreaterThanOrEqual(2);

      const history = await client.statementHistory({
        anchorId: first.statementId,
        includeTombstoned: true,
      });
      expect(history.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  });

  it("tombstone and retract are accepted", async () => {
    const { client } = await connectFresh(t);
    try {
      const subj = await subject(client);

      const a = await client.createStatement(fact(subj, "one"));
      const ts = await client.tombstoneStatement({
        statementId: a.statementId,
        reason: 1,
        reasonMessage: "superseded by hand",
        requestId: newId(),
      });
      expect(ts.tombstonedAtUnixNanos > 0n).toBe(true);

      const b = await client.createStatement(fact(subj, "two"));
      const rt = await client.retractStatement({
        statementId: b.statementId,
        reason: 1,
        reasonMessage: "was wrong",
        requestId: newId(),
      });
      expect(rt.willZeroAtUnixNanos >= rt.retractedAtUnixNanos).toBe(true);
    } finally {
      await client.close();
    }
  });
});
