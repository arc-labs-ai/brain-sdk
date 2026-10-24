/**
 * The JSON seam between the edge's wire format and this SDK's types: key case,
 * and 64-bit integers.
 *
 * `JSON.parse` has no 64-bit integer. Every `*_unix_nanos` the edge sends is
 * around 1.79e18, well past `Number.MAX_SAFE_INTEGER` (9007199254740991), so
 * reading one as a `number` silently rewrites its last few digits:
 *
 *     edge sent   1792843455566064875
 *     JSON.parse  1792843455566065000
 *
 * A caller comparing two timestamps, sorting by one, or sending one back gets a
 * value the server never had. The rounding happens inside `JSON.parse`, before
 * a reviver or a type annotation can reach it, so the only cure is to change
 * what `JSON.parse` is handed: {@link parseJsonWithBigInts} rewrites integer
 * literals outside the safe range into tagged strings and converts those to
 * `bigint` on the way out.
 *
 * Why text, and not the ES2025 reviver `context.source`: that argument does
 * expose the original digits, but it does not exist on Node 18 or 20, and this
 * package supports `node >= 18`. An engine-dependent fix is one that reports
 * correct timestamps in CI and rounded ones on a customer's LTS runtime — the
 * same silent corruption, now only on some machines. One code path is also one
 * code path to test.
 *
 * The wire tier reaches the same representation by a shorter road: CBOR carries
 * integers natively, so `src/wire/types.ts` has had `bigint` for these values
 * all along. This makes the HTTP tier agree with it.
 */

/**
 * The boundary, stated once: an integer is converted when its magnitude is
 * strictly greater than `Number.MAX_SAFE_INTEGER`. `9007199254740991` itself
 * round-trips through a `number` exactly, so it stays one; `9007199254740992`
 * does not, so it becomes a `bigint`.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * How a rewritten integer travels through `JSON.parse`: as a string prefixed
 * with NUL + `n`.
 *
 * NUL leads because JSON has exactly one spelling for it inside a string —
 * `\u0000` — which makes "could this payload already contain the tag?" a
 * question about the first six characters of a string literal rather than a
 * guess. See the escaping branch in {@link parseJsonWithBigInts}.
 */
const TAG = "\u0000n";

/** The same tag as it must be written in JSON source: NUL cannot appear raw. */
const TAG_SOURCE = '"\\u0000n';

/**
 * A JSON number, per the grammar rather than loosely. Anything the grammar
 * rejects (`01`, a bare `-`) is left for `JSON.parse` to reject, instead of
 * being quoted here and turned into a string the parser accepts.
 *
 * Sticky, so the scan can match in place; `lastIndex` is set per use.
 */
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/**
 * Parse JSON, keeping every integer exact.
 *
 * Integer literals outside the safe range come back as `bigint`; everything
 * else is what `JSON.parse` would have produced. A literal carrying a fraction
 * or an exponent is a float by the JSON grammar and stays a `number` whatever
 * its magnitude — `1e21` is not an integer that happens to be large, and
 * `1792843455566064875.5` has already lost its digits to the float the edge
 * wrote it from.
 */
export function parseJsonWithBigInts(text: string): unknown {
  // The rewrite is a full pass over the body, and a recall trace alone can be
  // 121 KB. Neither thing it looks for can be present without these two
  // substrings, and a payload with no 16-digit run has no unsafe integer: the
  // safe range is 16 digits wide, so anything shorter fits.
  if (!/[0-9]{16}/.test(text) && !text.includes("\\u0000")) {
    return JSON.parse(text);
  }

  let out = "";
  let cut = 0;
  let rewrote = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      // A decoded string can begin with the tag only if its source begins with
      // the escape for NUL. Prefixing the tag to such a string keeps it
      // distinguishable from a rewritten integer: the converter below strips
      // one tag back off, and what is under it still starts with NUL, which a
      // decimal literal never does.
      //
      // Only a value, never a key: a reviver is handed values, so a prefix put
      // on a key would stay there and rename the field.
      if (text.startsWith('"\\u0000', i) && !isKeyPosition(text, end)) {
        out += text.slice(cut, i) + TAG_SOURCE + text.slice(i + 1, end);
        cut = end;
        rewrote = true;
      }
      i = end;
      continue;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m === null) {
        i += 1;
        continue;
      }
      const literal = m[0];
      if (m[1] === undefined && m[2] === undefined && isUnsafeInteger(literal)) {
        out += `${text.slice(cut, i)}${TAG_SOURCE}${literal}"`;
        cut = i + literal.length;
        rewrote = true;
      }
      i += literal.length;
      continue;
    }
    i += 1;
  }

  if (!rewrote) return JSON.parse(text);
  return JSON.parse(out + text.slice(cut), (_key, value: unknown) => {
    if (typeof value !== "string" || !value.startsWith(TAG)) return value;
    const rest = value.slice(TAG.length);
    return rest.startsWith("\u0000") ? rest : BigInt(rest);
  });
}

/** Was the string that ended at `end` a key — i.e. is a `:` what follows it? */
function isKeyPosition(text: string, end: number): boolean {
  for (let i = end; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return c === ":";
  }
  return false;
}

