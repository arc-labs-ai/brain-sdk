/**
 * Wire protocol: BRN0 framing and CBOR payload codec.
 *
 * All multi-byte header fields are **big-endian**. Payloads are CBOR with a
 * fixed per-opcode field order (reproducible-deterministic, not bytewise
 * key-sort).
 *
 * Cross-language gotchas this codec MUST honor (how Brain's corpus encodes
 * values, and where naive TS ports go wrong):
 *
 * - IDs / `[u8; N]` / UUIDs are CBOR **byte strings** (major type 2) ->
 *   `Uint8Array`. NOT number[] arrays, NOT hex strings, NOT hyphenated-UUID
 *   text. (Pick a CBOR lib that distinguishes byte strings from arrays — e.g.
 *   `cbor-x` with `useRecords:false` / tagged Uint8Array, or `cborg`.)
 * - Enums (memory `kind`, `ForgetMode`, `AuthMethod`) are **integers**.
 * - f32 fields round-trip through 32-bit floats (`Math.fround`), not JS's
 *   native 64-bit numbers.
 *
 * The conformance corpus is the drift guard: every `frame_*` golden must
 * re-encode byte-for-byte and decode back to its header fields.
 */

import { crc32c } from "./crc32c.js";

export { crc32c };

// ---- Header layout (32 bytes, fixed, big-endian) ---------------------------

export const HEADER_LEN = 32 as const;
/** Frame magic / start sentinel: ASCII "BRN0". */
export const MAGIC: Uint8Array = new Uint8Array([0x42, 0x52, 0x4e, 0x30]);
export const VERSION = 1 as const;
export const MAX_PAYLOAD_LEN = (1 << 24) - 1;

// Field offsets into the 32-byte header.
export const OFF_MAGIC = 0; // bytes 0..4
export const OFF_VERSION = 4; // byte 4
export const OFF_OPCODE = 5; // bytes 5..7  (u16 BE)
export const OFF_FLAGS = 7; // byte 7
export const OFF_HEADER_CRC = 8; // bytes 8..12 (u32 BE)
export const OFF_STREAM_ID = 12; // bytes 12..16 (u32 BE)
export const OFF_PAYLOAD_LEN = 16; // bytes 16..19 (u24 BE)
export const OFF_RESERVED_A = 19; // byte 19 (MUST be zero)
export const OFF_PAYLOAD_CRC = 20; // bytes 20..24 (u32 BE)
export const OFF_RESERVED_B = 24; // bytes 24..32 (MUST be zero)

// ---- Frame flags -----------------------------------------------------------

export const FLAG_EOS = 0x80; // end-of-stream: last frame for this streamId
export const FLAG_MPL = 0x40; // multi-payload: more frames follow in this message
export const FLAG_CMP = 0x20; // compressed payload (zstd)
export const FLAGS_RESERVED_MASK = 0x1f; // low five bits reserved; MUST be zero

// The header CRC is computed over header bytes 0..8 ++ 12..32 (its own four
// bytes at 8..12 are excluded). The payload CRC is over the payload bytes and
// MUST be zero when the payload is empty. Both are CRC32C (Castagnoli).

/** Flag bits that are defined; any other bit set on the wire is rejected. */
export const FLAGS_DEFINED_MASK = FLAG_EOS | FLAG_MPL | FLAG_CMP;

