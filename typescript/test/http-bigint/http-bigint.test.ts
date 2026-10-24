/**
 * 64-bit integers on the HTTP tier.
 *
 * The bug this pins: `JSON.parse` has no integer wider than a double, so a
 * `*_unix_nanos` (around 1.79e18) came back with its last few digits rewritten.
 * Equality, sorting and sending the value back were all wrong, with a 200 and a
 * plausible-looking timestamp to hide it.
 *
 * The fix rewrites the JSON text before parsing it, which is a rewrite of the
 * body a server controls — so most of what is below is the adversarial half:
 * digits inside strings, digits after an escaped quote, digits in a key, the
 * exact boundary of the safe range, and the floats that must NOT be caught.
 * Each of those is a way to turn "timestamps are exact now" into "and some
 * strings are silently integers".
 */

import { describe, expect, it } from "vitest";
import * as http from "node:http";

import { BrainHttpClient } from "../../src/http/index.js";
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from "../../src/http/json.js";
import { Subscription } from "../../src/http/sse.js";

/** The value an edge actually sent, and the value `JSON.parse` turned it into. */
const NANOS = 1792843455566064875n;
const ROUNDED = 1792843455566065000;

const parse = parseJsonWithBigInts;

describe("the bug itself", () => {
  it("keeps every digit of a nanosecond timestamp", () => {
    const out = parse(`{"created_at_unix_nanos":${NANOS}}`) as Record<string, unknown>;
    expect(out.created_at_unix_nanos).toBe(NANOS);
    expect(out.created_at_unix_nanos).not.toBe(ROUNDED);
    // The literal the old path produced, spelled out: anything that reports
    // this is rounding, however it got there.
    expect(String(out.created_at_unix_nanos)).toBe("1792843455566064875");
    expect(Number(NANOS)).toBe(ROUNDED); // why a `number` cannot be the answer
  });

  it("survives a round-trip back out to the edge", () => {
    const back = stringifyJsonWithBigInts(parse(`{"event_at_unix_nanos":${NANOS}}`));
    expect(back).toBe(`{"event_at_unix_nanos":1792843455566064875}`);
  });
});

describe("what must not be rewritten", () => {
  it("leaves a large integer inside a string value alone", () => {
    const out = parse(`{"note":"id ${NANOS} failed"}`) as Record<string, unknown>;
    expect(out.note).toBe("id 1792843455566064875 failed");
    expect(typeof out.note).toBe("string");
  });

  it("does not mistake an escaped quote for the end of a string", () => {
    // Treating `\"` as a closing quote would put the scanner outside the string
    // mid-way through it, and the digits after it would be read as a value.
    const out = parse(`{"a":"he said \\"${NANOS}\\"","b":${NANOS}}`) as Record<string, unknown>;
    expect(out.a).toBe('he said "1792843455566064875"');
    expect(out.b).toBe(NANOS);
  });

  it("leaves a trailing backslash inside a string from swallowing the string", () => {
    const out = parse(`{"a":"c:\\\\","b":${NANOS}}`) as Record<string, unknown>;
    expect(out.a).toBe("c:\\");
    expect(out.b).toBe(NANOS);
  });

  it("leaves a key that looks like a number as a key", () => {
    const out = parse(`{"${NANOS}":1,"b":${NANOS}}`) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["1792843455566064875", "b"]);
    expect(out["1792843455566064875"]).toBe(1);
    expect(out.b).toBe(NANOS);
  });

  it("leaves floats and exponents as numbers whatever their magnitude", () => {
    // `1e21` is not an integer that happens to be large: the JSON grammar says
    // it is a float, and a float it stays. `1792843455566064875.5` lost its
    // digits in whatever wrote it, so there is nothing here to preserve.
    const out = parse(
      `{"a":1.5,"b":1e21,"c":-0.0,"d":1792843455566064875.5,"e":-1.5e-7}`,
    ) as Record<string, number>;
    for (const [k, v] of Object.entries(out)) {
      expect(typeof v, `${k} must stay a number`).toBe("number");
    }
    expect(out.a).toBe(1.5);
    expect(out.b).toBe(1e21);
    expect(Object.is(out.c, -0)).toBe(true);
    expect(out.e).toBe(-1.5e-7);
  });

  it("leaves a payload with no large integers byte-for-byte as JSON.parse had it", () => {
    const text = `{"a":1,"b":[0,-1,2.5],"c":{"d":"x"},"e":null,"f":true,"g":9007199254740991}`;
    expect(parse(text)).toEqual(JSON.parse(text));
  });
});

