//! Enumeration, inspection, and schema-admin verbs against an in-process mock
//! server: SCHEMA_DROP (unary), EXTRACTOR_LIST (unary), MEMORY_LIST (streamed),
//! MEMORY_INSPECT (unary), and GRAPH_FETCH (streamed).
//!
//! These ops have a wire type, a `BrainClient` method, and a conformance corpus
//! vector, but no request/response round-trip over a TCP connection — the
//! MEMORY_* / GRAPH_FETCH reads are otherwise exercised only through the HTTP
//! client, and SCHEMA_DROP / EXTRACTOR_LIST only through byte-level goldens.
//! This drives each through the real `BrainClient` codec and asserts the decoded
//! reply.

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AuthOkPayload, AuthPayload, EncodeStageArtifact, EncodeStageGraph, EncodeStageKeywordField,
    EncodeStageRecord, ExtractorListItem, ExtractorListRequest, ExtractorListResponseFrame,
    GraphEdge, GraphFetchRequest, GraphFetchResponseFrame, GraphNode, HelloPayload,
    MemoryInspectRequest, MemoryInspectResponse, MemoryListDirWire, MemoryListItem,
    MemoryListRequest, MemoryListResponseFrame, MemoryListSortWire, MemoryListTimeAxisWire,
    SchemaDropRequest, SchemaDropResponse, ServerFeatures, SpacePermissions, WelcomePayload,
};
use brain_db_sdk::{Auth, BrainClient};

const SERVER_AGENT: [u8; 16] = [0x22; 16];
const REQUEST_ID: [u8; 16] = [0x44; 16];
const MEMORY_ID: [u8; 16] = [0x55; 16];
const ENTITY_ID: [u8; 16] = [0x66; 16];