/** Where the string literal starting at `start` ends, one past its closing quote. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    // A backslash consumes the next character whatever it is, which is what
    // keeps an escaped quote from ending the string and letting the digits
    // after it be read as a value.
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === '"') return i + 1;
  }
  // Unterminated: leave it for `JSON.parse` to report.
  return text.length;
}

/** Does this integer literal need more than a `number` to hold it exactly? */
function isUnsafeInteger(literal: string): boolean {
  // `BigInt()` on every integer in a 121 KB body would be the cost of this
  // fix. The safe range is 16 digits wide, so fewer digits than that cannot
  // leave it.
  const digits = literal.charCodeAt(0) === 0x2d ? literal.length - 1 : literal.length;
  if (digits < 16) return false;
  const value = BigInt(literal);
  return value > MAX_SAFE || value < -MAX_SAFE;
}

/**
 * Serialize a request body, writing `bigint` as a JSON integer.
 *
 * `JSON.stringify` throws on a `bigint` outright, and a `toJSON` or a replacer
 * can only put one back as a string — which the edge's serde would reject for
 * an integer field. Writing the structure out directly is what lets a session
 * id or an `occurred_at_unix_nanos` go out with the digits the caller gave.
 *
 * Only what `toSnakeKeys` produces reaches here: strings, numbers, bigints,
 * booleans, null, arrays and plain objects.
 */
export function stringifyJsonWithBigInts(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    // A hole or an `undefined` element is `null` in JSON, as `JSON.stringify`
    // has it.
    return `[${value.map((v) => (v === undefined ? "null" : stringifyJsonWithBigInts(v))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // An omitted optional field must be absent, not `null`: the edge defaults
      // what is missing and validates what is present.
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${stringifyJsonWithBigInts(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The edge speaks snake_case JSON; this SDK speaks camelCase, as its wire types
 * already do. Converting at the transport seam keeps one convention in the
 * public API instead of two — Rust and Python have no such split because
 * snake_case is idiomatic there, so their HTTP types match the wire by
 * coincidence rather than by a different rule.
 *
 * Generic rather than a hand-written mapping per field of every DTO across the
 * edge's 25 routes: every HTTP type here is a fixed-shape struct with plain
 * snake_case keys, so the transform is total and mechanical. There are no
 * free-form maps whose keys would be wrongly rewritten, and the tagged unions
 * carry their tag in a value, which the transform does not touch.
 */
export function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function toSnakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[snakeCase(k)] = toSnakeKeys(v);
  }
  return out;
}

/**
 * Fields this SDK types as `bigint`, named rather than inferred from the value.
 *
 * {@link parseJsonWithBigInts} decides by magnitude, which is what stops an
 * unknown field from ever losing digits — but it means a field's runtime type
 * would otherwise follow the value: `lsn: 7` a `number`, `lsn: 2n ** 60n` a
 * `bigint`. Two representations for one field is a trap for `===`, for a `Map`
 * key and for arithmetic, so a field declared `bigint` is widened here however
 * small the value arrived.
 *
 * A rule rather than a list for the timestamps, because the field that caused
 * this is the field nobody listed: a `*_unix_nanos` the edge adds tomorrow is
 * covered the day it ships.
 *
 * What is deliberately NOT here: `memory_count`, `memories_forgotten`,
 * `grace_period_seconds`, `*_unix_ms` and `created_at_unix_secs`. The edge
 * stores those in 64 bits, but 2^53 of anything countable is not reachable and
 * 2^53 milliseconds is the year 287396 — so they stay `number`, where callers
 * can do arithmetic on them. The line is whether a value can exceed
 * `Number.MAX_SAFE_INTEGER`, not how wide the server's integer type is.
 */
function isWideField(key: string): boolean {
  return (
    key.endsWith("UnixNanos") ||
    key === "sessionId" ||
    key === "session" ||
    key === "lsn" ||
    key === "fromLsn" ||
    key === "finalLsn"
  );
}

/**
 * The two statement values the edge sends as a bare 64-bit integer.
 *
 * `StatementValue` is tagged by `type` and its payload key is always `value`,
 * so these cannot be recognised by name the way every other field can — the
 * tag is what says whether this `value` is an i64 or a float.
 */
const WIDE_STATEMENT_VALUE_TYPES = new Set(["integer", "unix_nanos"]);

/** Widen a `number` that a declared-`bigint` field arrived in. */
function widen(value: unknown): unknown {
  // A non-integral number in one of these fields is the edge contradicting its
  // own contract; passing it through loses nothing, where `BigInt()` would
  // throw and cost the caller the whole response.
  return typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value;
}

/** Convert the edge's snake_case keys to the camelCase this SDK speaks. */
export function toCamelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    if (isWideField(key)) {
      out[key] = widen(v);
    } else if (key === "sessions" && Array.isArray(v)) {
      // `sessions` is a list of session ids on a filter and a list of session
      // objects on a listing; only the ids are integers to widen.
      out[key] = v.map((item) => (typeof item === "number" ? widen(item) : toCamelKeys(item)));
    } else {
      out[key] = toCamelKeys(v);
    }
  }
  if (
    typeof out.type === "string" &&
    WIDE_STATEMENT_VALUE_TYPES.has(out.type) &&
    typeof out.value === "number"
  ) {
    out.value = widen(out.value);
  }
  return out;
}

/** Decode a response body: exact integers, camelCase keys. */
export function decodeJsonBody(text: string): unknown {
  return toCamelKeys(parseJsonWithBigInts(text));
}
