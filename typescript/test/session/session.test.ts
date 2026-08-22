/**
 * Feature: SESSION registry CRUD — create → list (present) → delete → list
 * (gone), plus the idempotent-replay edge (integration, real server).
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline. Each
 * test mints a fresh, isolated agent whose space owns the sessions it creates,
 * so the membership assertions are unaffected by other tests. `sessionId = 0` is
 * the default, non-deletable session, so tests pick a random non-zero u64.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import type { BrainClient } from "../../src/client.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

function nonzeroSessionId(): bigint {
  // A random u64 in [1, 2^63) — never 0 (the default, non-deletable session).
  const hi = BigInt(Math.floor(Math.random() * 0x7fffffff)) << 32n;
  const lo = BigInt(Math.floor(Math.random() * 0xffffffff));
  return (hi | lo) + 1n;
}

async function sessionIds(client: BrainClient): Promise<bigint[]> {
  const listed = await client.listSessions({ limit: 0, actAs: null });
  return listed.sessions.map((s) => s.sessionId);
}

describe.skipIf(T === null)("session (integration)", () => {
  const t = T!;

  it("crud round-trip: create → list → delete → list", async () => {
    const { client } = await connectFresh(t);
    try {
      const sid = nonzeroSessionId();

      const created = await client.createSession({
        sessionId: sid,
        title: "round-trip",
        requestId: newId(),
        actAs: null,
      });
      expect(created.created).toBe(true);
      expect(created.sessionId).toBe(sid);

      // listSessions must surface the session we just provisioned.
      expect(await sessionIds(client)).toContain(sid);

      // Hard delete zeroes immediately, so the registry row disappears at once.
      const deleted = await client.deleteSession({
        sessionId: sid,
        hard: true,
        requestId: newId(),
        actAs: null,
      });
      expect(deleted.existed).toBe(true);
      expect(deleted.sessionId).toBe(sid);

      expect(await sessionIds(client)).not.toContain(sid);
    } finally {
      await client.close();
    }
  });

  it("create is idempotent", async () => {
    const { client } = await connectFresh(t);
    try {
      const sid = nonzeroSessionId();

      const first = await client.createSession({
        sessionId: sid,
        title: null,
        requestId: newId(),
        actAs: null,
      });
      expect(first.created).toBe(true);

      const second = await client.createSession({
        sessionId: sid,
        title: null,
        requestId: newId(),
        actAs: null,
      });
      expect(second.created).toBe(false);
      expect(second.sessionId).toBe(sid);
    } finally {
      await client.close();
    }
  });
});
