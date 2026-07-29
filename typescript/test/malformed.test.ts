/**
 * Adversarial frame decoding: what the SDK does with bytes a hostile or buggy
 * peer sends.
 *
 * Every SDK validates magic, version, reserved bytes, reserved flag bits, both
 * CRC32Cs and the payload-length bound. That code is written three times and
 * was exercised zero times — it is the layer standing between a client and a
 * peer it does not control, and a client SDK reads bytes it did not produce by
 * definition.
 *
 * Cases come from `conformance/malformed.json` so all three SDKs feed their
 * decoders byte-identical input, the same way the corpus works. A case this
 * runner cannot reproduce fails rather than skipping.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CborError, fromCbor } from "../src/wire/cbor.js";
import {
  FrameError,
  HEADER_LEN,
  OFF_HEADER_CRC,
  crc32c,
  decodeFrame,
  encodeFrame,
} from "../src/wire/frame.js";
import { corpusDir } from "./_corpus.js";

interface Mutation {
  op: "set" | "xor" | "truncate";
  offset?: number;
  value?: number;
  len?: number;
}

interface FrameCase {
  name: string;
  why: string;
  mutate: Mutation[];
  recrc: boolean;
  expect: string;
}

interface CborCase {
  name: string;
  why: string;
  payload: string;
  expect: string;
}

const V = JSON.parse(
  readFileSync(join(corpusDir, "..", "malformed.json"), "utf8"),
) as {
  base: { opcode: number; flags: number; stream_id: number; payload_hex: string };
  cases: FrameCase[];
  cbor_cases: CborCase[];
};

function hexDecode(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function validFrame(): Uint8Array {
  return encodeFrame(
    V.base.opcode,
    V.base.stream_id,
    V.base.flags,
    hexDecode(V.base.payload_hex),
  );
}

/**
 * Re-stamp `header_crc32c` so a case reaches the check it is actually about.
 * Without this, any mutation inside the CRC's coverage is caught as
 * `BadHeaderCrc` first and the case under test never runs.
 */
function recomputeHeaderCrc(buf: Uint8Array): void {
  buf.fill(0, OFF_HEADER_CRC, OFF_HEADER_CRC + 4);
  // CRC32C over header bytes 0..8 ++ 12..32 — the field itself is excluded.
  const covered = new Uint8Array(HEADER_LEN - 4);
  covered.set(buf.subarray(0, OFF_HEADER_CRC), 0);
  covered.set(buf.subarray(OFF_HEADER_CRC + 4, HEADER_LEN), OFF_HEADER_CRC);
  const crc = crc32c(covered);
  new DataView(buf.buffer, buf.byteOffset).setUint32(OFF_HEADER_CRC, crc, false);
}

function build(c: FrameCase): Uint8Array {
  let buf = new Uint8Array(validFrame());
  for (const m of c.mutate) {
    if (m.op === "set") buf[m.offset!] = m.value!;
    else if (m.op === "xor") buf[m.offset!] = (buf[m.offset!] ?? 0) ^ m.value!;
    else if (m.op === "truncate") buf = buf.slice(0, m.len);
    else throw new Error(`unknown mutation op ${JSON.stringify(m.op)}`);
  }
  if (c.recrc) recomputeHeaderCrc(buf);
  return buf;
}

describe("malformed frames are rejected with the right error", () => {
  for (const c of V.cases) {
    it(`${c.name}`, () => {
      let thrown: unknown;
      try {
        decodeFrame(build(c));
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${c.name}: decoded a malformed frame — ${c.why}`).toBeDefined();
      // A stray TypeError or RangeError would mean the decoder walked off the
      // buffer before validating.
      expect(thrown, `${c.name}: not a FrameError — ${c.why}`).toBeInstanceOf(FrameError);
      expect((thrown as FrameError).kind, `${c.name}: wrong error — ${c.why}`).toBe(c.expect);
    });
  }
});

it("the unmutated frame still decodes", () => {
  // Proves the mutations are what break these frames, not the harness.
  const { frame, rest } = decodeFrame(validFrame());
  expect(frame.opcode).toBe(V.base.opcode);
  expect(frame.streamId).toBe(V.base.stream_id);
  expect(rest.length, "a single frame leaves no trailing bytes").toBe(0);
});

function cborPayload(spec: string): Uint8Array {
  const [kind, ...rest] = spec.split(":");
  if (kind === "hex") return hexDecode(rest[0] ?? "");
  if (kind === "repeat") {
    const [byteHex, count] = rest as [string, string];
    const n = Number(count);
    const out = new Uint8Array(n + 1);
    out.fill(parseInt(byteHex, 16), 0, n);
    out[n] = 0x00;
    return out;
  }
  throw new Error(`unknown payload spec ${spec}`);
}

describe("malformed CBOR errors rather than crashing", () => {
  // The bar is "throws", not "throws a particular type". What matters is that a
  // hostile payload cannot take the process down — CVE-2026-26209 was exactly
  // this shape, a sub-100KB nested payload driving a decoder into unbounded
  // recursion. cborg overflows the stack rather than bounding depth explicitly,
  // so what is asserted is that the SDK converts that into a catchable
  // CborError instead of letting a RangeError escape its taxonomy.
  for (const c of V.cbor_cases) {
    it(`${c.name}`, () => {
      let thrown: unknown;
      try {
        fromCbor(cborPayload(c.payload));
      } catch (e) {
        thrown = e;
      }
      if (c.expect === "error_not_crash") {
        expect(thrown, `${c.name}: decoded without error — ${c.why}`).toBeDefined();
      }
      if (thrown !== undefined) {
        expect(
          thrown,
          `${c.name}: escaped the SDK's error taxonomy — ${c.why}`,
        ).toBeInstanceOf(CborError);
      }
    });
  }
});
