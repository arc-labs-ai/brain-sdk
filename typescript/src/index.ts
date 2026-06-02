/**
 * @brain-db/sdk — hand-written TypeScript client for the Brain memory database.
 *
 * Speaks Brain's BRN0 wire protocol (32-byte frame header + CBOR payload +
 * optional trailing little-endian f32 vector section) directly. No dependency
 * on Brain's internal code; the wire protocol is the only contract.
 *
 * This entry point exposes the wire layer: the frame codec, the CBOR payload
 * codec, opcodes, and the typed payload structs for the handshake, the v1
 * verbs, and the typed-graph ops. The connection layer and the
 * ENCODE / RECALL / FORGET client verbs arrive in later phases.
 */

export * from "./wire/frame.js";
export * from "./wire/opcode.js";
export * from "./wire/cbor.js";
export * from "./wire/types.js";

/** This SDK package's release version. */
export const SDK_VERSION = "0.0.0";
