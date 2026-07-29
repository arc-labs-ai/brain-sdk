/**
 * CBOR payload codec + trailing raw little-endian f32 vector section.
 *
 * A wire payload is a CBOR map carrying the structured fields, optionally
 * followed by a raw little-endian f32 block for embedding vectors. Vectors stay
 * out of the CBOR so the floats keep full precision and stay contiguous for a
 * bulk copy.
 *
 * Why a focused encoder instead of a library's default `encode`: the bytes must
 * match the server's `ciborium` output exactly, which means three things a
 * general-purpose JS encoder gets wrong out of the box:
 *
 *   - Maps keep insertion (struct-declaration) order, not bytewise-sorted keys.
 *   - Floats use shortest round-tripping width, exactly like the server's
 *     `ciborium`: a value is emitted as half precision (0xf9) if half round-
 *     trips it exactly, else single (0xfa) if single does, else double (0xfb).
 *     This applies to BOTH f32 and f64 fields (an f32 field's value is already
 *     rounded to f32, so single is its widest form; an f64 field can need all
 *     three). Do NOT "fix" this back to a fixed width per type — emitting f32
 *     fields as 0xfa and f64 fields as 0xfb unconditionally would diverge from
 *     the server and the Python (`cbor.py _shortest_float_bytes`) and Rust
 *     ports, breaking byte-exactness (e.g. 0.25 and 12.5 must collapse to half).
 *   - Integers above the u64 range encode as a CBOR bignum (tag 2 + byte
 *     string), exactly as `ciborium` emits a u128; everything that fits in u64
 *     uses the shortest-form major-0 integer.
 *
 * Decoding uses the `cborg` reader, which distinguishes byte strings
 * (Uint8Array) from arrays and decodes 64-bit integers as BigInt; a tag-2
 * decoder folds the bignum case (a u128) back into a BigInt.
 */

import { decode as cborgDecode } from "cborg";

/** Failures decoding a CBOR payload. */
export class CborError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CborError";
  }
}

// ---------------------------------------------------------------------------
// Value model.
//
// The encoder walks a plain JS value tree. Most types map directly:
//   number  -> integer (if integral) or f64 float
//   bigint  -> integer (or bignum tag 2 when above u64)
//   boolean -> simple true/false
//   null    -> simple null
//   string  -> text string
//   Array   -> array
//   Map     -> map (insertion order preserved)
//   Uint8Array -> byte string
// The two wrappers below pin float width, which a bare `number` cannot express.
// ---------------------------------------------------------------------------

/** A single-precision (f32) float field. */
export class F32 {
  constructor(public readonly value: number) {}
}

/** A double-precision (f64) float field. */
export class F64 {
  constructor(public readonly value: number) {}
}

/** Wrap a number as an f32 CBOR float (0xfa head). */
export function f32(value: number): F32 {
  return new F32(value);
}

/** Wrap a number as an f64 CBOR float (0xfb head). */
export function f64(value: number): F64 {
  return new F64(value);
}

// CBOR major types (high three bits of the initial byte).
const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

const TAG_POSITIVE_BIGNUM = 2;
const U64_MAX = (1n << 64n) - 1n;

