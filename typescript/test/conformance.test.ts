/**
 * Conformance corpus: the cross-language wire drift guard.
 *
 * For each vendored case the test decodes the golden `.bin`, re-encodes the
 * typed value, and asserts the bytes match. The re-encode == bytes assertion is
 * the load-bearing check: it proves the TS codec puts identical bytes on the
 * wire as the Rust SDK and the server. The cases are driven from `index.json`
 * so a corpus addition that lacks a TS handler surfaces as a failure rather
 * than being silently skipped.
 *
 * `frame_*` cases carry a full 32-byte BRN0 header + payload; all other cases
 * are payload-only (CBOR map + any trailing raw-vector section).
 *
 * What this file does NOT prove: that decoded values land in the right
 * properties. Both of its assertions run through the encoder, so inverting a
 * field pair in a decoder and its encoder together passes every check here —
 * verified by injecting exactly that swap into the Python SDK, where the whole
 * suite stayed green. Catching it is `field-names.test.ts`'s job.
 */

import { describe, it, expect } from "vitest";

import { crc32c } from "../src/wire/frame.js";
import { codecs, corpusIndex, readBin, reencode } from "./_corpus.js";

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, name: string): void {
  expect(toHex(actual), `re-encode mismatch for ${name}`).toBe(toHex(expected));
}

it("crc32c check vector pins the polynomial choice", () => {
  expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
});

it("every corpus case has a TS handler", () => {
  const missing = corpusIndex.map((e) => e.name).filter((n) => !(n in codecs));
  expect(missing, `corpus cases without a handler: ${missing.join(", ")}`).toEqual([]);
});

describe("re-encode == golden bytes (all corpus cases)", () => {
  for (const entry of corpusIndex) {
    it(`${entry.name} (${entry.kind})`, () => {
      const bytes = readBin(entry.name);
      const codec = codecs[entry.name];
      expect(codec, `no handler for ${entry.name}`).toBeDefined();
      expectBytesEqual(reencode(codec!, bytes), bytes, entry.name);
    });
  }
});
