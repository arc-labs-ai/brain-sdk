/**
 * The HTTP tier: routing, auth, error mapping, and retry.
 *
 * `BrainHttpClient` is what talks to `brain-edge`, and it had no tests in any of
 * the three SDKs. The wire client's mock-server suites do not cover it — it is a
 * separate transport with its own error taxonomy and its own retry policy.
 *
 * Driven against a real in-process `node:http` server rather than the injectable
 * `fetch` seam, and rather than a live edge. A real server exercises actual
 * bytes, header casing and status handling, which a fake fetch does not; and the
 * interesting behaviour here is what happens when things go *wrong* — a 503 mid
 * retry, a `Retry-After` hint, a body that is not JSON, a socket that dies —
 * none of which is reachable on demand from a healthy edge.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";

import { BrainHttpClient, BrainHttpError, type ListEntitiesQuery } from "../src/http/index.js";

const API_KEY = "brain_test-key";

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let server: http.Server;
let client: BrainHttpClient;
let seen: Seen[];
/** Queued replies, consumed in order: [status, body, extraHeaders]. */
let replies: Array<[number, unknown, Record<string, string>?]>;

beforeEach(async () => {
  seen = [];
  replies = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: raw ? JSON.parse(raw) : null,
      });
      const [status, body, extra] = replies.shift() ?? [200, {}, {}];
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...(extra ?? {}) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  client = new BrainHttpClient({
    apiKey: API_KEY,
    baseUrl: `http://127.0.0.1:${port}`,
    // No sleeping in tests: the schedule is asserted separately from the
    // decision to retry.
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PERMISSIONS = {
  can_encode: true,
  can_recall: true,
  can_plan: true,
  can_reason: true,
  can_forget: true,
  can_admin: false,
};
const WHOAMI = { namespace: "ns", space_id: "s", permissions: PERMISSIONS };

// --- routing and auth ------------------------------------------------------

describe("routing and auth", () => {
  it("encode posts to the right route, carrying the key", async () => {
    replies = [
      [
        200,
        {
          memory_id: "42",
          was_deduplicated: false,
          salience: 0.5,
          kind: 0,
          created_at_unix_nanos: 7,
          auto_edges_added: 1,
        },
      ],
    ];
    const out = await client.encode({ text: "the sky is teal" });

    expect(seen).toHaveLength(1);
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["POST", "/v1/memories"]);
    expect(seen[0]!.auth, "the API key must ride every request").toBe(`Bearer ${API_KEY}`);
    expect(seen[0]!.contentType).toBe("application/json");
    expect(seen[0]!.body).toEqual({ text: "the sky is teal" });
    expect(out.memoryId).toBe("42");
    expect(out.autoEdgesAdded).toBe(1);
  });

  it("speaks camelCase to callers and snake_case on the wire", async () => {
    // The rest of this SDK is camelCase, including its wire types; the edge's
    // JSON is snake_case. Both halves are asserted here so a change to either
    // side of the mapping shows up as a failure rather than as silently wrong
    // JSON that the mock happens to accept.
    replies = [
      [
        200,
        {
          memory_id: "7",
          was_deduplicated: true,
          salience: 0.25,
          kind: 0,
          created_at_unix_nanos: 11,
          auto_edges_added: 0,
        },
      ],
    ];
    const out = await client.encode({ text: "t", occurredAt: 99 });

    expect(seen[0]!.body, "the edge must receive snake_case").toEqual({
      text: "t",
      occurred_at: 99,
    });
    expect(out.memoryId, "the caller must receive camelCase").toBe("7");
    expect(out.wasDeduplicated).toBe(true);
    expect(out.createdAtUnixNanos).toBe(11);
    expect(
      (out as unknown as Record<string, unknown>).memory_id,
      "no snake_case leaks through to the public type",
    ).toBeUndefined();
  });

  // A wrong path is a 404 against a real edge and silence against a mock, so
  // the route each verb uses is asserted directly.
  const routes: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    ["recall", () => client.recall({ query: "q" }), "POST", "/v1/recall", { answer_kind: "none", memories: [] }],
    ["forget", () => client.forget({ memoryId: "42" }), "DELETE", "/v1/memories", { memory_id: "1", was_already_forgotten: false, edges_removed: 0 }],
    ["link", () => client.link({ source: "1", target: "2", kind: "caused" }), "POST", "/v1/links", { source: "1", target: "2", kind: "caused", weight: 1, created_at_unix_nanos: 0, already_existed: false }],
    ["unlink", () => client.unlink({ source: "1", target: "2", kind: "caused" }), "DELETE", "/v1/links", { source: "1", target: "2", kind: "caused", removed: true }],
    ["whoami", () => client.whoami(), "GET", "/v1/whoami", WHOAMI],
    ["capabilities", () => client.capabilities(), "GET", "/v1/capabilities", {}],
  ];

  for (const [name, call, method, path, body] of routes) {
    it(`${name} hits ${method} ${path}`, async () => {
      replies = [[200, body]];
      await call().catch(() => {
        // A minimal body may not populate every field of the result type; the
        // assertion here is about the request, not the response shape.
      });
      expect(seen, `${method} ${path}: no request reached the server`).not.toHaveLength(0);
      expect([seen[0]!.method, seen[0]!.path]).toEqual([method, path]);
    });
  }
});

