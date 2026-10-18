/**
 * Every HTTP verb, against a running edge, success paths and failure paths.
 *
 * Set `BRAIN_SDK_IT_HTTP` and `BRAIN_SDK_IT_HTTP_KEY` (or
 * `BRAIN_SDK_IT_API_KEY`) to run these. `BRAIN_SDK_IT_REQUIRED=1` turns a
 * missing configuration into a failure, which is what CI wants — a silent
 * skip is how a live suite rots without anyone noticing.
 *
 * WHY THIS EXISTS ALONGSIDE `http-edge.test.ts`. That file covers six verbs:
 * whoami, capabilities, encode, recall, memoryList, forget. The client
 * exposes **25**, and the nineteen with no live coverage are exactly where
 * drift has been found — `includeTrace` and the list cursors shipped in one
 * SDK only, and nothing exercising them end to end would have said so.
 *
 * FAILURES ARE ASSERTED, NOT AVOIDED. Half of what an SDK owes its caller is
 * a legible error: the right status, a code to branch on, and no retry of a
 * request that cannot succeed. Each failure below pins a status observed
 * against a real server.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { BrainHttpClient, BrainHttpError } from "../src/http/index.js";

/** `1` is Person in the stock schema. `listEntities` REQUIRES a type filter —
 *  the edge answers 400 without one — so this is not cosmetic. */
const PERSON_TYPE_ID = 1;

/** Syntactically valid and certainly absent. */
const ABSENT_UUID = "00000000-0000-0000-0000-000000000000";

const baseUrl = process.env.BRAIN_SDK_IT_HTTP;
const apiKey = process.env.BRAIN_SDK_IT_HTTP_KEY ?? process.env.BRAIN_SDK_IT_API_KEY;
const configured = Boolean(baseUrl && apiKey);

beforeAll(() => {
  if (!configured && process.env.BRAIN_SDK_IT_REQUIRED === "1") {
    throw new Error(
      "live edge tests require BRAIN_SDK_IT_HTTP and BRAIN_SDK_IT_HTTP_KEY " +
        "(or BRAIN_SDK_IT_API_KEY)",
    );
  }
});

/**
 * A client tuned for a LIVE suite, not for a hot path.
 *
 * The plan's ceiling is 60 requests/minute on Free (`arc_entitlements`), and
 * an all-operations pass makes more than that — so being throttled part-way
 * through is the normal case, not an error. The server answers 429 with
 * `Retry-After`; the default policy clamps that hint to `maxDelayMs` (2s),
 * which is far short of a 60s fixed window, so the retries burn out and the
 * suite fails on a condition that would have cleared by itself.
 *
 * Raising the cap past the window lets the hint through, which turns
 * throttling into a pause instead of a failure — and exercises the 429 retry
 * path against a real server while it is at it.
 */
const client = () =>
  new BrainHttpClient({
    apiKey: apiKey!,
    baseUrl: baseUrl!,
    retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 70_000 },
  });

/** One memory that exists for the body of `fn`, then does not — so the suite
 *  is re-runnable and leaves the namespace as it found it. */
async function withMemory<T>(fn: (id: string, text: string) => Promise<T>): Promise<T> {
  const c = client();
  const text = `all-ops probe ${crypto.randomUUID()}: Dana prefers dark mode in the editor.`;
  const created = await c.encode({ text });
  try {
    return await fn(created.memoryId, text);
  } finally {
    await c.forget({ memoryId: created.memoryId });
  }
}

/** The error an SDK call threw, or `undefined` when it unexpectedly resolved. */
async function errorFrom(fn: () => Promise<unknown>): Promise<BrainHttpError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    if (e instanceof BrainHttpError) return e;
    throw e;
  }
}

