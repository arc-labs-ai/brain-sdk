/**
 * The corpus codec table — shared by the two suites that read the golden corpus.
 *
 * `conformance.test.ts` proves the bytes; `field-names.test.ts` proves the
 * decoded values land in the right properties. They must cover exactly the same
 * case set or one of them silently stops guarding, so the table lives here
 * rather than in either test file.
 *
 * A payload case carries its decoder and encoder separately, not a fused
 * round-trip closure: the field-name suite needs the decoder alone.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeFrame, encodeFrame } from "../src/wire/frame.js";
import * as t from "../src/wire/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const corpusDir = join(here, "..", "..", "conformance", "corpus");

export interface IndexEntry {
  name: string;
  opcode: string;
  kind: "request" | "response" | "frame";
  payload_len: number;
}

export const corpusIndex: IndexEntry[] = JSON.parse(
  readFileSync(join(corpusDir, "index.json"), "utf8"),
);

export function readBin(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(corpusDir, `${name}.bin`)));
}

/** The raw `.json` mirror text, unparsed — callers that care about integer
 *  precision (u64/u128 ids exceed Number.MAX_SAFE_INTEGER) must pre-process it
 *  before `JSON.parse` sees it. */
export function readJsonText(name: string): string {
  return readFileSync(join(corpusDir, `${name}.json`), "utf8");
}

/** A payload case: decoder and encoder kept separate so either can be used alone. */
export interface PayloadCodec {
  decode: (b: Uint8Array) => unknown;
  encode: (v: never) => Uint8Array;
}

/** A full-frame case — header + payload, round-tripped through the frame codec. */
export const FRAME_CASE = "frame" as const;

export type Codec = PayloadCodec | typeof FRAME_CASE;

function payloadRoundTrip<T>(
  decode: (b: Uint8Array) => T,
  encode: (v: T) => Uint8Array,
): PayloadCodec {
  return { decode, encode } as PayloadCodec;
}

const frameRoundTrip = FRAME_CASE;

/** Re-encode a case's bytes from its own decoded form. */
export function reencode(codec: Codec, bytes: Uint8Array): Uint8Array {
  if (codec === FRAME_CASE) {
    const { frame, rest } = decodeFrame(bytes);
    if (rest.length !== 0) throw new Error("frame had trailing bytes");
    return encodeFrame(frame.opcode, frame.streamId, frame.flags, frame.payload);
  }
  return codec.encode(codec.decode(bytes) as never);
}

