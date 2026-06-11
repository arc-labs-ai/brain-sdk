/**
 * Conformance corpus: the cross-language wire drift guard.
 *
 * For each vendored case the test decodes the golden `.bin`, re-encodes the
 * typed value, and asserts the bytes match. The re-encode == bytes assertion is
 * the load-bearing check: it proves the TS codec puts identical bytes on the
 * wire as the Rust SDK and the server. The cases are driven from `index.json`
 * so a corpus addition that lacks a TS handler surfaces as a failure rather
 * than being silently skipped.
 *
 * `frame_*` cases carry a full 32-byte BRN0 header + payload; all other cases
 * are payload-only (CBOR map + any trailing raw-vector section).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeFrame, encodeFrame, crc32c } from "../src/wire/frame.js";
import * as t from "../src/wire/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "..", "conformance", "corpus");

interface IndexEntry {
  name: string;
  opcode: string;
  kind: "request" | "response" | "frame";
  payload_len: number;
}

const corpusIndex: IndexEntry[] = JSON.parse(
  readFileSync(join(corpusDir, "index.json"), "utf8"),
);

function readBin(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(corpusDir, `${name}.bin`)));
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, name: string): void {
  expect(toHex(actual), `re-encode mismatch for ${name}`).toBe(toHex(expected));
}

type Handler = (bytes: Uint8Array) => Uint8Array;

/** Decode a payload golden and re-encode it, returning the produced bytes. */
function payloadRoundTrip<T>(
  decode: (b: Uint8Array) => T,
  encode: (v: T) => Uint8Array,
): Handler {
  return (bytes) => encode(decode(bytes));
}

/** Decode a full frame and re-encode it from its parts. */
function frameRoundTrip(bytes: Uint8Array): Uint8Array {
  const { frame, rest } = decodeFrame(bytes);
  if (rest.length !== 0) throw new Error("frame had trailing bytes");
  return encodeFrame(frame.opcode, frame.streamId, frame.flags, frame.payload);
}

