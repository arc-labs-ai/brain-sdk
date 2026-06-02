/**
 * Wire-protocol opcodes (u16, big-endian on the wire).
 *
 * The high byte is the namespace (0x00 = connection / substrate / admin,
 * 0x01 = typed-graph). Within a namespace the low byte's high bit selects
 * direction: values below 0x80 are server-bound requests, 0x80 and above are
 * client-bound responses. This covers the handshake, the three v1 verbs, BYE,
 * ERROR, and the typed-graph ops the conformance corpus exercises.
 */

export const Opcode = {
  // Connection management.
  Hello: 0x0001,
  Welcome: 0x0081,
  Auth: 0x0002,
  AuthOk: 0x0082,
  Bye: 0x001f,

  // v1 cognitive verbs.
  EncodeReq: 0x0020,
  EncodeResp: 0x00a0,
  RecallReq: 0x0021,
  RecallResp: 0x00a1,
  PlanReq: 0x0022,
  PlanResp: 0x00a2,
  ReasonReq: 0x0023,
  ReasonResp: 0x00a3,
  ForgetReq: 0x0024,
  ForgetResp: 0x00a4,
  LinkReq: 0x0025,
  LinkResp: 0x00a5,
  UnlinkReq: 0x0026,
  UnlinkResp: 0x00a6,
  EncodeVectorDirectReq: 0x002a,
  EncodeVectorDirectResp: 0x00aa,

  // Subscriptions (server push).
  SubscribeReq: 0x0030,
  SubscribeEvent: 0x00b0,
  UnsubscribeReq: 0x0031,
  UnsubscribeResp: 0x00b1,

  // Capability introspection.
  GetCapabilitiesReq: 0x0032,
  GetCapabilitiesResp: 0x00b2,

  // Transactions.
  TxnBegin: 0x0040,
  TxnBeginResp: 0x00c0,
  TxnCommit: 0x0041,
  TxnCommitResp: 0x00c1,
  TxnAbort: 0x0042,
  TxnAbortResp: 0x00c2,

  // Error.
  Error: 0x00ff,

  // Typed-graph ops exercised by the corpus.
  SchemaUploadReq: 0x0120,
  SchemaUploadResp: 0x01a0,
  SchemaGetReq: 0x0121,
  SchemaGetResp: 0x01a1,
  SchemaListReq: 0x0122,
  SchemaListResp: 0x01a2,
  SchemaValidateReq: 0x0123,
  SchemaValidateResp: 0x01a3,
  EntityCreateReq: 0x0130,
  EntityCreateResp: 0x01b0,
  EntityGetReq: 0x0131,
  EntityGetResp: 0x01b1,
  EntityListReq: 0x0137,
  EntityListResp: 0x01b7,
  StatementCreateReq: 0x0140,
  StatementCreateResp: 0x01c0,
  StatementGetReq: 0x0141,
  StatementGetResp: 0x01c1,
  StatementListReq: 0x0146,
  StatementListResp: 0x01c6,
  RelationCreateReq: 0x0150,
  RelationCreateResp: 0x01d0,
  RelationListFromReq: 0x0154,
  RelationListFromResp: 0x01d4,
  RelationListToReq: 0x0155,
  RelationListToResp: 0x01d5,
  QueryReq: 0x0160,
  QueryResp: 0x01e0,
  MaterializeProceduralReq: 0x0164,
  MaterializeProceduralResp: 0x01e4,
} as const;

export type Opcode = (typeof Opcode)[keyof typeof Opcode];