// --- the read-side, entity, graph and schema routes ------------------------

describe("read-side, entity, graph and schema routes", () => {
  // The other 16 of the edge's 25 method+path combos. Three of them share a
  // path with a verb above under a different method (`/v1/memories`, and
  // `/v1/schema` under GET/POST/PUT), which is exactly the case a path-only
  // check misses — so the method is asserted alongside the path.
  const routes: Array<[string, () => Promise<unknown>, string, string]> = [
    ["listMemories", () => client.listMemories(), "GET", "/v1/memories"],
    ["inspectMemory", () => client.inspectMemory("m1"), "GET", "/v1/memories/m1/inspect"],
    ["listEntities", () => client.listEntities(), "GET", "/v1/entities"],
    ["getEntity", () => client.getEntity("e1"), "GET", "/v1/entities/e1"],
    ["createEntity", () => client.createEntity({ entityTypeId: 1, canonicalName: "Ada" }), "POST", "/v1/entities"],
    ["resolveEntity", () => client.resolveEntity({ candidateName: "Ada" }), "POST", "/v1/entities/resolve"],
    ["traverse", () => client.traverse("e1"), "POST", "/v1/entities/e1/traverse"],
    ["listRelations", () => client.listRelations("e1"), "GET", "/v1/entities/e1/relations"],
    ["getRelation", () => client.getRelation("r1"), "GET", "/v1/relations/r1"],
    ["listStatements", () => client.listStatements(), "GET", "/v1/statements"],
    ["getStatement", () => client.getStatement("s1"), "GET", "/v1/statements/s1"],
    ["fetchGraph", () => client.fetchGraph(), "GET", "/v1/graph"],
    ["getSchema", () => client.getSchema(), "GET", "/v1/schema"],
    ["uploadSchema", () => client.uploadSchema({ schemaDocument: "x" }), "POST", "/v1/schema"],
    ["validateSchema", () => client.validateSchema({ schemaDocument: "x" }), "POST", "/v1/schema/validate"],
    ["replaceSchema", () => client.replaceSchema({ schemaDocument: "x", forceDropExisting: false }), "PUT", "/v1/schema"],
  ];

  for (const [name, call, method, path] of routes) {
    it(`${name} hits ${method} ${path}`, async () => {
      replies = [[200, {}]];
      await call().catch(() => {
        // As above: an empty body does not populate the result type, and the
        // assertion here is about the request.
      });
      expect(seen, `${method} ${path}: no request reached the server`).not.toHaveLength(0);
      expect([seen[0]!.method, seen[0]!.path]).toEqual([method, path]);
    });
  }

  it("omits the query string entirely when no options are passed", async () => {
    replies = [[200, {}]];
    await client.listEntities();
    expect(seen[0]!.path, "a bare '?' is not a valid empty query").toBe("/v1/entities");
  });

  it("escapes a path id rather than splicing it into the path", async () => {
    // An id is caller data. Unescaped, a `/` in it would silently address a
    // different route.
    replies = [[200, {}]];
    await client.getEntity("weird/id?x").catch(() => {});
    expect(seen[0]!.path).toBe("/v1/entities/weird%2Fid%3Fx");
  });
});

// --- query strings ---------------------------------------------------------