/** A decoded BRN0 frame. */
export interface Frame {
  opcode: number;
  streamId: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * Failures decoding a frame off the wire. A mismatch is fail-stop for the
 * connection: a corrupt frame desynchronizes the byte stream, so the caller
 * cannot safely resume from the next byte.
 */
export type FrameErrorKind =
  | "BadMagic"
  | "BadVersion"
  | "BadHeaderCrc"
  | "BadPayloadCrc"
  | "OversizePayload"
  | "ReservedNonZero"
  | "Truncated";

export class FrameError extends Error {
  constructor(
    public readonly kind: FrameErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

// The header CRC covers the header bytes that exclude the CRC field itself:
// bytes 0..8 concatenated with 12..32. Encode and decode agree on the covered
// range by holding the 4-byte CRC slot at zero while computing it.
function computeHeaderCrc(header: Uint8Array): number {
  const buf = new Uint8Array(HEADER_LEN - 4);
  buf.set(header.subarray(0, OFF_HEADER_CRC), 0);
  buf.set(header.subarray(OFF_STREAM_ID, HEADER_LEN), OFF_HEADER_CRC);
  return crc32c(buf);
}

function writeU32Be(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function readU32Be(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

/**
 * Encode a complete BRN0 frame (header ++ payload).
 *
 * Recomputes payloadLen, payloadCrc32c and headerCrc32c, then returns the
 * 32-byte header followed by the payload bytes. An empty payload carries a zero
 * payload CRC, which `crc32c` of an empty slice already produces.
 */
export function encodeFrame(
  opcode: number,
  streamId: number,
  flags: number,
  payload: Uint8Array,
): Uint8Array {
  if (payload.length > MAX_PAYLOAD_LEN) {
    throw new FrameError(
      "OversizePayload",
      `payload length ${payload.length} exceeds 24-bit max ${MAX_PAYLOAD_LEN}`,
    );
  }

  const out = new Uint8Array(HEADER_LEN + payload.length);
  out.set(MAGIC, OFF_MAGIC);
  out[OFF_VERSION] = VERSION;
  out[OFF_OPCODE] = (opcode >>> 8) & 0xff;
  out[OFF_OPCODE + 1] = opcode & 0xff;
  out[OFF_FLAGS] = flags & 0xff;
  // header_crc32c (8..12) stays zero until computed below.
  writeU32Be(out, OFF_STREAM_ID, streamId >>> 0);
  // payload_len is a u24: write the low three bytes of a big-endian u32.
  out[OFF_PAYLOAD_LEN] = (payload.length >>> 16) & 0xff;
  out[OFF_PAYLOAD_LEN + 1] = (payload.length >>> 8) & 0xff;
  out[OFF_PAYLOAD_LEN + 2] = payload.length & 0xff;
  // reserved_a (19) and reserved_b (24..32) stay zero.
  writeU32Be(out, OFF_PAYLOAD_CRC, crc32c(payload));

  const headerCrc = computeHeaderCrc(out.subarray(0, HEADER_LEN));
  writeU32Be(out, OFF_HEADER_CRC, headerCrc);

  out.set(payload, HEADER_LEN);
  return out;
}

/**
 * Decode one BRN0 frame from the front of `buf`, returning the frame and the
 * unconsumed tail (so callers can loop over a stream of frames).
 *
 * Verifies magic, version, both CRC32Cs and the reserved bits. The max-payload
 * check happens before the payload is read, so a hostile length field cannot
 * drive a large allocation.
 */
export function decodeFrame(buf: Uint8Array): { frame: Frame; rest: Uint8Array } {
  if (buf.length < HEADER_LEN) {
    throw new FrameError(
      "Truncated",
      `truncated frame: have ${buf.length} bytes, need ${HEADER_LEN}`,
    );
  }

  const header = buf.subarray(0, HEADER_LEN);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[OFF_MAGIC + i] !== MAGIC[i]) {
      throw new FrameError("BadMagic", "bad frame magic");
    }
  }
  if (header[OFF_VERSION] !== VERSION) {
    throw new FrameError(
      "BadVersion",
      `unsupported wire version: got ${header[OFF_VERSION]}, expected ${VERSION}`,
    );
  }

  // reserved_a and the eight reserved_b bytes must all be zero.
  if (header[OFF_RESERVED_A] !== 0) {
    throw new FrameError("ReservedNonZero", "reserved field was non-zero");
  }
  for (let i = OFF_RESERVED_B; i < HEADER_LEN; i++) {
    if (header[i] !== 0) {
      throw new FrameError("ReservedNonZero", "reserved field was non-zero");
    }
  }

  const flags = header[OFF_FLAGS]!;
  if ((flags & ~FLAGS_DEFINED_MASK) !== 0) {
    throw new FrameError("ReservedNonZero", "reserved flag bit was non-zero");
  }

  const storedHeaderCrc = readU32Be(header, OFF_HEADER_CRC);
  if (storedHeaderCrc !== computeHeaderCrc(header)) {
    throw new FrameError("BadHeaderCrc", "header CRC mismatch");
  }

  const payloadLen =
    (header[OFF_PAYLOAD_LEN]! << 16) |
    (header[OFF_PAYLOAD_LEN + 1]! << 8) |
    header[OFF_PAYLOAD_LEN + 2]!;
  // Reject an over-long claim before slicing any payload buffer.
  if (payloadLen > MAX_PAYLOAD_LEN) {
    throw new FrameError(
      "OversizePayload",
      `payload length ${payloadLen} exceeds maximum ${MAX_PAYLOAD_LEN}`,
    );
  }

  const need = HEADER_LEN + payloadLen;
  if (buf.length < need) {
    throw new FrameError("Truncated", `truncated frame: have ${buf.length} bytes, need ${need}`);
  }

  const payload = buf.slice(HEADER_LEN, need);
  const storedPayloadCrc = readU32Be(header, OFF_PAYLOAD_CRC);
  if (storedPayloadCrc !== crc32c(payload)) {
    throw new FrameError("BadPayloadCrc", "payload CRC mismatch");
  }

  const frame: Frame = {
    opcode: ((header[OFF_OPCODE]! << 8) | header[OFF_OPCODE + 1]!) >>> 0,
    streamId: readU32Be(header, OFF_STREAM_ID),
    flags,
    payload,
  };
  return { frame, rest: buf.slice(need) };
}
