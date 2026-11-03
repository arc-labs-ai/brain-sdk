/**
 * The HTTP tier must stay loadable where `node:` is not.
 *
 * `BrainHttpClient` needs nothing but `fetch`, so it belongs in Workers, Deno,
 * Bun and Next.js Edge routes as much as in Node. For three releases it was
 * not loadable in any of them, and not for a reason anyone would find by
 * reading `src/http/`: the package published a single `"."` export whose entry
 * re-exports the wire tier beside the HTTP tier, and the wire tier imports
 * `node:net` and `node:crypto`. Importing `BrainHttpClient` pulled the whole
 * entry, so a Next.js build died on
 *
 *     Failed to load external module node:crypto:
 *     TypeError: Native module not found: node:crypto
 *
 * naming a module nothing in the user's code mentions.
 *
 * The fix is the `"./http"` subpath export. What makes it a fix rather than a
 * coincidence is that nothing reachable from `src/http/index.ts` touches a
 * Node builtin — and that is the part a future edit can quietly undo. One
 * `import { randomUUID } from "node:crypto"` in `http/client.ts`, which would
 * pass review and every other test in this suite, puts it straight back.
 *
 * So this suite asserts the shape rather than the behaviour: the import
 * closure of the HTTP tier, read off the source, contains no `node:`
 * specifier — not even a type-only one, because a type reference still has to
 * resolve for a consumer type-checking without `@types/node`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Relative import specifiers, from `import`, `export … from` and `import()`. */
const RELATIVE = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

/** Any reference to a Node builtin, type-only included. */
const NODE_BUILTIN = /["']node:[a-z/]+["']/g;

/**
 * Every source file reachable from `entry`, as paths relative to `src`.
 *
 * Specifiers are written `.js` under NodeNext resolution; the file on disk is
 * `.ts`. Anything that does not resolve to a file is a bare specifier (a
 * dependency) and is not followed — this is a first-party closure.
 */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];

  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (seen.has(rel)) continue;

    let text: string;
    try {
      text = readFileSync(join(SRC, rel), "utf8");
    } catch {
      continue;
    }
    seen.add(rel);

    for (const [, spec] of text.matchAll(RELATIVE)) {
      const asTs = (spec as string).replace(/\.js$/, ".ts");
      stack.push(normalize(join(dirname(rel), asTs)));
    }
  }
  return [...seen].sort();
}

describe("the HTTP tier is standalone", () => {
  const http = closure("http/index.ts");

  it("reaches the whole HTTP tier", () => {
    // A guard on the guard: if the closure walker silently stopped resolving,
    // every assertion below would pass over an empty set.
    expect(http).toContain("http/client.ts");
    expect(http).toContain("http/types.ts");
    expect(http).toContain("http/sse.ts");
    expect(http.length).toBeGreaterThan(4);
  });

  it("imports no Node builtin, at runtime or in a type position", () => {
    const offenders = http
      .map((f) => [f, [...readFileSync(join(SRC, f), "utf8").matchAll(NODE_BUILTIN)]] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([f, hits]) => `${f} -> ${hits.map((h) => h[0]).join(", ")}`);

    expect(
      offenders,
      [
        "",
        "  The HTTP tier must run where `node:` does not exist.",
        "",
        "  If this is genuinely needed, it belongs behind a capability check",
        "  against `globalThis` — the way `newIdempotencyKey` reaches for",
        "  `globalThis.crypto?.randomUUID` with a fallback — not an import.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("reaches outside src/http only for modules that are themselves standalone", () => {
    // Not a ban: `describe.ts` is shared with the wire tier on purpose. The
    // rule is that whatever it reaches is node-free too, which the assertion
    // above already covers for the whole closure. This one keeps the surface
    // small enough to stay reviewable.
    const outside = http.filter((f) => !f.startsWith("http/"));
    expect(outside).toEqual(["describe.ts"]);
  });
});

describe("the package exports the HTTP tier on its own", () => {
  const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
    exports: Record<string, { types?: string; import?: string } | string>;
  };

  it("declares a ./http subpath", () => {
    const http = pkg.exports["./http"];
    expect(http, "no ./http export — Edge and Worker consumers cannot reach the client").toEqual({
      types: "./dist/http/index.d.ts",
      import: "./dist/http/index.js",
    });
  });

  it("points each subpath at the built entry its source produces", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === "string") continue;
      const built = target.import as string;
      // `./dist/http/index.js` is emitted from `src/http/index.ts`.
      const source = built.replace("./dist/", "").replace(/\.js$/, ".ts");
      expect(
        () => readFileSync(join(SRC, source), "utf8"),
        `exports["${subpath}"] points at ${built}, which no source file produces`,
      ).not.toThrow();
      expect(relative(SRC, join(SRC, source)).startsWith(".."), source).toBe(false);
    }
  });
});
