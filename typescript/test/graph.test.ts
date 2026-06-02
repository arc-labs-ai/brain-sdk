/**
 * Typed-graph verb round-trips against an in-process mock server:
 * ENTITY_CREATE, STATEMENT_CREATE, RELATION_CREATE, SCHEMA_UPLOAD, QUERY, and
 * MATERIALIZE_PROCEDURAL. Each is a single-shot request/response; the test
 * drives them in sequence over one connection and checks the decoded replies.
 */

import { describe, expect, it } from "vitest";
import * as net from "node:net";

import { BrainClient } from "../src/client.js";
import { newId } from "../src/client.js";
import { FrameChannel } from "../src/transport.js";
import { FLAG_EOS } from "../src/wire/frame.js";
import { Opcode } from "../src/wire/opcode.js";
import {
  type AuthOkPayload,
  type EntityCreateResponse,
  type MaterializeProceduralResponse,
  type QueryResponse,
  type RelationCreateResponse,
  type SchemaUploadResponse,
  type StatementCreateResponse,
  type WelcomePayload,
  decodeAuth,
  decodeEntityCreate,
  decodeHello,
  decodeMaterializeProcedural,
  decodeQuery,
  decodeRelationCreate,
  decodeSchemaUpload,
  decodeStatementCreate,
  encodeAuthOk,
  encodeEntityCreateResponse,
  encodeMaterializeProceduralResponse,
  encodeQueryResponse,
  encodeRelationCreateResponse,
  encodeSchemaUploadResponse,
  encodeStatementCreateResponse,
  encodeWelcome,
} from "../src/wire/types.js";

const ENTITY_ID = new Uint8Array(16).fill(0x11);
const STATEMENT_ID = new Uint8Array(16).fill(0x22);
const RELATION_ID = new Uint8Array(16).fill(0x33);

function startServer(
  handler: (sock: net.Socket) => Promise<void>,
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => void handler(sock));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

async function serveGraph(sock: net.Socket): Promise<void> {
  const chan = new FrameChannel(sock);

  const helloFrame = await chan.read();
  const hello = decodeHello(helloFrame.payload);
  const welcome: WelcomePayload = {
    serverId: "mock-brain",
    chosenVersion: 1,
    sessionId: new Uint8Array(16).fill(0xab),
    capabilities: hello.capabilities,
    serverFeatures: {
      maxPayloadSize: 1 << 20,
      maxConcurrentStreams: 64,
      idleTimeoutSeconds: 300,
      authMethods: [],
    },
  };
  await chan.write({ opcode: Opcode.Welcome, flags: FLAG_EOS, streamId: 0, payload: encodeWelcome(welcome) });

  const authFrame = await chan.read();
  const auth = decodeAuth(authFrame.payload);
  const authOk: AuthOkPayload = {
    agentId: auth.agentId,
    boundShardId: 0,
    permissions: {
      canEncode: true,
      canRecall: true,
      canPlan: true,
      canReason: true,
      canForget: true,
      canAdmin: true,
    },
    serverTimeUnixNanos: 1n,
  };
  await chan.write({ opcode: Opcode.AuthOk, flags: FLAG_EOS, streamId: 0, payload: encodeAuthOk(authOk) });

  // ENTITY_CREATE.
  let f = await chan.read();
  expect(f.opcode).toBe(Opcode.EntityCreateReq);
  expect(decodeEntityCreate(f.payload).canonicalName).toBe("Ada Lovelace");
  const entityResp: EntityCreateResponse = { entityId: ENTITY_ID };
  await chan.write({ opcode: Opcode.EntityCreateResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeEntityCreateResponse(entityResp) });

  // STATEMENT_CREATE.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.StatementCreateReq);
  expect(decodeStatementCreate(f.payload).predicate).toBe("born_in");
  const stmtResp: StatementCreateResponse = {
    statementId: STATEMENT_ID,
    autoSuperseded: new Uint8Array(16),
    chainRoot: STATEMENT_ID,
  };
  await chan.write({ opcode: Opcode.StatementCreateResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeStatementCreateResponse(stmtResp) });

  // RELATION_CREATE.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.RelationCreateReq);
  expect(decodeRelationCreate(f.payload).relationType).toBe("collaborated_with");
  const relResp: RelationCreateResponse = { relationId: RELATION_ID };
  await chan.write({ opcode: Opcode.RelationCreateResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeRelationCreateResponse(relResp) });

  // SCHEMA_UPLOAD.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.SchemaUploadReq);
  expect(decodeSchemaUpload(f.payload).dryRun).toBe(true);
  const schemaResp: SchemaUploadResponse = {
    namespace: "people",
    schemaVersion: 2,
    validationErrors: [],
    backwardCompatible: true,
    migrationSummaryBlob: new Uint8Array(0),
  };
  await chan.write({ opcode: Opcode.SchemaUploadResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeSchemaUploadResponse(schemaResp) });

  // QUERY.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.QueryReq);
  expect(decodeQuery(f.payload).text).toBe("computing pioneers");
  const queryResp: QueryResponse = {
    items: [{ id: { kind: 1, bytes: ENTITY_ID }, fusedScore: 0.95, contributing: [] }],
    totalLatencyMs: 1.5,
    retrieverOutcomes: [],
  };
  await chan.write({ opcode: Opcode.QueryResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeQueryResponse(queryResp) });

  // MATERIALIZE_PROCEDURAL.
  f = await chan.read();
  expect(f.opcode).toBe(Opcode.MaterializeProceduralReq);
  expect(decodeMaterializeProcedural(f.payload).topK).toBe(3);
  const procResp: MaterializeProceduralResponse = {
    systemBlock: "## Procedures\n- be concise",
    statementIds: [STATEMENT_ID],
    totalCandidates: 1,
    trimmedByBudget: false,
  };
  await chan.write({ opcode: Opcode.MaterializeProceduralResp, flags: FLAG_EOS, streamId: f.streamId, payload: encodeMaterializeProceduralResponse(procResp) });

  const bye = await chan.read();
  expect(bye.opcode).toBe(Opcode.Bye);
  sock.end();
}