describe("query parameters", () => {
  // The camelCase<->snake_case seam is `JSON.stringify`/`JSON.parse`, and a
  // query string passes through neither. Sent verbatim, `includeTombstoned`
  // would deserialize to serde's default on the edge — a filter that looks
  // applied and is not, with a 200 and a plausible body to hide it.
  it("snake_cases query parameter names", async () => {
    replies = [[200, { entities: [], count: 0 }]];
    await client.listEntities({
      typeId: 3,
      prefix: "Ada",
      mentionCountMin: 2,
      includeTombstoned: true,
      includeMerged: false,
      limit: 10,
    });
    expect(seen[0]!.path).toBe(
      "/v1/entities?type_id=3&prefix=Ada&mention_count_min=2" +
        "&include_tombstoned=true&include_merged=false&limit=10",
    );
  });

  it("snake_cases query names on every query-bearing route", async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => client.listMemories({ dir: "asc", includeTombstoned: true }), "/v1/memories?dir=asc&include_tombstoned=true"],
      [() => client.getRelation("r1", { followSupersession: false }), "/v1/relations/r1?follow_supersession=false"],
      [() => client.getStatement("s1", { followSupersession: true }), "/v1/statements/s1?follow_supersession=true"],
      [() => client.listStatements({ minConfidence: 0.5, onlyCurrent: false }), "/v1/statements?min_confidence=0.5&only_current=false"],
      [() => client.fetchGraph({ includeMemories: true, includeMemoryEdges: true }), "/v1/graph?include_memories=true&include_memory_edges=true"],
      [() => client.getSchema({ namespace: "ns", version: 2 }), "/v1/schema?namespace=ns&version=2"],
      [() => client.listRelations("e1", { includeSuperseded: true }), "/v1/entities/e1/relations?include_superseded=true"],
    ];
    for (const [call, expected] of cases) {
      seen = [];
      replies = [[200, {}]];
      await call().catch(() => {});
      expect(seen[0]!.path).toBe(expected);
    }
  });

  it("sends the relation-type filter as `type`, the name the edge reads", async () => {
    // The edge's field is `relation_type` with `#[serde(rename = "type")]`, so
    // the mechanical snake_case of a `relationType` property would be wrong.
    replies = [[200, { relations: [], count: 0 }]];
    await client.listRelations("e1", { direction: "to", type: "org:employs" });
    expect(seen[0]!.path).toBe("/v1/entities/e1/relations?direction=to&type=org%3Aemploys");
  });

  it("drops an undefined option instead of sending it", async () => {
    // `exactOptionalPropertyTypes` stops a TS caller writing `limit: undefined`
    // literally, but an object spread — or a JS caller — still produces one.
    const query = { prefix: "Ada", limit: undefined } as unknown as ListEntitiesQuery;
    replies = [[200, {}]];
    await client.listEntities(query);
    expect(seen[0]!.path, "`limit=undefined` would be a 400, not a default").toBe(
      "/v1/entities?prefix=Ada",
    );
  });
});

// --- camelCase across the new routes ---------------------------------------

describe("field names on the new routes", () => {
  it("sends a camelCase body as snake_case JSON", async () => {
    replies = [[200, { entity_id: "e9" }]];
    const out = await client.createEntity({
      entityTypeId: 7,
      canonicalName: "Ada Lovelace",
      aliases: ["Ada"],
    });
    expect(seen[0]!.body).toEqual({
      entity_type_id: 7,
      canonical_name: "Ada Lovelace",
      aliases: ["Ada"],
    });
    expect(out.entityId).toBe("e9");
  });

  it("camelCases a nested response, including through arrays", async () => {
    replies = [
      [
        200,
        {
          entities: [
            {
              entity_id: "e1",
              entity_type_id: 2,
              canonical_name: "Ada",
              aliases: [],
              mention_count: 3,
              created_at_unix_nanos: 1,
              updated_at_unix_nanos: 2,
              merged_into: null,
            },
          ],
          count: 1,
        },
      ],
    ];
    const out = await client.listEntities();
    expect(out.count).toBe(1);
    expect(out.entities[0]!.entityTypeId).toBe(2);
    expect(out.entities[0]!.createdAtUnixNanos).toBe(1);
    expect(out.entities[0]!.mergedInto).toBeNull();
    expect(
      (out.entities[0] as unknown as Record<string, unknown>).entity_id,
      "no snake_case leaks through to the public type",
    ).toBeUndefined();
  });

  it("leaves a tagged union's tag alone — it is a value, not a key", async () => {
    // `unix_nanos` is the discriminant of StatementValue. Only keys are
    // rewritten; camelCasing the tag would break every `switch` on it.
    replies = [
      [
        200,
        {
          statement_id: "s1",
          kind: "fact",
          subject: "e1",
          predicate: "born_at",
          object: { kind: "value", value: { type: "unix_nanos", value: 42 } },
          confidence: 1,
          event_at_unix_nanos: 42,
          valid_from_unix_nanos: 1,
          valid_to_unix_nanos: 0,
          tombstoned: false,
        },
      ],
    ];
    const out = await client.getStatement("s1");
    expect(out.statementId).toBe("s1");
    expect(out.object.kind).toBe("value");
    if (out.object.kind !== "value") throw new Error("unreachable");
    expect(out.object.value.type).toBe("unix_nanos");
  });
});

// --- idempotency of the new routes -----------------------------------------