// Every corpus case mapped to its round-trip handler. `frame_*` cases use the
// frame codec; payload cases use the typed payload codec.
const handlers: Record<string, Handler> = {
  frame_hello: frameRoundTrip,
  frame_welcome: frameRoundTrip,
  frame_encode: frameRoundTrip,
  frame_encode_vector_direct: frameRoundTrip,
  frame_error: frameRoundTrip,
  frame_recall_eos: frameRoundTrip,

  req_hello: payloadRoundTrip(t.decodeHello, t.encodeHello),
  resp_welcome: payloadRoundTrip(t.decodeWelcome, t.encodeWelcome),
  req_auth: payloadRoundTrip(t.decodeAuth, t.encodeAuth),
  resp_auth_ok: payloadRoundTrip(t.decodeAuthOk, t.encodeAuthOk),

  req_encode: payloadRoundTrip(t.decodeEncode, t.encodeEncode),
  resp_encode: payloadRoundTrip(t.decodeEncodeResponse, t.encodeEncodeResponse),
  req_encode_vector_direct: payloadRoundTrip(
    t.decodeEncodeVectorDirect,
    t.encodeEncodeVectorDirect,
  ),

  req_recall: payloadRoundTrip(t.decodeRecall, t.encodeRecall),
  resp_recall: payloadRoundTrip(t.decodeRecallResponse, t.encodeRecallResponse),

  req_forget: payloadRoundTrip(t.decodeForget, t.encodeForget),
  resp_forget: payloadRoundTrip(t.decodeForgetResponse, t.encodeForgetResponse),

  req_entity_create: payloadRoundTrip(t.decodeEntityCreate, t.encodeEntityCreate),
  resp_entity_create: payloadRoundTrip(
    t.decodeEntityCreateResponse,
    t.encodeEntityCreateResponse,
  ),

  req_statement_create: payloadRoundTrip(t.decodeStatementCreate, t.encodeStatementCreate),
  resp_statement_create: payloadRoundTrip(
    t.decodeStatementCreateResponse,
    t.encodeStatementCreateResponse,
  ),

  req_relation_create: payloadRoundTrip(t.decodeRelationCreate, t.encodeRelationCreate),
  resp_relation_create: payloadRoundTrip(
    t.decodeRelationCreateResponse,
    t.encodeRelationCreateResponse,
  ),

  req_schema_upload: payloadRoundTrip(t.decodeSchemaUpload, t.encodeSchemaUpload),
  resp_schema_upload: payloadRoundTrip(
    t.decodeSchemaUploadResponse,
    t.encodeSchemaUploadResponse,
  ),

  req_query: payloadRoundTrip(t.decodeQuery, t.encodeQuery),
  resp_query: payloadRoundTrip(t.decodeQueryResponse, t.encodeQueryResponse),

  req_materialize_procedural: payloadRoundTrip(
    t.decodeMaterializeProcedural,
    t.encodeMaterializeProcedural,
  ),
  resp_materialize_procedural: payloadRoundTrip(
    t.decodeMaterializeProceduralResponse,
    t.encodeMaterializeProceduralResponse,
  ),

  resp_entity_get: payloadRoundTrip(t.decodeEntityGetResponse, t.encodeEntityGetResponse),
  resp_entity_list: payloadRoundTrip(
    t.decodeEntityListResponse,
    t.encodeEntityListResponse,
  ),
  resp_entity_resolve: payloadRoundTrip(
    t.decodeEntityResolveResponse,
    t.encodeEntityResolveResponse,
  ),
  resp_statement_get: payloadRoundTrip(
    t.decodeStatementGetResponse,
    t.encodeStatementGetResponse,
  ),
  resp_statement_list: payloadRoundTrip(
    t.decodeStatementListResponse,
    t.encodeStatementListResponse,
  ),
  resp_relation_list: payloadRoundTrip(
    t.decodeRelationListFromResponse,
    t.encodeRelationListFromResponse,
  ),

  resp_plan: payloadRoundTrip(t.decodePlanResponse, t.encodePlanResponse),
  resp_reason: payloadRoundTrip(t.decodeReasonResponse, t.encodeReasonResponse),
  resp_link: payloadRoundTrip(t.decodeLinkResponse, t.encodeLinkResponse),

  resp_txn_begin: payloadRoundTrip(t.decodeTxnBeginResponse, t.encodeTxnBeginResponse),
  resp_txn_commit: payloadRoundTrip(t.decodeTxnCommitResponse, t.encodeTxnCommitResponse),
  resp_txn_abort: payloadRoundTrip(t.decodeTxnAbortResponse, t.encodeTxnAbortResponse),

  resp_get_capabilities: payloadRoundTrip(
    t.decodeGetCapabilitiesResponse,
    t.encodeGetCapabilitiesResponse,
  ),
  resp_subscribe_event: payloadRoundTrip(
    t.decodeSubscriptionEvent,
    t.encodeSubscriptionEvent,
  ),

  resp_pong: payloadRoundTrip(t.decodePong, t.encodePong),
  resp_server_ping: payloadRoundTrip(t.decodeServerPing, t.encodeServerPing),

  resp_error_protocol: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_authentication: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_authorization: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_validation: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_not_found: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_conflict: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_resource_exhausted: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_internal: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_unavailable: payloadRoundTrip(t.decodeError, t.encodeError),
};

it("crc32c check vector pins the polynomial choice", () => {
  expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
});

it("every corpus case has a TS handler", () => {
  const missing = corpusIndex.map((e) => e.name).filter((n) => !(n in handlers));
  expect(missing, `corpus cases without a handler: ${missing.join(", ")}`).toEqual([]);
});

describe("re-encode == golden bytes (all corpus cases)", () => {
  for (const entry of corpusIndex) {
    it(`${entry.name} (${entry.kind})`, () => {
      const bytes = readBin(entry.name);
      const handler = handlers[entry.name];
      expect(handler, `no handler for ${entry.name}`).toBeDefined();
      const re = handler!(bytes);
      expectBytesEqual(re, bytes, entry.name);
    });
  }
});