describe("the boundary of the safe range", () => {
  // The rule, stated once and asserted both ways: conversion happens when the
  // magnitude is STRICTLY greater than MAX_SAFE_INTEGER. 9007199254740991
  // round-trips through a double exactly, so it is still a `number`.
  const cases: Array<[string, "number" | "bigint"]> = [
    ["9007199254740990", "number"],
    ["9007199254740991", "number"],
    ["9007199254740992", "bigint"],
    ["-9007199254740991", "number"],
    ["-9007199254740992", "bigint"],
    ["9223372036854775807", "bigint"], // i64 max
    ["-9223372036854775808", "bigint"], // i64 min
    ["18446744073709551615", "bigint"], // u64 max
    ["0", "number"],
    ["-0", "number"],
  ];

  for (const [literal, kind] of cases) {
    it(`${literal} parses as a ${kind}`, () => {
      const out = parse(`{"v":${literal}}`) as { v: unknown };
      expect(typeof out.v).toBe(kind);
      expect(String(out.v)).toBe(literal === "-0" ? "0" : literal);
    });
  }

  it("holds i64 and u64 extremes exactly", () => {
    const out = parse(`{"i":-9223372036854775808,"u":18446744073709551615}`) as Record<
      string,
      bigint
    >;
    expect(out.i).toBe(-9223372036854775808n);
    expect(out.u).toBe(18446744073709551615n);
  });
});

describe("structure", () => {
  it("reaches a large integer in an array", () => {
    expect(parse(`[1,${NANOS},3]`)).toEqual([1, NANOS, 3]);
  });

  it("reaches one nested several levels deep", () => {
    const out = parse(`{"a":{"b":[{"c":{"d":[${NANOS}]}}]}}`);
    expect(out).toEqual({ a: { b: [{ c: { d: [NANOS] } }] } });
  });

  it("handles whitespace between every token", () => {
    const out = parse(`{\n  "a" : ${NANOS} ,\n  "b" : [ 1 , ${NANOS} ]\n}`);
    expect(out).toEqual({ a: NANOS, b: [1, NANOS] });
  });

  it("handles the empty and null shapes", () => {
    expect(parse("null")).toBeNull();
    expect(parse("{}")).toEqual({});
    expect(parse("[]")).toEqual([]);
    expect(parse('""')).toBe("");
    expect(parse(`{"a":null,"b":{},"c":[],"d":"","e":${NANOS}}`)).toEqual({
      a: null,
      b: {},
      c: [],
      d: "",
      e: NANOS,
    });
  });

  it("parses a bare large integer at the top level", () => {
    expect(parse(String(NANOS))).toBe(NANOS);
  });

  it("still reports malformed JSON rather than inventing a value", () => {
    expect(() => parse(`{"a":01792843455566064875}`)).toThrow(SyntaxError);
    expect(() => parse(`{"a":${NANOS}`)).toThrow(SyntaxError);
    expect(() => parse(`{"a":"unterminated`)).toThrow(SyntaxError);
  });

  it("cannot be tricked by a string that already carries the internal tag", () => {
    // Rewritten integers travel through `JSON.parse` as strings with a private
    // prefix. A payload is free to contain that prefix itself, and a string is
    // what it must come back as.
    const out = parse(`{"a":"\\u0000n${NANOS}","b":${NANOS},"c":"\\u0000nx"}`) as Record<
      string,
      unknown
    >;
    expect(out.a).toBe(`\u0000n1792843455566064875`);
    expect(typeof out.a).toBe("string");
    expect(out.b).toBe(NANOS);
    expect(out.c).toBe("\u0000nx");
  });

  it("never renames a key, whatever the key looks like", () => {
    // The escape above is applied to values only. A reviver is handed values,
    // so a prefix put on a key would simply stay there.
    const out = parse(`{"\\u0000n1":${NANOS},"\\u0000":2,"":3}`) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["\u0000n1", "\u0000", ""]);
    expect(out["\u0000n1"]).toBe(NANOS);
  });
});