async fn write_one<T: serde::Serialize>(sock: &mut TcpStream, op: Opcode, sid: u32, p: &T) {
    let frame = Frame::new(op.as_u16(), FLAG_EOS, sid, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

async fn handshake(sock: &mut TcpStream, buf: &mut Vec<u8>) {
    let hello_frame = read_frame(sock, buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        connection_id: [0xAB; 16],
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 1 << 20,
            max_concurrent_streams: 64,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(sock, buf).await.expect("auth");
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        space_id: SERVER_AGENT,
        bound_shard_id: 0,
        permissions: SpacePermissions {
            can_act_as: false,
            can_encode: true,
            can_recall: true,
            can_plan: true,
            can_reason: true,
            can_forget: true,
            can_admin: true,
        },
        namespace: String::new(),
        server_time_unix_nanos: 1,
    };
    write_one(sock, Opcode::AuthOk, 0, &auth_ok).await;
}

async fn serve(mut sock: TcpStream) {
    let mut buf = Vec::new();
    handshake(&mut sock, &mut buf).await;

    // SCHEMA_DROP (first call): a declared type is actually removed.
    let f = read_frame(&mut sock, &mut buf).await.expect("schema drop 1");
    assert_eq!(f.opcode, Opcode::SchemaDropReq as u16);
    let req: SchemaDropRequest = from_cbor_bytes(&f.payload).expect("decode drop 1");
    assert_eq!(req.namespace, "people");
    assert_eq!(req.target_name, "born_in");
    write_one(
        &mut sock,
        Opcode::SchemaDropResp,
        f.stream_id,
        &SchemaDropResponse {
            namespace: "people".to_string(),
            schema_version: 3,
            target_kind: req.target_kind,
            target_name: req.target_name.clone(),
            dropped: true,
            live_rows: 0,
            validation_errors: vec![],
        },
    )
    .await;

    // SCHEMA_DROP (second call): the type is already gone — a lenient re-drop is
    // a no-op that reports dropped=false with schema_version=0.
    let f = read_frame(&mut sock, &mut buf).await.expect("schema drop 2");
    assert_eq!(f.opcode, Opcode::SchemaDropReq as u16);
    let req: SchemaDropRequest = from_cbor_bytes(&f.payload).expect("decode drop 2");
    write_one(
        &mut sock,
        Opcode::SchemaDropResp,
        f.stream_id,
        &SchemaDropResponse {
            namespace: "people".to_string(),
            schema_version: 0,
            target_kind: req.target_kind,
            target_name: req.target_name.clone(),
            dropped: false,
            live_rows: 0,
            validation_errors: vec![],
        },
    )
    .await;

    // EXTRACTOR_LIST (unary): the always-on extractor registry snapshot.
    let f = read_frame(&mut sock, &mut buf).await.expect("extractor list");
    assert_eq!(f.opcode, Opcode::ExtractorListReq as u16);
    let _req: ExtractorListRequest = from_cbor_bytes(&f.payload).expect("decode extractor list");
    write_one(
        &mut sock,
        Opcode::ExtractorListResp,
        f.stream_id,
        &ExtractorListResponseFrame {
            items: vec![
                ExtractorListItem {
                    extractor_id: 1,
                    namespace: "brain".to_string(),
                    name: "pattern".to_string(),
                    kind: 0,
                    schema_version: 1,
                    created_at_unix_nanos: 10,
                },
                ExtractorListItem {
                    extractor_id: 2,
                    namespace: "brain".to_string(),
                    name: "classifier".to_string(),
                    kind: 1,
                    schema_version: 1,
                    created_at_unix_nanos: 20,
                },
            ],
            total: 2,
            is_final: true,
        },
    )
    .await;

    // MEMORY_LIST (streamed): a single final frame with one item.
    let f = read_frame(&mut sock, &mut buf).await.expect("memory list");
    assert_eq!(f.opcode, Opcode::MemoryListReq as u16);
    let req: MemoryListRequest = from_cbor_bytes(&f.payload).expect("decode memory list");
    assert_eq!(req.limit, 50);
    assert_eq!(req.dir, MemoryListDirWire::Desc);
    write_one(
        &mut sock,
        Opcode::MemoryListResp,
        f.stream_id,
        &MemoryListResponseFrame {
            items: vec![MemoryListItem {
                memory_id: MEMORY_ID,
                space_id: SERVER_AGENT,
                session_id: 0,
                text: "the kettle is on".to_string(),
                kind: 0,
                state: 0,
                created_at_unix_nanos: 100,
                occurred_at_unix_nanos: 0,
                last_accessed_at_unix_nanos: 100,
                salience: 0.5,
                access_count: 1,
                source_request_id: REQUEST_ID,
                statement_count: 1,
                entity_count: 1,
                relation_count: 0,
            }],
            next_cursor: Vec::new(),
            cumulative_count: 1,
            is_final: true,
        },
    )
    .await;

    // MEMORY_INSPECT (unary): the durable write-artifact bundle for one memory.
    let f = read_frame(&mut sock, &mut buf).await.expect("memory inspect");
    assert_eq!(f.opcode, Opcode::MemoryInspectReq as u16);
    let req: MemoryInspectRequest = from_cbor_bytes(&f.payload).expect("decode inspect");
    assert_eq!(req.memory_id, MEMORY_ID);
    write_one(
        &mut sock,
        Opcode::MemoryInspectResp,
        f.stream_id,
        &MemoryInspectResponse {
            found: true,
            memory_id: MEMORY_ID,
            text: "the kettle is on".to_string(),
            artifact: EncodeStageArtifact {
                record: Some(EncodeStageRecord {
                    memory_id: MEMORY_ID,
                    kind: 0,
                    salience: 0.5,
                    created_at_unix_nanos: 100,
                    occurred_at_unix_nanos: 0,
                    vector_dim: 384,
                    text_len: 16,
                    lsn: 9,
                }),
                keyword_fields: vec![EncodeStageKeywordField {
                    field: "text".to_string(),
                    terms: vec!["kettle".to_string()],
                }],
                graph: Some(EncodeStageGraph::default()),
                ..Default::default()
            },
        },
    )
    .await;

    // GRAPH_FETCH (streamed): a single final frame with one node + one edge.
    let f = read_frame(&mut sock, &mut buf).await.expect("graph fetch");
    assert_eq!(f.opcode, Opcode::GraphFetchReq as u16);
    let req: GraphFetchRequest = from_cbor_bytes(&f.payload).expect("decode graph fetch");
    assert_eq!(req.limit, 100);
    write_one(
        &mut sock,
        Opcode::GraphFetchResp,
        f.stream_id,
        &GraphFetchResponseFrame {
            nodes: vec![GraphNode {
                id: ENTITY_ID,
                kind: 0,
                label: "Ada".to_string(),
                type_qname: "brain:Person".to_string(),
            }],
            edges: vec![GraphEdge {
                from_id: ENTITY_ID,
                to_id: MEMORY_ID,
                kind: 3,
                label: String::new(),
            }],
            next_cursor: Vec::new(),
            is_final: true,
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

fn memory_list_request() -> MemoryListRequest {
    MemoryListRequest {
        sort: MemoryListSortWire::Created,
        dir: MemoryListDirWire::Desc,
        limit: 50,
        cursor: Vec::new(),
        kinds: Vec::new(),
        include_tombstoned: false,
        time_axis: MemoryListTimeAxisWire::Created,
        from_unix_nanos: 0,
        to_unix_nanos: 0,
        salience_min: 0.0,
        salience_max: 1.0,
        text_contains: String::new(),
        act_as: None,
    }
}

#[tokio::test]
async fn reads_and_admin_verbs_over_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec()))
        .await
        .expect("connect");

    // SCHEMA_DROP — a real removal, then a lenient re-drop no-op. Both response
    // shapes (dropped flag + schema_version) must decode.
    let dropped = client
        .drop_schema(&SchemaDropRequest {
            namespace: "people".to_string(),
            target_kind: 0,
            target_name: "born_in".to_string(),
            force: true,
            request_id: REQUEST_ID,
        })
        .await
        .expect("drop_schema (first)");
    assert!(dropped.dropped);
    assert_eq!(dropped.schema_version, 3);

    let redropped = client
        .drop_schema(&SchemaDropRequest {
            namespace: "people".to_string(),
            target_kind: 0,
            target_name: "born_in".to_string(),
            force: true,
            request_id: REQUEST_ID,
        })
        .await
        .expect("drop_schema (second)");
    assert!(
        !redropped.dropped,
        "a re-drop of an already-gone type is a no-op, not a removal"
    );
    assert_eq!(redropped.schema_version, 0);

    // EXTRACTOR_LIST — read-only introspection over the always-on extractors.
    let extractors = client
        .extractor_list(&ExtractorListRequest {})
        .await
        .expect("extractor_list");
    assert_eq!(extractors.total, 2);
    assert_eq!(extractors.items.len(), 2);
    assert_eq!(extractors.items[0].name, "pattern");
    assert_eq!(extractors.items[1].kind, 1);

    // MEMORY_LIST — flattened enumeration of the caller's memories.
    let memories = client
        .memory_list(&memory_list_request())
        .await
        .expect("memory_list");
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].memory_id, MEMORY_ID);
    assert_eq!(memories[0].text, "the kettle is on");

    // MEMORY_INSPECT — the durable per-memory write-artifact bundle.
    let inspected = client
        .memory_inspect(&MemoryInspectRequest {
            memory_id: MEMORY_ID,
            act_as: None,
        })
        .await
        .expect("memory_inspect");
    assert!(inspected.found);
    let record = inspected.artifact.record.expect("record");
    assert_eq!(record.vector_dim, 384);
    assert_eq!(record.lsn, 9);
    assert_eq!(inspected.artifact.keyword_fields[0].terms, ["kettle"]);

    // GRAPH_FETCH — flattened typed-graph export (nodes + edges).
    let (nodes, edges) = client
        .graph_fetch(&GraphFetchRequest {
            limit: 100,
            cursor: Vec::new(),
            include_statements: false,
            include_memories: true,
            include_memory_edges: false,
            include_tombstoned: false,
            act_as: None,
        })
        .await
        .expect("graph_fetch");
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].id, ENTITY_ID);
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].from_id, ENTITY_ID);

    client.close().await.expect("bye");
    server.await.expect("server task");
}
