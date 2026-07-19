/**
 * @brain-db/sdk — hand-written TypeScript client for the Brain memory database.
 *
 * Speaks Brain's BRN0 wire protocol (32-byte frame header + CBOR payload +
 * optional trailing little-endian f32 vector section) directly. No dependency
 * on Brain's internal code; the wire protocol is the only contract.
 *
 * Public surface: the high-level {@link BrainClient} (every verb — encode /
 * recall / forget, typed-graph create + read, schema, link / unlink, plan /
 * reason, txn, subscribe), the multiplexed {@link MuxConnection} and
 * {@link Subscription}, the connection {@link Pool}, the retry combinator,
 * request builders, the error taxonomy, and the wire layer (frame codec, CBOR
 * codec, opcodes, typed payload structs).
 */

// Wire layer.
export * from "./wire/frame.js";
export * from "./wire/opcode.js";
export * from "./wire/cbor.js";
export * from "./wire/types.js";

// Client + transport layers.
export { BrainClient, newId } from "./client.js";
export type { Auth, ClientConfig, SessionInfo } from "./client.js";
export { MuxConnection, Subscription } from "./mux.js";
export type { HandshakeOutcome } from "./connection.js";
export { Pool } from "./pool.js";
export { DEFAULT_RETRY_POLICY, NO_RETRY, backoffMs } from "./retry.js";
export type { RetryPolicy } from "./retry.js";
export { EncodeBuilder, ForgetBuilder, RecallBuilder } from "./verbs.js";
export {
  BrainError,
  BrainTimeout,
  ConnectionClosed,
  ProtocolError,
  ServerError,
  VersionMismatch,
  isRetryable,
  isActAsDenied,
} from "./errors.js";

// HTTP tier — the hosted-edge client (talks to `brain-edge` / the Arc gateway).
// The contract types are namespaced under `http` to avoid colliding with the
// wire types (`PlanStep`, `Capabilities`, …) exported above.
export { BrainHttpClient, BrainHttpError, DEFAULT_HTTP_RETRY, NO_HTTP_RETRY } from "./http/index.js";
export type { BrainHttpClientOptions, HttpRetryPolicy } from "./http/client.js";
export * as http from "./http/types.js";

/** This SDK package's release version. */
export const SDK_VERSION = "0.1.0";