describe("serializing a request body", () => {
  it("writes a bigint as a JSON integer, not a string", () => {
    expect(stringifyJsonWithBigInts({ session: 12n, at: NANOS })).toBe(
      `{"session":12,"at":1792843455566064875}`,
    );
    // `JSON.stringify` is what the body used to go through, and this is why it
    // no longer can.
    expect(() => JSON.stringify({ at: NANOS })).toThrow(TypeError);
  });

  it("omits an undefined field and writes an undefined element as null", () => {
    expect(stringifyJsonWithBigInts({ a: 1, b: undefined })).toBe(`{"a":1}`);
    expect(stringifyJsonWithBigInts([1, undefined, 2n])).toBe(`[1,null,2]`);
  });

  it("escapes strings the way JSON.stringify does", () => {
    const value = { 'q"\\': 'line\n\u0000"' };
    expect(stringifyJsonWithBigInts(value)).toBe(JSON.stringify(value));
  });
});

// --- through the real client ----------------------------------------------

describe("through BrainHttpClient", () => {
  /** Run one request against a server that replies with `body` verbatim. */
  async function withEdge<T>(
    body: string,
    call: (client: BrainHttpClient) => Promise<T>,
  ): Promise<{ out: T; sent: string; path: string }> {
    let sent = "";
    let path = "";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        sent = Buffer.concat(chunks).toString();
        path = req.url ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      const client = new BrainHttpClient({
        apiKey: "brain_test-key",
        baseUrl: `http://127.0.0.1:${port}`,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      });
      return { out: await call(client), sent, path };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("hands the caller the timestamp the edge sent, digit for digit", async () => {
    const { out } = await withEdge(
      `{"memory_id":"42","was_deduplicated":false,"salience":0.5,"kind":0,` +
        `"created_at_unix_nanos":${NANOS},"auto_edges_added":1}`,
      (c) => c.encode({ text: "the sky is teal" }),
    );
    expect(out.createdAtUnixNanos).toBe(NANOS);
    expect(out.createdAtUnixNanos).not.toBe(ROUNDED);
    expect(out.autoEdgesAdded, "an ordinary small field is still a number").toBe(1);
  });

  it("sends a timestamp back out unchanged", async () => {
    // The whole point of reading it exactly: a value read from one call has to
    // be usable as the input to the next.
    const { out } = await withEdge(`{"memory_id":"1","created_at_unix_nanos":${NANOS}}`, (c) =>
      c.encode({ text: "a" }),
    );
    const { sent } = await withEdge(`{"memory_id":"2"}`, (c) =>
      c.encode({ text: "b", occurredAtUnixNanos: out.createdAtUnixNanos }),
    );
    expect(sent).toBe(`{"text":"b","occurred_at_unix_nanos":1792843455566064875}`);
  });

  it("widens a small value in a declared-bigint field", async () => {
    // Otherwise one field has two runtime types depending on the value, and
    // `createdAtUnixNanos === someOtherTimestamp` is a coin flip.
    const { out } = await withEdge(
      `{"space_id":"s","session_id":7,"created":true,"created_at_unix_nanos":0,` +
        `"last_active_unix_nanos":0,"memory_count":3}`,
      (c) => c.createSession({ sessionId: 7n }),
    );
    expect(out.sessionId).toBe(7n);
    expect(out.createdAtUnixNanos).toBe(0n);
    expect(out.memoryCount, "a count is not a 64-bit value and stays a number").toBe(3);
  });

  it("carries a bigint session id into the request body and the path", async () => {
    const big = 18446744073709551615n;
    const { sent } = await withEdge(`{}`, (c) => c.createSession({ sessionId: big }));
    expect(sent).toBe(`{"session_id":18446744073709551615}`);

    const { path } = await withEdge(`{}`, (c) => c.deleteSession(big, { hard: true }));
    expect(path).toBe("/v1/sessions/18446744073709551615?hard=true");
  });

  it("puts a bigint query parameter in the URL with its digits intact", async () => {
    // A query string is built by hand, not by `JSON.stringify`, so it is a
    // second place a `bigint` has to be spelled out rather than rejected.
    const { path } = await withEdge(`{}`, async (c) => {
      const feed = await c.subscribe({ fromLsn: NANOS, sessions: [7n, 8n] });
      await feed.close();
    });
    expect(path).toBe("/v1/subscribe?sessions=7%2C8&from_lsn=1792843455566064875");
  });

  it("reads a statement's unix_nanos value as a bigint and leaves a float alone", async () => {
    // `StatementValue` is tagged by `type` and its payload key is always
    // `value`, so the tag is the only thing that says which ones are integers.
    const { out } = await withEdge(
      `{"statement_id":"s1","kind":"fact","subject":"e1","predicate":"born_at",` +
        `"object":{"kind":"value","value":{"type":"unix_nanos","value":42}},` +
        `"confidence":1,"event_at_unix_nanos":${NANOS},"valid_from_unix_nanos":1,` +
        `"valid_to_unix_nanos":0,"tombstoned":false}`,
      (c) => c.getStatement("s1"),
    );
    expect(out.eventAtUnixNanos).toBe(NANOS);
    if (out.object.kind !== "value") throw new Error("unreachable");
    expect(out.object.value.type).toBe("unix_nanos");
    if (out.object.value.type !== "unix_nanos") throw new Error("unreachable");
    expect(out.object.value.value).toBe(42n);

    const { out: f } = await withEdge(
      `{"statement_id":"s2","object":{"kind":"value","value":{"type":"float","value":0.5}}}`,
      (c) => c.getStatement("s2"),
    );
    if (f.object.kind !== "value") throw new Error("unreachable");
    if (f.object.value.type !== "float") throw new Error("unreachable");
    expect(f.object.value.value).toBe(0.5);
  });

  it("does not round a 128-bit id, which is a string on this surface", async () => {
    const { out } = await withEdge(
      `{"memory_id":"340282366920938463463374607431768211455","was_deduplicated":false}`,
      (c) => c.encode({ text: "a" }),
    );
    expect(out.memoryId).toBe("340282366920938463463374607431768211455");
  });
});

// --- through the change feed ----------------------------------------------

describe("through the SSE feed", () => {
  function feedOf(text: string): Subscription {
    return new Subscription(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    );
  }

  it("decodes an event's lsn and timestamp exactly", async () => {
    const feed = feedOf(
      `event: message\ndata: {"event_type":"encoded","memory_id":"7","session_id":${NANOS},` +
        `"text":"x","kind":0,"salience":0.5,"timestamp_unix_nanos":${NANOS},"lsn":9007199254740993}\n\n` +
        `event: closed\ndata: {"final_lsn":9007199254740993,"reason":"ended"}\n\n`,
    );
    const items = [];
    for await (const item of feed) items.push(item);

    expect(items).toHaveLength(2);
    const [first, second] = items;
    if (first?.kind !== "event") throw new Error("expected an event");
    expect(first.event.timestampUnixNanos).toBe(NANOS);
    expect(first.event.sessionId).toBe(NANOS);
    expect(first.event.lsn).toBe(9007199254740993n);
    if (second?.kind !== "closed") throw new Error("expected the terminal close");
    expect(second.closed.finalLsn).toBe(9007199254740993n);
  });
});
