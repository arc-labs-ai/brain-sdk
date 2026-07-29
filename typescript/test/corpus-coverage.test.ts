/**
 * Coverage gate: every opcode is either pinned by the corpus or on the tracked
 * gap list. Nothing gets to be silently unverified.
 *
 * The corpus is the only oracle in this repo that comes from outside it. Every
 * other suite — round-trips, mock servers, cross-language parity — is built from
 * the SDK's own types, so an opcode with no corpus vector is verified by nothing
 * but its own reflection.
 *
 * That is not theoretical. `QueryRequest` was missing `sessionFilter` in all
 * three SDKs; the server treats a missing `Option` as `None` rather than an
 * error, so a session-scoped query silently searched every session. Both verbs
 * that carry it, QUERY_EXPLAIN and QUERY_TRACE, are on the gap list.
 *
 * This test does not demand the gap be closed. It demands the gap be *known*:
 * add an opcode, and it must show up in the corpus or in `coverage.json`.
 */

import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Opcode } from "../src/wire/opcode.js";
import { corpusDir, corpusIndex } from "./_corpus.js";

interface Coverage {
  opcode_values: Record<string, string>;
}

const coverage: Coverage = JSON.parse(
  readFileSync(join(corpusDir, "..", "coverage.json"), "utf8"),
);

it("every opcode is corpus-pinned or on the tracked gap list", () => {
  const covered = new Set(corpusIndex.map((c) => parseInt(c.opcode, 16)));
  // Matched by VALUE, not name: the three SDKs spell the variants differently
  // (EntityGetReq / ENTITY_GET_REQ / EntityGetReq), and the number is the thing
  // the wire actually carries.
  const gap = new Set(Object.values(coverage.opcode_values).map((v) => parseInt(v, 16)));

  const declared = Object.entries(Opcode) as [string, number][];
  expect(
    declared.length,
    `only ${declared.length} opcodes found — the Opcode import has drifted`,
  ).toBeGreaterThan(100);

  const hex = (v: number) => `0x${v.toString(16).padStart(4, "0").toUpperCase()}`;

  const unaccounted = declared
    .filter(([, value]) => !covered.has(value) && !gap.has(value))
    .map(([name, value]) => `${name} (${hex(value)})`)
    .sort();
  expect(
    unaccounted,
    "these opcodes have no corpus vector and are not on the tracked gap list, so nothing " +
      "verifies their wire shape. Add a corpus case upstream in brain, or add the name to " +
      `conformance/coverage.json with the rest:\n  ${unaccounted.join("\n  ")}`,
  ).toEqual([]);

  // The gap list must not outlive the gap: an entry that has since been covered
  // has to be deleted, or the list stops meaning anything.
  const stale = declared
    .filter(([, value]) => covered.has(value) && gap.has(value))
    .map(([name, value]) => `${name} (${hex(value)})`)
    .sort();
  expect(
    stale,
    "these opcodes now HAVE a corpus vector but are still listed as uncovered in " +
      `conformance/coverage.json — delete them from it:\n  ${stale.join("\n  ")}`,
  ).toEqual([]);
});