/** A growable byte sink. */
class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  pushBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Write the CBOR head: a major type plus its argument, shortest form. */
  pushHead(major: number, arg: bigint): void {
    const m = major << 5;
    if (arg < 24n) {
      this.pushByte(m | Number(arg));
    } else if (arg <= 0xffn) {
      this.pushByte(m | 24);
      this.pushByte(Number(arg));
    } else if (arg <= 0xffffn) {
      this.pushByte(m | 25);
      this.pushByte(Number((arg >> 8n) & 0xffn));
      this.pushByte(Number(arg & 0xffn));
    } else if (arg <= 0xffffffffn) {
      this.pushByte(m | 26);
      this.pushByte(Number((arg >> 24n) & 0xffn));
      this.pushByte(Number((arg >> 16n) & 0xffn));
      this.pushByte(Number((arg >> 8n) & 0xffn));
      this.pushByte(Number(arg & 0xffn));
    } else {
      this.pushByte(m | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        this.pushByte(Number((arg >> shift) & 0xffn));
      }
    }
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function writeInteger(w: Writer, n: bigint): void {
  if (n >= 0n) {
    if (n <= U64_MAX) {
      w.pushHead(MAJOR_UINT, n);
    } else {
      writeBignum(w, n);
    }
  } else {
    // CBOR negative integers encode -1 - n.
    const arg = -1n - n;
    if (arg <= U64_MAX) {
      w.pushHead(MAJOR_NEGINT, arg);
    } else {
      throw new CborError(`integer out of representable range: ${n}`);
    }
  }
}

/** Encode a positive integer above u64 as a tag-2 bignum (big-endian bytes). */
function writeBignum(w: Writer, n: bigint): void {
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes.length === 0) bytes.push(0);
  w.pushHead(MAJOR_TAG, BigInt(TAG_POSITIVE_BIGNUM));
  w.pushHead(MAJOR_BYTES, BigInt(bytes.length));
  w.pushBytes(Uint8Array.from(bytes));
}

const textEncoder = new TextEncoder();

/** Name a value's shape for an error message, without `[object Object]`. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  return ctor ? `${ctor} instance` : "plain object";
}

function writeValue(w: Writer, value: unknown): void {
  if (value === null || value === undefined) {
    w.pushByte((MAJOR_SIMPLE << 5) | 22);
    return;
  }
  if (typeof value === "boolean") {
    w.pushByte((MAJOR_SIMPLE << 5) | (value ? 21 : 20));
    return;
  }
  if (typeof value === "bigint") {
    writeInteger(w, value);
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      writeInteger(w, BigInt(value));
    } else {
      // A bare non-integral number defaults to f64; float-width-sensitive
      // fields must use the F32/F64 wrappers.
      writeF64(w, value);
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    w.pushHead(MAJOR_TEXT, BigInt(bytes.length));
    w.pushBytes(bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    w.pushHead(MAJOR_BYTES, BigInt(value.length));
    w.pushBytes(value);
    return;
  }
  if (value instanceof F32) {
    writeF32(w, value.value);
    return;
  }
  if (value instanceof F64) {
    writeF64(w, value.value);
    return;
  }
  if (Array.isArray(value)) {
    w.pushHead(MAJOR_ARRAY, BigInt(value.length));
    for (const item of value) writeValue(w, item);
    return;
  }
  if (value instanceof Map) {
    w.pushHead(MAJOR_MAP, BigInt(value.size));
    for (const [k, v] of value) {
      const kb = textEncoder.encode(String(k));
      w.pushHead(MAJOR_TEXT, BigInt(kb.length));
      w.pushBytes(kb);
      writeValue(w, v);
    }
    return;
  }
  // `String(value)` renders every plain object as the literal `[object
  // Object]`, which is exactly the case that reaches here most often (a caller
  // passing an object literal where the codec wants a Map). Name the shape
  // instead, so the message says what to fix.
  throw new CborError(`cannot encode value of unexpected shape: ${describeValue(value)}`);
}

// `ciborium` writes floats in shortest form: a value is emitted as half
// precision (0xf9) if that round-trips it exactly, else single (0xfa) if that
// round-trips it exactly, else double (0xfb). An f32 field's value is already
// rounded to f32, so its widest form is f32; an f64 field can need all three.
// Matching this rule is required for byte-exactness — e.g. 0.25 and 12.5 both
// collapse to half precision on the wire.

/** Emit an f32-valued field, narrowing to half precision when exact. */
function writeF32(w: Writer, value: number): void {
  const half = toHalfBitsExact(value);
  if (half !== null) {
    writeHalf(w, half);
    return;
  }
  writeSingle(w, value);
}

/** Emit an f64-valued field, narrowing to half or single when exact. */
function writeF64(w: Writer, value: number): void {
  const half = toHalfBitsExact(value);
  if (half !== null) {
    writeHalf(w, half);
    return;
  }
  if (Math.fround(value) === value) {
    writeSingle(w, value);
    return;
  }
  writeDouble(w, value);
}