export const codecs: Record<string, Codec> = {
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
  resp_auth_ok_act_as: payloadRoundTrip(t.decodeAuthOk, t.encodeAuthOk),

  req_encode: payloadRoundTrip(t.decodeEncode, t.encodeEncode),
  req_encode_act_as: payloadRoundTrip(t.decodeEncode, t.encodeEncode),
  req_encode_trace: payloadRoundTrip(t.decodeEncode, t.encodeEncode),
  req_encode_allow_duplicates: payloadRoundTrip(t.decodeEncode, t.encodeEncode),
  resp_encode: payloadRoundTrip(t.decodeEncodeResponse, t.encodeEncodeResponse),
  resp_encode_trace: payloadRoundTrip(t.decodeEncodeResponse, t.encodeEncodeResponse),
  req_encode_vector_direct: payloadRoundTrip(
    t.decodeEncodeVectorDirect,
    t.encodeEncodeVectorDirect,
  ),

  req_recall: payloadRoundTrip(t.decodeRecall, t.encodeRecall),
  req_recall_act_as: payloadRoundTrip(t.decodeRecall, t.encodeRecall),
  resp_recall: payloadRoundTrip(t.decodeRecallResponse, t.encodeRecallResponse),
  resp_recall_trace: payloadRoundTrip(t.decodeRecallResponse, t.encodeRecallResponse),

  req_memory_list: payloadRoundTrip(t.decodeMemoryList, t.encodeMemoryList),
  resp_memory_list: payloadRoundTrip(
    t.decodeMemoryListResponse,
    t.encodeMemoryListResponse,
  ),

  req_memory_inspect: payloadRoundTrip(t.decodeMemoryInspect, t.encodeMemoryInspect),
  resp_memory_inspect: payloadRoundTrip(
    t.decodeMemoryInspectResponse,
    t.encodeMemoryInspectResponse,
  ),

  req_graph_fetch: payloadRoundTrip(t.decodeGraphFetch, t.encodeGraphFetch),
  resp_graph_fetch: payloadRoundTrip(
    t.decodeGraphFetchResponse,
    t.encodeGraphFetchResponse,
  ),

  req_forget: payloadRoundTrip(t.decodeForget, t.encodeForget),
  req_forget_act_as: payloadRoundTrip(t.decodeForget, t.encodeForget),
  resp_forget: payloadRoundTrip(t.decodeForgetResponse, t.encodeForgetResponse),

  req_entity_create: payloadRoundTrip(t.decodeEntityCreate, t.encodeEntityCreate),
  req_entity_create_act_as: payloadRoundTrip(t.decodeEntityCreate, t.encodeEntityCreate),
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

  req_materialize_procedural: payloadRoundTrip(
    t.decodeMaterializeProcedural,
    t.encodeMaterializeProcedural,
  ),

  req_space_create: payloadRoundTrip(t.decodeSpaceCreate, t.encodeSpaceCreate),
  resp_space_create: payloadRoundTrip(
    t.decodeSpaceCreateResponse,
    t.encodeSpaceCreateResponse,
  ),
  req_space_list: payloadRoundTrip(t.decodeSpaceList, t.encodeSpaceList),
  resp_space_list: payloadRoundTrip(t.decodeSpaceListResponse, t.encodeSpaceListResponse),
  req_space_delete: payloadRoundTrip(t.decodeSpaceDelete, t.encodeSpaceDelete),
  resp_space_delete: payloadRoundTrip(
    t.decodeSpaceDeleteResponse,
    t.encodeSpaceDeleteResponse,
  ),

  req_session_create: payloadRoundTrip(t.decodeSessionCreate, t.encodeSessionCreate),
  resp_session_create: payloadRoundTrip(
    t.decodeSessionCreateResponse,
    t.encodeSessionCreateResponse,
  ),
  req_session_list: payloadRoundTrip(t.decodeSessionList, t.encodeSessionList),
  resp_session_list: payloadRoundTrip(
    t.decodeSessionListResponse,
    t.encodeSessionListResponse,
  ),
  req_session_delete: payloadRoundTrip(t.decodeSessionDelete, t.encodeSessionDelete),
  resp_session_delete: payloadRoundTrip(
    t.decodeSessionDeleteResponse,
    t.encodeSessionDeleteResponse,
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

  req_plan_act_as: payloadRoundTrip(t.decodePlan, t.encodePlan),
  resp_plan: payloadRoundTrip(t.decodePlanResponse, t.encodePlanResponse),
  resp_plan_trace: payloadRoundTrip(t.decodePlanResponse, t.encodePlanResponse),
  req_reason_act_as: payloadRoundTrip(t.decodeReason, t.encodeReason),
  resp_reason: payloadRoundTrip(t.decodeReasonResponse, t.encodeReasonResponse),
  resp_reason_trace: payloadRoundTrip(t.decodeReasonResponse, t.encodeReasonResponse),
  resp_link: payloadRoundTrip(t.decodeLinkResponse, t.encodeLinkResponse),

  resp_txn_begin: payloadRoundTrip(t.decodeTxnBeginResponse, t.encodeTxnBeginResponse),
  resp_txn_commit: payloadRoundTrip(t.decodeTxnCommitResponse, t.encodeTxnCommitResponse),
  resp_txn_abort: payloadRoundTrip(t.decodeTxnAbortResponse, t.encodeTxnAbortResponse),

  resp_get_capabilities: payloadRoundTrip(
    t.decodeGetCapabilitiesResponse,
    t.encodeGetCapabilitiesResponse,
  ),
  req_extractor_list: payloadRoundTrip(t.decodeExtractorList, t.encodeExtractorList),

  req_entity_get: payloadRoundTrip(t.decodeEntityGet, t.encodeEntityGet),
  req_entity_update: payloadRoundTrip(t.decodeEntityUpdate, t.encodeEntityUpdate),
  req_entity_rename: payloadRoundTrip(t.decodeEntityRename, t.encodeEntityRename),
  req_entity_merge: payloadRoundTrip(t.decodeEntityMerge, t.encodeEntityMerge),
  req_entity_unmerge: payloadRoundTrip(t.decodeEntityUnmerge, t.encodeEntityUnmerge),
  req_entity_resolve: payloadRoundTrip(t.decodeEntityResolve, t.encodeEntityResolve),
  req_entity_list: payloadRoundTrip(t.decodeEntityList, t.encodeEntityList),
  req_entity_tombstone: payloadRoundTrip(t.decodeEntityTombstone, t.encodeEntityTombstone),
  resp_entity_update: payloadRoundTrip(t.decodeEntityUpdateResponse, t.encodeEntityUpdateResponse),
  resp_entity_rename: payloadRoundTrip(t.decodeEntityRenameResponse, t.encodeEntityRenameResponse),
  resp_entity_merge: payloadRoundTrip(t.decodeEntityMergeResponse, t.encodeEntityMergeResponse),
  resp_entity_unmerge: payloadRoundTrip(t.decodeEntityUnmergeResponse, t.encodeEntityUnmergeResponse),
  resp_entity_tombstone: payloadRoundTrip(t.decodeEntityTombstoneResponse, t.encodeEntityTombstoneResponse),
  resp_entity_get_merged: payloadRoundTrip(t.decodeEntityGetResponse, t.encodeEntityGetResponse),
  req_relation_get: payloadRoundTrip(t.decodeRelationGet, t.encodeRelationGet),
  req_relation_supersede: payloadRoundTrip(t.decodeRelationSupersede, t.encodeRelationSupersede),
  req_relation_tombstone: payloadRoundTrip(t.decodeRelationTombstone, t.encodeRelationTombstone),
  req_relation_list_from: payloadRoundTrip(t.decodeRelationListFrom, t.encodeRelationListFrom),
  req_relation_list_to: payloadRoundTrip(t.decodeRelationListTo, t.encodeRelationListTo),
  req_relation_traverse: payloadRoundTrip(t.decodeRelationTraverse, t.encodeRelationTraverse),
  resp_relation_get: payloadRoundTrip(t.decodeRelationGetResponse, t.encodeRelationGetResponse),
  resp_relation_supersede: payloadRoundTrip(t.decodeRelationSupersedeResponse, t.encodeRelationSupersedeResponse),
  resp_relation_tombstone: payloadRoundTrip(t.decodeRelationTombstoneResponse, t.encodeRelationTombstoneResponse),
  resp_relation_list_to: payloadRoundTrip(t.decodeRelationListToResponse, t.encodeRelationListToResponse),
  resp_relation_traverse: payloadRoundTrip(t.decodeRelationTraverseResponse, t.encodeRelationTraverseResponse),
  req_statement_get: payloadRoundTrip(t.decodeStatementGet, t.encodeStatementGet),
  req_statement_supersede: payloadRoundTrip(t.decodeStatementSupersede, t.encodeStatementSupersede),
  req_statement_tombstone: payloadRoundTrip(t.decodeStatementTombstone, t.encodeStatementTombstone),
  req_statement_retract: payloadRoundTrip(t.decodeStatementRetract, t.encodeStatementRetract),
  req_statement_history: payloadRoundTrip(t.decodeStatementHistory, t.encodeStatementHistory),
  req_statement_list: payloadRoundTrip(t.decodeStatementList, t.encodeStatementList),
  resp_statement_supersede: payloadRoundTrip(t.decodeStatementSupersedeResponse, t.encodeStatementSupersedeResponse),
  resp_statement_tombstone: payloadRoundTrip(t.decodeStatementTombstoneResponse, t.encodeStatementTombstoneResponse),
  resp_statement_retract: payloadRoundTrip(t.decodeStatementRetractResponse, t.encodeStatementRetractResponse),
  resp_statement_history: payloadRoundTrip(t.decodeStatementHistoryResponse, t.encodeStatementHistoryResponse),
  req_schema_get: payloadRoundTrip(t.decodeSchemaGet, t.encodeSchemaGet),
  req_schema_list: payloadRoundTrip(t.decodeSchemaList, t.encodeSchemaList),
  req_schema_validate: payloadRoundTrip(t.decodeSchemaValidate, t.encodeSchemaValidate),
  req_schema_replace: payloadRoundTrip(t.decodeSchemaReplace, t.encodeSchemaReplace),
  resp_schema_get: payloadRoundTrip(t.decodeSchemaGetResponse, t.encodeSchemaGetResponse),
  resp_schema_list: payloadRoundTrip(t.decodeSchemaListResponse, t.encodeSchemaListResponse),
  resp_schema_validate: payloadRoundTrip(t.decodeSchemaValidateResponse, t.encodeSchemaValidateResponse),
  resp_schema_replace: payloadRoundTrip(t.decodeSchemaReplaceResponse, t.encodeSchemaReplaceResponse),
  req_txn_begin: payloadRoundTrip(t.decodeTxnBegin, t.encodeTxnBegin),
  req_txn_commit: payloadRoundTrip(t.decodeTxnCommit, t.encodeTxnCommit),
  req_txn_abort: payloadRoundTrip(t.decodeTxnAbort, t.encodeTxnAbort),
  req_subscribe: payloadRoundTrip(t.decodeSubscribe, t.encodeSubscribe),
  req_unsubscribe: payloadRoundTrip(t.decodeUnsubscribe, t.encodeUnsubscribe),
  resp_unsubscribe: payloadRoundTrip(t.decodeUnsubscribeResponse, t.encodeUnsubscribeResponse),
  req_ping: payloadRoundTrip(t.decodePing, t.encodePing),
  req_client_pong: payloadRoundTrip(t.decodeClientPong, t.encodeClientPong),
  req_bye: payloadRoundTrip(t.decodeBye, t.encodeBye),
  req_cancel_stream: payloadRoundTrip(t.decodeCancelStream, t.encodeCancelStream),
  req_get_capabilities: payloadRoundTrip(t.decodeGetCapabilities, t.encodeGetCapabilities),
  req_link: payloadRoundTrip(t.decodeLink, t.encodeLink),
  req_unlink: payloadRoundTrip(t.decodeUnlink, t.encodeUnlink),
  resp_unlink: payloadRoundTrip(t.decodeUnlinkResponse, t.encodeUnlinkResponse),
  resp_encode_vector_direct: payloadRoundTrip(t.decodeEncodeResponse, t.encodeEncodeResponse),
  resp_cancel_stream_ack: payloadRoundTrip(t.decodeCancelStreamAck, t.encodeCancelStreamAck),
  req_query_explain: payloadRoundTrip(t.decodeQueryExplain, t.encodeQueryExplain),
  req_query_trace: payloadRoundTrip(t.decodeQueryTrace, t.encodeQueryTrace),
  resp_query_explain: payloadRoundTrip(
    t.decodeQueryExplainResponse,
    t.encodeQueryExplainResponse,
  ),
  resp_query_trace: payloadRoundTrip(t.decodeQueryTraceResponse, t.encodeQueryTraceResponse),
  resp_extractor_list: payloadRoundTrip(
    t.decodeExtractorListResponse,
    t.encodeExtractorListResponse,
  ),
  resp_subscribe_event: payloadRoundTrip(
    t.decodeSubscriptionEvent,
    t.encodeSubscriptionEvent,
  ),

  resp_pong: payloadRoundTrip(t.decodePong, t.encodePong),
  resp_server_ping: payloadRoundTrip(t.decodeServerPing, t.encodeServerPing),

  resp_error_protocol: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_act_as_denied: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_authentication: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_authorization: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_validation: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_not_found: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_conflict: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_resource_exhausted: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_internal: payloadRoundTrip(t.decodeError, t.encodeError),
  resp_error_unavailable: payloadRoundTrip(t.decodeError, t.encodeError),
};
