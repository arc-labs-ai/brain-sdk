/**
 * What the package entry actually hands a consumer.
 *
 * `withRetry` was defined in `src/retry.ts`, documented in its module header,
 * covered by `test/retry`, and absent from `src/index.ts` — so it existed,
 * worked, and could not be imported. The package's `exports` map had a single
 * `"."` entry at the time, so there was no deep path to reach around it
 * either: the only way to retry a wire verb was to re-implement the
 * combinator from `isRetryable` and `backoffMs`, which the docs told people
 * to do. Python and Rust both exported theirs.
 *
 * A unit test cannot catch that, because a unit test imports from the module
 * that defines the thing. This one imports from the entry a consumer imports
 * from, which is the only place the omission is visible.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as httpEntry from "../../src/http/index.js";
import * as entry from "../../src/index.js";

describe("the package entry", () => {
  // Spelled out rather than snapshotted: a snapshot of a public surface
  // records whatever happened, and updating it is one keypress. A list is a
  // decision, and removing a line from it is a reviewable act.
  const EXPECTED_CALLABLES = [
    "BrainClient",
    "MuxConnection",
    "Pool",
    "Subscription",
    "EncodeBuilder",
    "ForgetBuilder",
    "RecallBuilder",
    "BrainError",
    "BrainTimeout",
    "ConnectionClosed",
    "TransportError",
    "ProtocolError",
    "ServerError",
    "VersionMismatch",
    "isRetryable",
    "isActAsDenied",
    "isLlmCredentialMissing",
    "isLlmCredentialUnavailable",
    "backoffMs",
    "withRetry",
    "newId",
    "deriveSpaceId",
    "BrainHttpClient",
    "BrainHttpError",
  ];

  it.each(EXPECTED_CALLABLES)("exports %s", (name) => {
    expect(typeof (entry as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it("exports the retry combinator, not just its parts", () => {
    // The specific regression: `backoffMs` and `isRetryable` were reachable
    // and `withRetry` — the thing that composes them — was not.
    expect(entry.withRetry).toBeTypeOf("function");
    expect(entry.DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
    });
    expect(entry.NO_RETRY.maxAttempts).toBe(1);
  });

  it("retries through the exported combinator", async () => {
    // Proves it is wired, not merely present: a re-exported binding that
    // pointed at the wrong module would still be a function.
    let calls = 0;
    const result = await entry.withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new entry.TransportError("socket died");
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up on a non-retryable error without re-running", async () => {
    let calls = 0;
    await expect(
      entry.withRetry(async () => {
        calls += 1;
        throw new TypeError("a bug, not a blip");
      }, entry.DEFAULT_RETRY_POLICY),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  /**
   * Every HTTP contract type is re-exported from the `http` entry.
   *
   * Types are erased before the code runs, so this reads the sources rather
   * than the module object. The sibling SDKs re-export by a hand-written
   * list, and in both of them the list stopped growing with the file it
   * re-exports — every type added after the original twenty-five-verb
   * surface was unreachable from the entry. This SDK re-exports with a star
   * and so cannot drift; the check exists so that swapping the star for a
   * list later does not quietly reintroduce the same gap.
   */
  it("re-exports every HTTP contract type from the http entry", () => {
    const typesSrc = readFileSync(new URL("../../src/http/types.ts", import.meta.url), "utf8");
    const indexSrc = readFileSync(new URL("../../src/http/index.ts", import.meta.url), "utf8");

    const defined = [
      ...typesSrc.matchAll(/^export (?:type|interface|class|const enum|enum) ([A-Za-z0-9_$]+)/gm),
    ].map((m) => m[1] as string);
    expect(defined.length, "the parse, not the surface, is what broke").toBeGreaterThan(50);

    const starred = /export \* from "\.\/types\.js";/.test(indexSrc);
    if (starred) return;

    const missing = defined.filter((name) => !new RegExp(`\\b${name}\\b`).test(indexSrc));
    expect(missing, "defined in http/types.ts but not re-exported").toEqual([]);
  });

  it("serves the same BrainHttpClient from both entries", () => {
    expect(entry.BrainHttpClient).toBe(httpEntry.BrainHttpClient);
    expect(entry.BrainHttpError).toBe(httpEntry.BrainHttpError);
  });
});
