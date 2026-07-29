/**
 * Wire-protocol opcodes (u16, big-endian on the wire).
 *
 * The high byte is the namespace (0x00 = connection / substrate / admin,
 * 0x01 = typed-graph). Within a namespace the low byte's high bit selects
 * direction: values below 0x80 are server-bound requests, 0x80 and above are
 * client-bound responses. The full set covers connection management and
 * keepalive, the v1 cognitive verbs (encode / recall / plan / reason / forget /
 * link / unlink, plus direct-vector encode), subscriptions, capability
 * introspection, transactions, the error frame, and every typed-graph op the
 * client speaks: schema, entity, statement, and relation lifecycle; the query
 * explain / trace debug surface; and procedural materialization.
 */

export const Opcode = {
  // Connection management.
  Hello: 0x0001,
  Welcome: 0x0081,
  Auth: 0x0002,
  AuthOk: 0x0082,
  Bye: 0x001f,

  // Keepalive. SERVER_PING is the server's idle-timer heartbeat; the client
  // MUST answer it with CLIENT_PONG or the server closes the connection.
  Ping: 0x0010,
  Pong: 0x0090,
  ClientPong: 0x0011,
  ServerPing: 0x0091,
  // Stream control. CancelStream names an in-flight stream in its body and
  // travels on its own stream id; the server answers CancelStreamAck.
  CancelStream: 0x0050,
  CancelStreamAck: 0x00d0,

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
  MemoryListReq: 0x0027,
  MemoryListResp: 0x00a7,
  MemoryInspectReq: 0x0028,
  MemoryInspectResp: 0x00a8,
  EncodeVectorDirectReq: 0x002a,
  EncodeVectorDirectResp: 0x00aa,

  // Space + session registry ops (tenancy).
  SpaceCreateReq: 0x0070,
  SpaceCreateResp: 0x00f0,
  SpaceListReq: 0x0071,
  SpaceListResp: 0x00f1,
  SpaceDeleteReq: 0x0072,
  SpaceDeleteResp: 0x00f2,
  SessionCreateReq: 0x0073,
  SessionCreateResp: 0x00f3,
  SessionListReq: 0x0074,
  SessionListResp: 0x00f4,
  SessionDeleteReq: 0x0075,
  SessionDeleteResp: 0x00f5,

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
  // Destructive namespace swap — drops every declared row before the new
  // document lands. Distinct from SchemaUpload, which merges. Brain §03.05.
  SchemaReplaceReq: 0x0127,
  SchemaReplaceResp: 0x01a7,

  // Extractor introspection (read-only; extraction is always-on).
  ExtractorListReq: 0x0124,
  ExtractorListResp: 0x01a4,

  EntityCreateReq: 0x0130,
  EntityCreateResp: 0x01b0,
  EntityGetReq: 0x0131,
  EntityGetResp: 0x01b1,
  EntityResolveReq: 0x0136,
  EntityResolveResp: 0x01b6,
  EntityListReq: 0x0137,
  EntityListResp: 0x01b7,
  EntityUpdateReq: 0x0132,
  EntityUpdateResp: 0x01b2,
  EntityRenameReq: 0x0133,
  EntityRenameResp: 0x01b3,
  EntityMergeReq: 0x0134,
  EntityMergeResp: 0x01b4,
  EntityUnmergeReq: 0x0135,
  EntityUnmergeResp: 0x01b5,
  EntityTombstoneReq: 0x0138,
  EntityTombstoneResp: 0x01b8,
  StatementCreateReq: 0x0140,
  StatementCreateResp: 0x01c0,
  StatementSupersedeReq: 0x0142,
  StatementSupersedeResp: 0x01c2,
  StatementTombstoneReq: 0x0143,
  StatementTombstoneResp: 0x01c3,
  StatementRetractReq: 0x0144,
  StatementRetractResp: 0x01c4,
  StatementHistoryReq: 0x0145,
  StatementHistoryResp: 0x01c5,
  StatementGetReq: 0x0141,
  StatementGetResp: 0x01c1,
  StatementListReq: 0x0146,
  StatementListResp: 0x01c6,
  RelationCreateReq: 0x0150,
  RelationCreateResp: 0x01d0,
  RelationGetReq: 0x0151,
  RelationGetResp: 0x01d1,
  RelationSupersedeReq: 0x0152,
  RelationSupersedeResp: 0x01d2,
  RelationTombstoneReq: 0x0153,
  RelationTombstoneResp: 0x01d3,
  RelationListFromReq: 0x0154,
  RelationListFromResp: 0x01d4,
  RelationListToReq: 0x0155,
  RelationListToResp: 0x01d5,
  RelationTraverseReq: 0x0156,
  RelationTraverseResp: 0x01d6,
  QueryExplainReq: 0x0161,
  QueryExplainResp: 0x01e1,
  QueryTraceReq: 0x0162,
  QueryTraceResp: 0x01e2,
  GraphFetchReq: 0x0163,
  GraphFetchResp: 0x01e3,
  MaterializeProceduralReq: 0x0164,
  MaterializeProceduralResp: 0x01e4,
} as const;

export type Opcode = (typeof Opcode)[keyof typeof Opcode];
