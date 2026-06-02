/**
 * CRC32C (Castagnoli, polynomial 0x1EDC6F41) over a byte slice.
 *
 * Brain checksums every frame header and payload with CRC32C, the same variant
 * hardware accelerates via SSE4.2 `crc32` — picked for its strong error
 * detection and ubiquitous acceleration. The SDK computes it in software so the
 * codec carries no native dependency for a core checksum; the loop is the
 * standard reflected table-driven form.
 *
 * The reflected algorithm processes each byte low-bit-first against a 256-entry
 * table seeded from the reflected polynomial 0x82F63B78, starting and ending
 * with a bitwise inversion (the conventional 0xFFFFFFFF init / final-xor). The
 * check vector `crc32c("123456789") == 0xe3069283` pins this choice.
 */

const POLYNOMIAL_REFLECTED = 0x82f63b78;

// Precompute the byte-wise remainder table once at module load.
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? POLYNOMIAL_REFLECTED ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Compute the CRC32C of `bytes`, returned as an unsigned 32-bit integer. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