describe("typed-graph verbs", () => {
  it("round-trip ENTITY/STATEMENT/RELATION/SCHEMA/QUERY/MATERIALIZE", async () => {
    const { server, port } = await startServer(serveGraph);
    try {
      const client = await BrainClient.connect("127.0.0.1", port);

      const entity = await client.createEntity({
        entityTypeId: 1,
        canonicalName: "Ada Lovelace",
        aliases: ["Ada"],
        attributesBlob: new Uint8Array(0),
        requestId: newId(),
      });
      expect([...entity.entityId]).toEqual([...ENTITY_ID]);

      const statement = await client.createStatement({
        kind: "Fact",
        subject: entity.entityId,
        predicate: "born_in",
        object: { kind: "Value", value: { kind: "Integer", value: 1815n } },
        confidence: 0.99,
        evidence: { kind: "Inline", ids: [] },
        extractorId: 0,
        validFromUnixNanos: 0n,
        validToUnixNanos: 0xffffffffffffffffn,
        eventAtUnixNanos: 0n,
        schemaVersion: 1,
        requestId: newId(),
      });
      expect([...statement.statementId]).toEqual([...STATEMENT_ID]);
      expect([...statement.chainRoot]).toEqual([...STATEMENT_ID]);

      const relation = await client.createRelation({
        relationType: "collaborated_with",
        fromEntity: entity.entityId,
        toEntity: ENTITY_ID,
        propertiesBlob: new Uint8Array(0),
        evidence: { kind: "Inline", ids: [] },
        extractorId: 0,
        confidence: 0.8,
        validFromUnixNanos: 0n,
        validToUnixNanos: 0xffffffffffffffffn,
        requestId: newId(),
      });
      expect([...relation.relationId]).toEqual([...RELATION_ID]);

      const schema = await client.uploadSchema({
        schemaDocument: "entity Person {}",
        dryRun: true,
        allowBreaking: false,
        requestId: newId(),
      });
      expect(schema.namespace).toBe("people");
      expect(schema.backwardCompatible).toBe(true);

      const results = await client.query({
        text: "computing pioneers",
        entityAnchor: null,
        kindFilter: [],
        predicateFilter: [],
        timeFilter: null,
        confidenceMin: null,
        includeTombstoned: false,
        includeSuperseded: false,
        limit: 10,
        retrievers: { kind: "Auto" },
        fusionConfig: null,
        requestId: newId(),
      });
      expect(results.items.length).toBe(1);
      expect([...results.items[0]!.id.bytes]).toEqual([...ENTITY_ID]);

      const proc = await client.materializeProcedural({
        agentId: client.agentId,
        contextFilter: 0n,
        topK: 3,
        minConfidence: 0.5,
        categories: ["style"],
        requestId: newId(),
      });
      expect([...proc.statementIds[0]!]).toEqual([...STATEMENT_ID]);
      expect(proc.trimmedByBudget).toBe(false);

      await client.close();
    } finally {
      server.close();
    }
  });
});
