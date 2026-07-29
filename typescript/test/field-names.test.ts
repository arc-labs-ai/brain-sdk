/**
 * Field-name drift guard: the property a caller reads must be the field the
 * server sent.
 *
 * `conformance.test.ts` proves the codec puts the right bytes on the wire. It
 * cannot prove those bytes land in the right property, because its only
 * assertion is `encode(decode(golden)) == golden` — the encoder witnesses the
 * decoder and vice versa. Invert a field pair in both together and it passes:
 *
 *     decode(golden).salienceMin -> 1.0   (server said 0.0)
 *     encode(that)               -> identical bytes
 *
 * That is not hypothetical. Injecting exactly that swap into the Python SDK
 * left all 134 of its tests green, including its `.json` mirror comparison —
 * which also runs through the encoder. TypeScript had neither check.
 *
 * This suite reads the DECODED OBJECT'S OWN PROPERTY NAMES, snake_cases them,
 * and compares against the `.json` mirror, which carries the server's field
 * names. The encoder is not consulted, so it cannot cover for the decoder.
 *
 * Limits, stated rather than implied:
 *  - A property the SDK invented that happens to hold its default value is
 *    indistinguishable from a field the wire omits by convention (`actAs` when
 *    null, `wait` at Ack, empty arrays). The valuable half — a meaningful value
 *    the server never sent — is caught.
 *  - `frame_*` cases are skipped: their mirrors describe a header, not a
 *    payload struct.
 */

import { describe, it, expect } from "vitest";

import { FRAME_CASE, codecs, corpusIndex, readBin, readJsonText } from "./_corpus.js";

/**
 * Structurally absent from the CBOR map, so absence from the mirror says
 * nothing about drift. `vector` rides the trailing raw-f32 section of the
 * payload, never the CBOR — see the corpus README.
 */
const MIRROR_OMITS = new Set(["vector"]);

/**
 * `camelCase` -> `snake_case`, matching the server's field naming.
 *
 * A leading capital is left alone. Every field name in this protocol is
 * `snake_case` on the server and `camelCase` here, so neither starts with one;
 * a key that does is serde's external variant tag — `{Custom: 5}`,
 * `{Other: "…"}` — which is a wire literal, not a name to be translated.
 * Lowercasing those made the harness disagree with itself, reporting
 * `kind.custom` missing from a mirror that says `kind.Custom`.
 */
function snake(s: string): string {
  if (/^[A-Z]/.test(s)) return s;
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Parse a mirror preserving integer precision.
 *
 * `memory_id` is a u128 and `*_unix_nanos` are u64 — both exceed
 * `Number.MAX_SAFE_INTEGER`, and `JSON.parse` would round them before any
 * reviver could intervene. Quoting integer literals in the raw text first keeps
 * them exact; the projection below renders every integer as a decimal string on
 * both sides, so the comparison is like-for-like.
 */
function parseMirror(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    // A number literal outside a string. Quote it only if it is an integer —
    // floats must stay numeric so they can be compared with an f32 tolerance.
    if (c === "-" || (c >= "0" && c <= "9")) {
      // Consume the whole JSON number, then decide how to emit it.
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))!;
      const literal = match[0];
      const isInteger = match[1] === undefined && match[2] === undefined;
      out += isInteger ? `"${literal}"` : literal;
      i += literal.length - 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

/** Canonical form: integers as decimal strings, floats left as numbers. */
function project(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value;
  }
  if (value instanceof Uint8Array) return Array.from(value, (b) => String(b));
  if (Array.isArray(value)) return value.map(project);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[snake(k)] = project(v);
    }
    return out;
  }
  return value;
}

/**
 * Is this node a tagged union rather than a struct?
 *
 * serde encodes enums externally-tagged — a bare string for a unit variant,
 * `{Variant: payload}` otherwise — while the TS side models them idiomatically
 * as `{kind: "variant", ...payload}`. The two shapes are both correct and do
 * not line up field-for-field, so this guard steps over them rather than
 * pattern-matching its way through a translation it could get wrong. They stay
 * covered by the byte-level check in `conformance.test.ts`; what is lost is the
 * property-name check *inside* a union payload.
 */
function isUnionNode(got: unknown, exp: unknown): boolean {
  if (typeof exp === "string") return true;
  const gotTagged =
    got !== null &&
    typeof got === "object" &&
    !Array.isArray(got) &&
    typeof (got as Record<string, unknown>).kind === "string";
  const expExternallyTagged =
    exp !== null &&
    typeof exp === "object" &&
    !Array.isArray(exp) &&
    Object.keys(exp as object).length === 1 &&
    /^[A-Z]/.test(Object.keys(exp as object)[0]!);
  return gotTagged && expExternallyTagged;
}

/** A value that stands in for "the wire omits this by convention". */
function isDefaulted(v: unknown): boolean {
  return (
    v === null ||
    v === false ||
    v === "0" ||
    v === 0 ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

function compare(got: unknown, exp: unknown, path: string, errors: string[]): void {
  if (isUnionNode(got, exp)) return;

  // An f32 holding a whole number decodes to `0`, which is indistinguishable
  // from an integer by value; the mirror writes it `0.0`. Compare numerically
  // when one side is a number and the other its decimal string.
  const asNumber = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
  if (typeof got === "number" || typeof exp === "number") {
    const g = asNumber(got);
    const e = asNumber(exp);
    if (g !== null && e !== null) {
      if (Math.fround(g) !== Math.fround(e)) errors.push(`${path}: ${got} != ${exp}`);
      return;
    }
  }

  const bothObjects =
    got !== null &&
    exp !== null &&
    typeof got === "object" &&
    typeof exp === "object" &&
    !Array.isArray(got) &&
    !Array.isArray(exp);

  if (bothObjects) {
    const g = got as Record<string, unknown>;
    const e = exp as Record<string, unknown>;
    for (const k of Object.keys(g)) {
      if (k in e) continue;
      if (MIRROR_OMITS.has(k) || isDefaulted(g[k])) continue;
      errors.push(`${path}.${k}: SDK has a property the server does not send`);
    }
    for (const k of Object.keys(e)) {
      if (!(k in g)) {
        errors.push(`${path}.${k}: server sends a field the SDK does not declare`);
      }
    }
    for (const k of Object.keys(g)) {
      if (k in e) compare(g[k], e[k], `${path}.${k}`, errors);
    }
    return;
  }

  if (Array.isArray(got) && Array.isArray(exp)) {
    if (got.length !== exp.length) {
      errors.push(`${path}: length ${got.length} != ${exp.length}`);
      return;
    }
    got.forEach((v, i) => compare(v, exp[i], `${path}[${i}]`, errors));
    return;
  }

  if (got !== exp) {
    errors.push(`${path}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
  }
}

describe("declared property names match the server", () => {
  for (const entry of corpusIndex) {
    if (entry.kind === "frame") continue;
    const codec = codecs[entry.name];
    if (!codec || codec === FRAME_CASE) continue;

    it(entry.name, () => {
      const decoded = codec.decode(readBin(entry.name));
      const errors: string[] = [];
      compare(project(decoded), parseMirror(readJsonText(entry.name)), entry.name, errors);
      expect(
        errors,
        `${entry.name}: declared properties disagree with the server\n  ${errors.join("\n  ")}`,
      ).toEqual([]);
    });
  }
});