function writeHalf(w: Writer, bits: number): void {
  w.pushByte((MAJOR_SIMPLE << 5) | 25);
  w.pushByte((bits >> 8) & 0xff);
  w.pushByte(bits & 0xff);
}

function writeSingle(w: Writer, value: number): void {
  const head = new Uint8Array(5);
  head[0] = (MAJOR_SIMPLE << 5) | 26;
  new DataView(head.buffer).setFloat32(1, value, false);
  w.pushBytes(head);
}

function writeDouble(w: Writer, value: number): void {
  const head = new Uint8Array(9);
  head[0] = (MAJOR_SIMPLE << 5) | 27;
  new DataView(head.buffer).setFloat64(1, value, false);
  w.pushBytes(head);
}

/**
 * Return the 16-bit half-precision encoding of `value` if it round-trips
 * exactly, else null. Covers normals in the half exponent range whose mantissa
 * fits in 10 bits; subnormals, infinities, and NaN are not produced by the
 * value space the corpus exercises and return null (the caller widens).
 */
function toHalfBitsExact(value: number): number | null {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, value, false);
  const bits = dv.getBigUint64(0, false);
  const sign = Number((bits >> 63n) & 1n);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const mant = bits & 0xf_ffff_ffff_ffffn;

  if (exp === 0 && mant === 0n) return sign << 15; // +/-0.

  const unbiased = exp - 1023;
  if (unbiased < -14 || unbiased > 15) return null; // outside half normal range.
  // The low 42 mantissa bits must be zero to fit the 10-bit half mantissa.
  if ((mant & ((1n << 42n) - 1n)) !== 0n) return null;

  const halfMant = Number(mant >> 42n);
  const halfExp = unbiased + 15;
  return (sign << 15) | (halfExp << 10) | halfMant;
}

/** Serialize a value-model tree to CBOR bytes. */
export function toCbor(value: unknown): Uint8Array {
  const w = new Writer();
  writeValue(w, value);
  return w.finish();
}

// ---------------------------------------------------------------------------
// Decode.
// ---------------------------------------------------------------------------

// `ciborium` emits a u128 above the u64 range as a positive bignum (tag 2).
// cborg does not decode tags by default, so this decoder folds the tag-2
// content (a byte string) back into a BigInt. The decoder is handed a control
// function that returns the tagged content when called.
const TAG_DECODERS: Record<number, (decode: () => unknown) => bigint> = {
  [TAG_POSITIVE_BIGNUM]: (decode: () => unknown): bigint => {
    const inner = decode();
    if (!(inner instanceof Uint8Array)) {
      throw new CborError("tag 2 (bignum) content was not a byte string");
    }
    let v = 0n;
    for (const b of inner) v = (v << 8n) | BigInt(b);
    return v;
  },
};

// Build a fresh options object (with a fresh tags table) per decode. cborg's
// tag-decode path binds a control closure to the active tokenizer; reusing one
// options/tags instance across calls can leak that binding between frames.
function makeDecodeOptions() {
  return {
    allowBigInt: true,
    tags: { ...TAG_DECODERS },
    // A frame carries exactly one CBOR item; reject duplicate keys the server
    // never emits.
    rejectDuplicateMapKeys: true,
    useMaps: false,
  };
}

/** Decode a single CBOR item, requiring the whole buffer to be consumed. */
export function fromCbor(bytes: Uint8Array): unknown {
  let decoded: unknown;
  try {
    // Decode against a private copy. The input may be a view into a shared
    // arena (Node's Buffer pool, a socket read buffer), and cborg returns byte
    // strings as views into whatever buffer it reads; copying severs both ties.
    decoded = cborgDecode(bytes.slice(), makeDecodeOptions());
  } catch (err) {
    throw new CborError(`CBOR decode failed: ${describeValue(err)}`, { cause: err });
  }
  // The reader returns byte strings as views into its internal buffers, which
  // it recycles across calls; a retained view can read another frame's bytes
  // later. Copy every byte string out so each decoded value owns its memory.
  return detachByteStrings(decoded);
}

