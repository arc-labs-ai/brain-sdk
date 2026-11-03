/**
 * What the HTTP constructor accepts, and the rule all three SDKs now share.
 *
 * TypeScript validated only that `apiKey` was non-empty. A control character
 * in the key — a credential read from an env file with a trailing newline is
 * the ordinary way one gets in — reached `fetch`, which refuses to build the
 * request. Safe, but late, and reported as a header error rather than a
 * configuration one. Python was worse: `urllib` sent a NUL straight into the
 * Authorization header, where a proxy may truncate the value.
 *
 * All three now refuse at construction on one rule: ASCII C0 controls and DEL
 * are rejected, HTAB is not, because RFC 7230 permits HTAB in a field value
 * and every one of the three transports sends it — a constructor stricter than
 * the request path it guards would be its own bug.
 */

import { describe, expect, it } from "vitest";

import { BrainHttpClient, BrainHttpError } from "../../src/http/index.js";

const BASE = "https://edge.example";

describe("BrainHttpClient construction", () => {
  it("rejects a missing or empty apiKey as a config error", () => {
    for (const apiKey of ["", undefined as unknown as string]) {
      try {
        new BrainHttpClient({ apiKey, baseUrl: BASE });
        throw new Error(`apiKey ${JSON.stringify(apiKey)} should have been rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(BrainHttpError);
        expect((e as BrainHttpError).status).toBe(0);
        expect((e as BrainHttpError).code).toBe("config");
      }
    }
  });

  it("rejects a control character in the apiKey", () => {
    for (const apiKey of [
      "evil\0key",
      "evil\rX: 1",
      "evil\nX: 1",
      "evil\u007fkey",
      "evil\u000bkey",
    ]) {
      let thrown: unknown;
      try {
        new BrainHttpClient({ apiKey, baseUrl: BASE });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `apiKey ${JSON.stringify(apiKey)} must be rejected`).toBeInstanceOf(
        BrainHttpError,
      );
      const err = thrown as BrainHttpError;
      expect(err.status).toBe(0);
      expect(err.code).toBe("config");
      expect(err.message).toBe("apiKey must not contain control characters");
      // The message must not echo the credential, even in part.
      expect(err.message).not.toContain("evil");
    }
  });

  it("accepts any apiKey an HTTP header can carry", () => {
    // HTAB is deliberately here: see the file header. The range stops below
    // 0x80, so a key with a non-ASCII letter still works.
    for (const apiKey of [" ", "\t", "brain_ékey", "x".repeat(8192), "brain_key"]) {
      expect(
        () => new BrainHttpClient({ apiKey, baseUrl: BASE }),
        `apiKey ${JSON.stringify(apiKey)} must be accepted`,
      ).not.toThrow();
    }
  });
});