describe("idempotency of the new routes", () => {
  const retried: Array<[string, () => Promise<unknown>]> = [
    ["listEntities", () => client.listEntities()],
    ["getEntity", () => client.getEntity("e1")],
    ["listRelations", () => client.listRelations("e1")],
    ["fetchGraph", () => client.fetchGraph()],
    ["inspectMemory", () => client.inspectMemory("m1")],
    ["listMemories", () => client.listMemories()],
    ["getRelation", () => client.getRelation("r1")],
    ["getSchema", () => client.getSchema()],
    ["listStatements", () => client.listStatements()],
    ["getStatement", () => client.getStatement("s1")],
    // A dry run: it validates and stores nothing, so replaying it is free.
    ["validateSchema", () => client.validateSchema({ schemaDocument: "x" })],
  ];

  for (const [name, call] of retried) {
    it(`${name} retries a 503`, async () => {
      replies = [[503, { error: { code: "unavailable", message: "shard restarting" } }], [200, {}]];
      await call().catch(() => {});
      expect(seen, `${name} is idempotent and must be retried`).toHaveLength(2);
    });
  }

  const notRetried: Array<[string, () => Promise<unknown>]> = [
    ["createEntity", () => client.createEntity({ entityTypeId: 1, canonicalName: "Ada" })],
    ["resolveEntity", () => client.resolveEntity({ candidateName: "Ada", allowCreate: true })],
    ["traverse", () => client.traverse("e1")],
    ["uploadSchema", () => client.uploadSchema({ schemaDocument: "x" })],
    // Destructive: a replay could drop against a schema the first attempt
    // already replaced.
    ["replaceSchema", () => client.replaceSchema({ schemaDocument: "x", forceDropExisting: true })],
  ];

  for (const [name, call] of notRetried) {
    it(`${name} never retries a 503`, async () => {
      replies = [[503, { error: { code: "unavailable", message: "shard restarting" } }], [200, {}]];
      await expect(call()).rejects.toBeInstanceOf(BrainHttpError);
      expect(seen, `${name} is not idempotent and must run exactly once`).toHaveLength(1);
    });
  }
});

// --- error mapping ---------------------------------------------------------

describe("error mapping", () => {
  it("turns an error body into a structured error", async () => {
    replies = [[404, { error: { code: "not_found", message: "no such memory" } }]];
    const err = await client.forget({ memoryId: "999" }).catch((e) => e);
    expect(err).toBeInstanceOf(BrainHttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("no such memory");
  });

  it("survives a non-JSON error body", async () => {
    // An edge behind a proxy can return HTML; the client must not die parsing it.
    replies = [[502, "<html>Bad Gateway</html>"]];
    const err = await client.whoami().catch((e) => e);
    expect(err).toBeInstanceOf(BrainHttpError);
    expect(err.status).toBe(502);
  });

  it("reports a transport failure as a BrainHttpError, not a raw fetch error", async () => {
    // A caller catching BrainHttpError must not also have to catch TypeError.
    const dead = new BrainHttpClient({
      apiKey: API_KEY,
      baseUrl: "http://127.0.0.1:1",
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const err = await dead.whoami().catch((e) => e);
    expect(err).toBeInstanceOf(BrainHttpError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("transport");
  });
});

// --- retry -----------------------------------------------------------------

describe("retry", () => {
  it("retries a 503 on an idempotent verb and succeeds", async () => {
    replies = [
      [503, { error: { code: "unavailable", message: "shard restarting" } }],
      [200, WHOAMI],
    ];
    await client.whoami();
    expect(seen, "a 503 on an idempotent GET must be retried").toHaveLength(2);
  });

  it("never retries a non-idempotent verb", async () => {
    // The whole point of the idempotent flag: retrying a non-idempotent verb
    // after a 503 risks applying it twice.
    replies = [
      [503, { error: { code: "unavailable", message: "shard restarting" } }],
      [200, { answer_kind: "none", memories: [] }],
    ];
    await expect(client.recall({ query: "anything" })).rejects.toBeInstanceOf(BrainHttpError);
    expect(seen, "a non-idempotent verb must run exactly once").toHaveLength(1);
  });

  it("gives up after maxAttempts", async () => {
    replies = Array.from(
      { length: 5 },
      () => [503, { error: { code: "unavailable", message: "no" } }] as [number, unknown],
    );
    const err = await client.whoami().catch((e) => e);
    expect(err.status).toBe(503);
    expect(seen, "maxAttempts=3 means three requests, not three retries").toHaveLength(3);
  });

  it("does not retry a 4xx", async () => {
    // Retrying a client error just multiplies it — the request will not become
    // valid on a second attempt.
    replies = [[401, { error: { code: "unauthorized", message: "bad key" } }]];
    const err = await client.whoami().catch((e) => e);
    expect(err.status).toBe(401);
    expect(seen).toHaveLength(1);
  });
});