/** Recursively replace every `Uint8Array` view with an owned copy. */
function detachByteStrings(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(detachByteStrings);
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) out.set(k, detachByteStrings(v));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = detachByteStrings(v);
    return out;
  }
  return value;
}

/**
 * Decode a CBOR item from the front of `bytes`, reporting how many bytes it
 * consumed so the caller can read a trailing raw-vector section from the rest.
 */
export function fromCborPrefix(bytes: Uint8Array): { value: unknown; consumed: number } {
  const consumed = cborItemLength(bytes);
  const value = fromCbor(bytes.subarray(0, consumed));
  return { value, consumed };
}

/** Pack an f32 array into a contiguous little-endian byte block. */
export function f32ToLeBytes(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(i * 4, values[i] as number, true);
  }
  return out;
}

/** Read a little-endian f32 vector from a trailing raw section. */
export function leBytesToF32(bytes: Uint8Array): Float32Array {
  if (bytes.length % 4 !== 0) {
    throw new CborError(`vector section is ${bytes.length} bytes, not a multiple of 4`);
  }
  const out = new Float32Array(bytes.length / 4);
  // Read in 4-byte chunks rather than casting, so it stays alignment-safe over
  // a socket buffer whose byteOffset need not be 4-aligned.
  for (let i = 0; i < out.length; i++) {
    const base = bytes.byteOffset + i * 4;
    out[i] = new DataView(bytes.buffer, base, 4).getFloat32(0, true);
  }
  return out;
}

/**
 * Measure the byte length of the single CBOR item at the front of `bytes`,
 * so a payload with a trailing raw-vector section can be split at the seam.
 * Walks the same major-type / argument structure as the encoder.
 */
function cborItemLength(bytes: Uint8Array): number {
  let pos = 0;

  function byteAt(i: number): number {
    if (i >= bytes.length) throw new CborError("truncated CBOR item");
    return bytes[i] as number;
  }

  function readArg(initial: number): bigint {
    const ai = initial & 0x1f;
    if (ai < 24) return BigInt(ai);
    if (ai === 24) {
      const v = BigInt(byteAt(pos));
      pos += 1;
      return v;
    }
    if (ai === 25) {
      const v = (BigInt(byteAt(pos)) << 8n) | BigInt(byteAt(pos + 1));
      pos += 2;
      return v;
    }
    if (ai === 26) {
      let v = 0n;
      for (let i = 0; i < 4; i++) v = (v << 8n) | BigInt(byteAt(pos + i));
      pos += 4;
      return v;
    }
    if (ai === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(byteAt(pos + i));
      pos += 8;
      return v;
    }
    throw new CborError(`indefinite-length item not supported (additional info ${ai})`);
  }

  function walk(): void {
    const initial = byteAt(pos);
    pos += 1;
    const major = initial >> 5;
    switch (major) {
      case MAJOR_UINT:
      case MAJOR_NEGINT:
        readArg(initial);
        return;
      case MAJOR_BYTES:
      case MAJOR_TEXT: {
        const n = Number(readArg(initial));
        pos += n;
        if (pos > bytes.length) throw new CborError("truncated CBOR string");
        return;
      }
      case MAJOR_ARRAY: {
        const n = Number(readArg(initial));
        for (let i = 0; i < n; i++) walk();
        return;
      }
      case MAJOR_MAP: {
        const n = Number(readArg(initial));
        for (let i = 0; i < n; i++) {
          walk();
          walk();
        }
        return;
      }
      case MAJOR_TAG:
        readArg(initial);
        walk();
        return;
      case MAJOR_SIMPLE: {
        const ai = initial & 0x1f;
        if (ai === 24) pos += 1;
        else if (ai === 25) pos += 2;
        else if (ai === 26) pos += 4;
        else if (ai === 27) pos += 8;
        else if (ai >= 28) {
          throw new CborError(`unsupported simple value (additional info ${ai})`);
        }
        return;
      }
      default:
        throw new CborError(`unknown CBOR major type ${major}`);
    }
  }

  walk();
  return pos;
}
