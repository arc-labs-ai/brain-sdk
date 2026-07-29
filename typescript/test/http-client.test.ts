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

import { BrainHttpClient, BrainHttpError } from "../src/http/index.js";

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
    expect(out.memory_id).toBe("42");
    expect(out.auto_edges_added).toBe(1);
  });

  // A wrong path is a 404 against a real edge and silence against a mock, so
  // the route each verb uses is asserted directly.
  const routes: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    ["recall", () => client.recall({ query: "q" }), "POST", "/v1/recall", { answer_kind: "none", memories: [] }],
    ["forget", () => client.forget({ memory_id: "42" }), "DELETE", "/v1/memories", { memory_id: "1", was_already_forgotten: false, edges_removed: 0 }],
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

// --- error mapping ---------------------------------------------------------

describe("error mapping", () => {
  it("turns an error body into a structured error", async () => {
    replies = [[404, { error: { code: "not_found", message: "no such memory" } }]];
    const err = await client.forget({ memory_id: "999" }).catch((e) => e);
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
