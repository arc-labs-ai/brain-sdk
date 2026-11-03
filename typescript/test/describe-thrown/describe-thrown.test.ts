/**
 * `describeThrown` exists to stop an error message losing its content. For the
 * commonest input it was doing the opposite.
 *
 * The original fell through to `JSON.stringify(value)` for anything object-
 * shaped. An `Error`'s `name`, `message` and `stack` are all *non-enumerable*,
 * so that returns the literal `{}` — and both unguarded call sites in the HTTP
 * tier (`request to … failed: ${describeThrown(e)}`) therefore reported
 *
 *     request to http://edge/v1/whoami failed: {}
 *
 * for every transport failure there has ever been. The helper's own doc comment
 * warned about `String(value)` collapsing to `[object Object]`; it swapped that
 * for `{}` and kept none of the detail either way. The two call sites in
 * `mux.ts` / `transport.ts` were unaffected because they guard with
 * `err instanceof Error ? err : …`, which is exactly why the bug was invisible
 * to the wire-tier suites.
 *
 * `fetch` makes it worse: it reports every transport failure as the same
 * `TypeError: fetch failed` and puts the real reason in `cause`, so the useful
 * half was the half being dropped.
 */

import { describe, expect, it } from "vitest";

import { describeThrown } from "../../src/describe.js";

describe("describeThrown", () => {
  it("keeps an Error's message instead of flattening it to {}", () => {
    expect(describeThrown(new Error("boom"))).toBe("Error: boom");
    expect(describeThrown(new TypeError("bad header"))).toBe("TypeError: bad header");
    // The regression itself, stated as an assertion.
    expect(describeThrown(new Error("boom"))).not.toBe("{}");
  });

  it("unwraps the cause chain fetch hides the real reason in", () => {
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const outer = new TypeError("fetch failed", { cause: inner });
    const got = describeThrown(outer);
    expect(got).toContain("fetch failed");
    expect(got).toContain("ECONNREFUSED");
  });

  it("stops rather than hanging on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    // Deliberately building the cycle a real framework can produce.
    (a as { cause?: unknown }).cause = b;
    const got = describeThrown(b);
    expect(got).toContain("b");
    expect(got.length).toBeLessThan(500);
  });

  it("recognises an Error from another realm, where instanceof fails", () => {
    // A worker or vm context has its own Error constructor, so `instanceof
    // Error` is false for its errors — and that is where an unhelpful message
    // is hardest to chase. Duck-typing on name+message covers it.
    const foreign = { name: "TypeError", message: "from another realm" };
    expect(describeThrown(foreign)).toBe("TypeError: from another realm");
  });

  it("handles an Error with an empty message", () => {
    expect(describeThrown(new Error(""))).toBe("Error");
  });

  it("still renders the non-Error values it was written for", () => {
    expect(describeThrown("plain string")).toBe("plain string");
    expect(describeThrown(null)).toBe("null");
    expect(describeThrown(undefined)).toBe("undefined");
    expect(describeThrown(42)).toBe("42");
    expect(describeThrown(false)).toBe("false");
    expect(describeThrown({ code: "EBADF" })).toBe('{"code":"EBADF"}');
    expect(describeThrown([1, 2])).toBe("[1,2]");
  });

  it("falls back rather than throwing on a value JSON cannot encode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeThrown(cyclic)).not.toThrow();
    const bigint = { n: 1n };
    expect(() => describeThrown(bigint)).not.toThrow();
  });
});
