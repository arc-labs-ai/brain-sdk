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
  ForgetReq: 0x0024,
  ForgetResp: 0x00a4,
  EncodeVectorDirectReq: 0x002a,
  EncodeVectorDirectResp: 0x00aa,

  // Error.
  Error: 0x00ff,

  // Typed-graph ops exercised by the corpus.
  SchemaUploadReq: 0x0120,
  SchemaUploadResp: 0x01a0,
  EntityCreateReq: 0x0130,
  EntityCreateResp: 0x01b0,
  StatementCreateReq: 0x0140,
  StatementCreateResp: 0x01c0,
  RelationCreateReq: 0x0150,
  RelationCreateResp: 0x01d0,
  QueryReq: 0x0160,
  QueryResp: 0x01e0,
  MaterializeProceduralReq: 0x0164,
  MaterializeProceduralResp: 0x01e4,
} as const;

export type Opcode = (typeof Opcode)[keyof typeof Opcode];