describe.skipIf(!configured)("every HTTP operation, live", () => {
  // ── identity ─────────────────────────────────────────────────────────────

  it("whoami reports named permission flags", async () => {
    const me = await client().whoami();
    expect(me.namespace).not.toBe("");
    expect(me.spaceId).not.toBe("");
    // Named flags, not a bitset. The gateway served the latter for a while.
    expect(typeof me.permissions.canEncode).toBe("boolean");
    expect(typeof me.permissions.canRecall).toBe("boolean");
  });

  it("capabilities describes the shard", async () => {
    const caps = await client().capabilities();
    expect(caps.vectorDim).toBeGreaterThan(0);
    expect(Array.isArray(caps.schemaNamespaces)).toBe(true);
  });

  // ── memory lifecycle ─────────────────────────────────────────────────────

  it("encodes, recalls, inspects and lists a memory", async () => {
    await withMemory(async (id, text) => {
      const c = client();
      const answer = await c.recall({ query: text, maxResults: 5 });
      expect(["single", "many", "none"]).toContain(answer.answerKind);
      expect(answer.memories.some((m) => m.memoryId === id)).toBe(true);

      const inspected = await c.memoryInspect(id);
      expect(inspected.found).toBe(true);

      const page = await c.memoryList({ limit: 100 });
      expect(page.items.some((m) => m.memoryId === id)).toBe(true);
    });
  });

  it("returns the pipeline trace when asked", async () => {
    await withMemory(async (_id, text) => {
      const answer = await client().recall({ query: text, maxResults: 5, includeTrace: true });
      expect(answer.trace, "includeTrace was requested but no trace came back").toBeDefined();
      // A JSON STRING, not an object: the ids inside are 128-bit and a JSON
      // number would round them.
      expect(typeof answer.trace).toBe("string");
      JSON.parse(answer.trace!);
    });
  });

  it("omits the trace by default", async () => {
    await withMemory(async (_id, text) => {
      expect((await client().recall({ query: text, maxResults: 1 })).trace).toBeUndefined();
    });
  });

  it("deduplicates identical text", async () => {
    const c = client();
    const text = `all-ops dedup ${crypto.randomUUID()}`;
    const first = await c.encode({ text });
    try {
      const second = await c.encode({ text });
      expect(second.wasDeduplicated).toBe(true);
      expect(second.memoryId).toBe(first.memoryId);
    } finally {
      await c.forget({ memoryId: first.memoryId });
    }
  });

  it("forgets idempotently", async () => {
    const c = client();
    const created = await c.encode({ text: `all-ops forget ${crypto.randomUUID()}` });
    expect((await c.forget({ memoryId: created.memoryId })).wasAlreadyForgotten).toBe(false);
    expect((await c.forget({ memoryId: created.memoryId })).wasAlreadyForgotten).toBe(true);
  });

  // ── links ────────────────────────────────────────────────────────────────

  it("links and unlinks two memories", async () => {
    const c = client();
    const a = await c.encode({ text: `all-ops link source ${crypto.randomUUID()}` });
    const b = await c.encode({ text: `all-ops link target ${crypto.randomUUID()}` });
    try {
      const linked = await c.link({ source: a.memoryId, target: b.memoryId, kind: "caused" });
      expect(linked.source).toBe(a.memoryId);
      const unlinked = await c.unlink({ source: a.memoryId, target: b.memoryId, kind: "caused" });
      expect(unlinked.removed).toBe(true);
    } finally {
      await c.forget({ memoryId: a.memoryId });
      await c.forget({ memoryId: b.memoryId });
    }
  });

  // ── typed graph: reads ───────────────────────────────────────────────────

  it("fetches a graph page", async () => {
    const page = await client().graphFetch({ limit: 5 });
    expect(Array.isArray(page.nodes)).toBe(true);
    expect(Array.isArray(page.edges)).toBe(true);
  });

  it("pages entities with a cursor", async () => {
    // The cursor fields were TypeScript-only; this is the live proof they work.
    const c = client();
    const page = await c.listEntities({ typeId: PERSON_TYPE_ID, limit: 1 });
    expect(Array.isArray(page.entities)).toBe(true);
    if (page.nextCursor) {
      const next = await c.listEntities({
        typeId: PERSON_TYPE_ID,
        limit: 1,
        cursor: page.nextCursor,
      });
      const seen = new Set(page.entities.map((e) => e.entityId));
      expect(next.entities.every((e) => !seen.has(e.entityId))).toBe(true);
    }
  });

  it("reads entities, relations and statements", async () => {
    const c = client();
    const page = await c.listEntities({ typeId: PERSON_TYPE_ID, limit: 1 });
    if (page.entities.length > 0) {
      const entityId = page.entities[0]!.entityId;
      expect((await c.getEntity(entityId)).entityId).toBe(entityId);
      expect(Array.isArray((await c.traverseRelations(entityId)).paths)).toBe(true);

      const relations = await c.listRelations(entityId, { limit: 5 });
      expect(Array.isArray(relations.relations)).toBe(true);
      for (const relation of relations.relations.slice(0, 1)) {
        expect((await c.getRelation(relation.relationId)).relationId).toBe(relation.relationId);
      }

      const resolved = await c.resolveEntity({ candidateName: page.entities[0]!.canonicalName });
      expect(["resolved", "ambiguous", "created", "unresolved"]).toContain(resolved.outcome);
    }

    const statements = await c.listStatements({ limit: 5 });
    expect(Array.isArray(statements.statements)).toBe(true);
    for (const statement of statements.statements.slice(0, 1)) {
      expect((await c.getStatement(statement.statementId)).statementId).toBe(
        statement.statementId,
      );
    }
  });

  it("surfaces the display names the server resolved", async () => {
    // The gateway resolves `subjectName` / `objectName` so a caller does not
    // have to. No SDK exposed them, so every consumer re-queried each id just
    // to print a name — the second call the field exists to remove.
    const page = await client().listStatements({ limit: 5 });
    if (page.statements.length === 0) return;
    expect(
      page.statements.some((s) => s.subjectName),
      "the server sends subjectName for a resolvable subject",
    ).toBe(true);
  });

  // ── typed graph: writes ──────────────────────────────────────────────────

  it("creates an entity and reads it back", async () => {
    const c = client();
    const name = `AllOps ${crypto.randomUUID().slice(0, 12)}`;
    const created = await c.createEntity({ entityTypeId: PERSON_TYPE_ID, canonicalName: name });
    expect(created.entityId).toBeTruthy();
    expect((await c.getEntity(created.entityId)).canonicalName.toLowerCase()).toBe(
      name.toLowerCase(),
    );
  });

  it("reports a duplicate entity name as a conflict, not a server fault", async () => {
    // 409, not 502. The engine reports a duplicate as an internal error and
    // the gateway used to pass it through — blaming the engine for the
    // caller's mistake AND putting it in the retryable class, so the SDK's
    // retry policy re-sent a request that could never succeed.
    const c = client();
    const name = `AllOps Dup ${crypto.randomUUID().slice(0, 12)}`;
    await c.createEntity({ entityTypeId: PERSON_TYPE_ID, canonicalName: name });
    const err = await errorFrom(() =>
      c.createEntity({ entityTypeId: PERSON_TYPE_ID, canonicalName: name }),
    );
    expect(err?.status).toBe(409);
  });

  // ── reasoning ────────────────────────────────────────────────────────────

  it("plans and reasons", async () => {
    await withMemory(async (_id, text) => {
      const c = client();
      const plan = await c.plan({ start: { text }, goal: { text: "editor preference" } });
      expect(Array.isArray(plan.steps)).toBe(true);
      const reasoned = await c.reason({ observation: { text } });
      expect(Array.isArray(reasoned.inferences)).toBe(true);
    });
  });

  // ── schema ───────────────────────────────────────────────────────────────

  it("returns a schema document or a clean 404", async () => {
    // A namespace with no schema is a normal state, not a fault — so both
    // answers are asserted rather than one being required.
    const c = client();
    try {
      expect((await c.getSchema()).namespace).toBeTruthy();
    } catch (e) {
      expect(e).toBeInstanceOf(BrainHttpError);
      expect((e as BrainHttpError).status).toBe(404);
    }
  });

  it("refuses a malformed schema document", async () => {
    // `validate` is the one schema verb safe to exercise for real: `upload`
    // merges and `replace` DROPS every declaration the document omits, so
    // neither is run against a live namespace from a test suite.
    // The verb takes a schema DOCUMENT as text, and reports problems in the
    // body rather than as an HTTP error — a dry run that parsed nothing is
    // still a successful validation run with findings.
    const result = await client().validateSchema({ schemaDocument: "this is not a schema" });
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  // ── failures ─────────────────────────────────────────────────────────────

  it("rejects a bad key with 401", async () => {
    const bad = new BrainHttpClient({ apiKey: "brain_not_a_real_key", baseUrl: baseUrl! });
    expect((await errorFrom(() => bad.whoami()))?.status).toBe(401);
  });

  it("refuses an empty query", async () => {
    const err = await errorFrom(() => client().recall({ query: "   " }));
    expect([400, 422]).toContain(err?.status);
  });

  it("refuses listing entities without a type", async () => {
    // Brain requires the type filter; the SDK makes it optional, so the
    // refusal has to be legible rather than a surprise 500.
    expect((await errorFrom(() => client().listEntities({ limit: 5 })))?.status).toBe(400);
  });

  it("reports an unknown entity as 404", async () => {
    expect((await errorFrom(() => client().getEntity(ABSENT_UUID)))?.status).toBe(404);
  });

  it("reports an unknown memory as not-found without throwing", async () => {
    // `inspect` answers 200 with `found: false` rather than 404 — it is a
    // debugging view, and "no such memory" is one of its answers.
    expect((await client().memoryInspect("1")).found).toBe(false);
  });

  it("forgets an unknown memory without erroring", async () => {
    expect((await client().forget({ memoryId: "1" })).wasAlreadyForgotten).toBe(true);
  });

  it("carries a status and a code on every error", async () => {
    // The caller branches on these. An error with only a message forces
    // string-matching, which is how error handling rots.
    const err = await errorFrom(() => client().getEntity(ABSENT_UUID));
    expect(typeof err?.status).toBe("number");
    expect(err?.code).toBeTruthy();
  });
});
