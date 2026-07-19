//! Typed-graph verb round-trips against an in-process mock server:
//! ENTITY_CREATE, STATEMENT_CREATE, RELATION_CREATE, SCHEMA_UPLOAD, and
//! MATERIALIZE_PROCEDURAL. Each is a single-shot request/response; the test
//! drives them in sequence over one connection and checks the decoded replies.

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AgentPermissions, AuthOkPayload, AuthPayload, EntityCreateRequest, EntityCreateResponse,
    EvidenceRefWire, HelloPayload, MaterializeProceduralRequest,
    MaterializeProceduralResponse,
    RelationCreateRequest, RelationCreateResponse, SchemaUploadRequest,
    SchemaUploadResponse, ServerFeatures, StatementCreateRequest, StatementCreateResponse,
    StatementKindWire, StatementObjectWire, StatementValueWire, WelcomePayload,
};
use brain_db_sdk::{Auth, BrainClient};

const ENTITY_ID: [u8; 16] = [0x11; 16];
const STATEMENT_ID: [u8; 16] = [0x22; 16];
const RELATION_ID: [u8; 16] = [0x33; 16];
/// The agent id the mock server assigns from the credential.
const SERVER_AGENT: [u8; 16] = [0x22; 16];

async fn write_one<T: serde::Serialize>(sock: &mut TcpStream, op: Opcode, sid: u32, p: &T) {
    let frame = Frame::new(op.as_u16(), FLAG_EOS, sid, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

async fn serve_graph(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // Handshake.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        session_id: [0xAB; 16],
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 1 << 20,
            max_concurrent_streams: 64,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: SERVER_AGENT,
        bound_shard_id: 0,
        permissions: AgentPermissions {
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
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // ENTITY_CREATE.
    let f = read_frame(&mut sock, &mut buf).await.expect("entity");
    assert_eq!(f.opcode, Opcode::EntityCreateReq as u16);
    let req: EntityCreateRequest = from_cbor_bytes(&f.payload).expect("decode entity");
    assert_eq!(req.canonical_name, "Ada Lovelace");
    write_one(
        &mut sock,
        Opcode::EntityCreateResp,
        f.stream_id,
        &EntityCreateResponse {
            entity_id: ENTITY_ID,
        },
    )
    .await;

    // STATEMENT_CREATE.
    let f = read_frame(&mut sock, &mut buf).await.expect("statement");
    assert_eq!(f.opcode, Opcode::StatementCreateReq as u16);
    let req: StatementCreateRequest = from_cbor_bytes(&f.payload).expect("decode statement");
    assert_eq!(req.predicate, "born_in");
    write_one(
        &mut sock,
        Opcode::StatementCreateResp,
        f.stream_id,
        &StatementCreateResponse {
            statement_id: STATEMENT_ID,
            auto_superseded: [0; 16],
            chain_root: STATEMENT_ID,
        },
    )
    .await;

    // RELATION_CREATE.
    let f = read_frame(&mut sock, &mut buf).await.expect("relation");
    assert_eq!(f.opcode, Opcode::RelationCreateReq as u16);
    let req: RelationCreateRequest = from_cbor_bytes(&f.payload).expect("decode relation");
    assert_eq!(req.relation_type, "collaborated_with");
    write_one(
        &mut sock,
        Opcode::RelationCreateResp,
        f.stream_id,
        &RelationCreateResponse {
            relation_id: RELATION_ID,
        },
    )
    .await;

    // SCHEMA_UPLOAD.
    let f = read_frame(&mut sock, &mut buf).await.expect("schema");
    assert_eq!(f.opcode, Opcode::SchemaUploadReq as u16);
    let req: SchemaUploadRequest = from_cbor_bytes(&f.payload).expect("decode schema");
    assert!(req.dry_run);
    write_one(
        &mut sock,
        Opcode::SchemaUploadResp,
        f.stream_id,
        &SchemaUploadResponse {
            namespace: "people".to_string(),
            schema_version: 2,
            validation_errors: vec![],
            backward_compatible: true,
            migration_summary_blob: vec![],
        },
    )
    .await;

    // MATERIALIZE_PROCEDURAL.
    let f = read_frame(&mut sock, &mut buf).await.expect("materialize");
    assert_eq!(f.opcode, Opcode::MaterializeProceduralReq as u16);
    let req: MaterializeProceduralRequest =
        from_cbor_bytes(&f.payload).expect("decode materialize");
    assert_eq!(req.top_k, 3);
    write_one(
        &mut sock,
        Opcode::MaterializeProceduralResp,
        f.stream_id,
        &MaterializeProceduralResponse {
            system_block: "## Procedures\n- be concise".to_string(),
            statement_ids: vec![STATEMENT_ID],
            total_candidates: 1,
            trimmed_by_budget: false,
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

fn rid() -> [u8; 16] {
    brain_db_sdk::new_id()
}

#[tokio::test]
async fn typed_graph_verbs_round_trip() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_graph(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");

    let entity = client
        .create_entity(&EntityCreateRequest {
            act_as: None,
            entity_type_id: 1,
            canonical_name: "Ada Lovelace".to_string(),
            aliases: vec!["Ada".to_string()],
            attributes_blob: vec![],
            request_id: rid(),
        })
        .await
        .expect("create_entity");
    assert_eq!(entity.entity_id, ENTITY_ID);

    let statement = client
        .create_statement(&StatementCreateRequest {
            act_as: None,
            kind: StatementKindWire::Fact,
            subject: entity.entity_id,
            predicate: "born_in".to_string(),
            object: StatementObjectWire::Value(StatementValueWire::Integer(1815)),
            confidence: 0.99,
            evidence: EvidenceRefWire::Inline(vec![]),
            extractor_id: 0,
            valid_from_unix_nanos: 0,
            valid_to_unix_nanos: u64::MAX,
            event_at_unix_nanos: 0,
            schema_version: 1,
            request_id: rid(),
        })
        .await
        .expect("create_statement");
    assert_eq!(statement.statement_id, STATEMENT_ID);
    assert_eq!(statement.chain_root, STATEMENT_ID);

    let relation = client
        .create_relation(&RelationCreateRequest {
            act_as: None,
            relation_type: "collaborated_with".to_string(),
            from_entity: entity.entity_id,
            to_entity: ENTITY_ID,
            properties_blob: vec![],
            evidence: EvidenceRefWire::Inline(vec![]),
            extractor_id: 0,
            confidence: 0.8,
            valid_from_unix_nanos: 0,
            valid_to_unix_nanos: u64::MAX,
            request_id: rid(),
        })
        .await
        .expect("create_relation");
    assert_eq!(relation.relation_id, RELATION_ID);

    let schema = client
        .upload_schema(&SchemaUploadRequest {
            schema_document: "entity Person {}".to_string(),
            dry_run: true,
            allow_breaking: false,
            request_id: rid(),
        })
        .await
        .expect("upload_schema");
    assert_eq!(schema.namespace, "people");
    assert!(schema.backward_compatible);

    let proc = client
        .materialize_procedural(&MaterializeProceduralRequest {
            agent_id: client.agent_id(),
            context_filter: 0,
            top_k: 3,
            min_confidence: 0.5,
            categories: vec!["style".to_string()],
            request_id: rid(),
        })
        .await
        .expect("materialize_procedural");
    assert_eq!(proc.statement_ids, vec![STATEMENT_ID]);
    assert!(!proc.trimmed_by_budget);

    client.close().await.expect("bye");
    server.await.expect("server task");
}

// ===========================================================================
// Read-side typed-graph verbs.
//
// The vendored conformance corpus has NO golden bytes for these read ops, so
// they are exercised by CBOR round-trip (encode → decode equality) plus an
// in-process mock server that drives the unary + streamed client verbs.
// ===========================================================================

use brain_db_sdk::wire::types::{
    Capabilities, EntityGetRequest, EntityGetResponse, EntityListItem, EntityListRequest,
    EntityListResponseFrame, EntityResolveRequest, EntityResolveResponse, EntityView,
    GetCapabilitiesRequest, GetCapabilitiesResponse, RelationListFromRequest,
    RelationListFromResponseFrame, RelationListToRequest, RelationListToResponseFrame,
    RelationView, ResolutionOutcomeWire, SchemaGetRequest, SchemaGetResponse, SchemaListItemWire,
    SchemaListRequest, SchemaListResponseFrame, SchemaValidateRequest, SchemaValidateResponse,
    SchemaValidationErrorWire, StatementGetRequest, StatementGetResponse, StatementListRequest,
    StatementListResponseFrame, StatementView,
};

fn id(seed: u8) -> [u8; 16] {
    let mut u = [0u8; 16];
    for (i, b) in u.iter_mut().enumerate() {
        *b = seed.wrapping_add(i as u8);
    }
    u
}

fn sample_entity_view() -> EntityView {
    EntityView {
        entity_id: id(7),
        entity_type_id: 1,
        canonical_name: "Alice".to_string(),
        normalized_name: "alice".to_string(),
        aliases: vec!["A.".to_string()],
        attributes_blob: b"x".to_vec(),
        mention_count: 3,
        created_at_unix_nanos: 1_700_000_000_000_000_000,
        updated_at_unix_nanos: 1_700_000_001_000_000_000,
        merged_into: [0; 16],
        embedding_version: 1,
        flags: 0,
    }
}

fn sample_statement_view() -> StatementView {
    StatementView {
        statement_id: id(3),
        kind: StatementKindWire::Fact,
        subject: id(4),
        subject_pending_audit_id: [0; 16],
        predicate: "test:role".to_string(),
        object: StatementObjectWire::EntityRef(id(5)),
        confidence: 0.85,
        evidence: EvidenceRefWire::Inline(vec![[7u8; 16]]),
        extractor_id: 0,
        extracted_at_unix_nanos: 1_700_000_000_000_000_000,
        schema_version: 1,
        valid_from_unix_nanos: 1_700_000_000_000_000_000,
        valid_to_unix_nanos: 0,
        event_at_unix_nanos: 0,
        version: 1,
        superseded_by: [0; 16],
        supersedes: [0; 16],
        chain_root: id(3),
        tombstoned: false,
        tombstoned_at_unix_nanos: 0,
        tombstone_reason: 0,
        flags: 0,
        is_stateful: false,
    }
}

fn sample_relation_view() -> RelationView {
    RelationView {
        relation_id: id(10),
        chain_root: id(10),
        relation_type: "test:knows".to_string(),
        from_entity: id(11),
        to_entity: id(12),
        properties_blob: Vec::new(),
        evidence: EvidenceRefWire::Inline(vec![[5u8; 16]]),
        extractor_id: 0,
        extracted_at_unix_nanos: 1_700_000_000_000_000_000,
        confidence: 0.9,
        valid_from_unix_nanos: 0,
        valid_to_unix_nanos: 0,
        version: 1,
        superseded_by: [0; 16],
        supersedes: [0; 16],
        tombstoned: false,
        tombstoned_at_unix_nanos: 0,
        flags: 0,
    }
}

fn round_trip<T>(value: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug + PartialEq,
{
    let bytes = to_cbor_bytes(value);
    let back: T = from_cbor_bytes(&bytes).expect("decode round-trip");
    assert_eq!(&back, value);
}

#[test]
fn read_side_types_round_trip() {
    round_trip(&GetCapabilitiesRequest {});
    round_trip(&GetCapabilitiesResponse {
        capabilities: Capabilities {
            rerank: true,
            llm_extractor: false,
            classifier_extractor: true,
            pattern_extractor: true,
            schema_namespaces: vec!["people".to_string()],
            vector_dim: 384,
        },
    });

    round_trip(&EntityGetRequest {
        entity_id: id(2),
        act_as: None,
    });
    round_trip(&EntityGetResponse {
        entity: sample_entity_view(),
    });
    round_trip(&EntityListRequest {
        entity_type_id: 1,
        name_prefix: "ali".to_string(),
        mention_count_min: 0,
        include_tombstoned: false,
        include_merged: false,
        limit: 50,
        cursor: Vec::new(),
        act_as: None,
    });
    round_trip(&EntityListResponseFrame {
        items: vec![EntityListItem {
            entity: sample_entity_view(),
        }],
        next_cursor: vec![0xAB, 0xCD],
        cumulative_count: 1,
        is_final: true,
    });

    round_trip(&EntityResolveRequest {
        candidate_name: "Alice".to_string(),
        context: "she joined in 2020".to_string(),
        entity_type_hint: 1,
        allow_create: true,
        request_id: id(30),
        act_as: None,
    });
    round_trip(&EntityResolveResponse {
        outcome: ResolutionOutcomeWire::Resolved,
        tier: 1,
        confidence: 1.0,
        resolved_entity: id(7),
        candidate_ids: Vec::new(),
        audit_id: [0; 16],
    });
    round_trip(&EntityResolveResponse {
        outcome: ResolutionOutcomeWire::Ambiguous,
        tier: 0,
        confidence: 0.0,
        resolved_entity: [0; 16],
        candidate_ids: vec![id(7), id(8)],
        audit_id: id(9),
    });

    round_trip(&StatementGetRequest {
        statement_id: id(20),
        follow_supersession: true,
        act_as: None,
    });
    round_trip(&StatementGetResponse {
        statement: sample_statement_view(),
        returned_via_supersession: false,
    });
    round_trip(&StatementListRequest {
        subject: id(70),
        predicate: "test:role".to_string(),
        kind: 1,
        min_confidence: 0.5,
        time_range_start_unix_nanos: 1_000,
        time_range_end_unix_nanos: 2_000,
        only_current: true,
        include_tombstoned: false,
        limit: 100,
        cursor: vec![1, 2, 3],
        act_as: None,
    });
    round_trip(&StatementListResponseFrame {
        items: vec![sample_statement_view()],
        next_cursor: Vec::new(),
        cumulative_count: 1,
        is_final: true,
    });

    round_trip(&RelationListFromRequest {
        from_entity: id(50),
        relation_type_filter: "test:knows".to_string(),
        time_range_start_unix_nanos: 1,
        time_range_end_unix_nanos: 100,
        include_superseded: false,
        include_tombstoned: false,
        limit: 100,
        cursor: Vec::new(),
        act_as: None,
    });
    round_trip(&RelationListFromResponseFrame {
        items: vec![sample_relation_view()],
        next_cursor: Vec::new(),
        cumulative_count: 1,
        is_final: true,
    });
    round_trip(&RelationListToRequest {
        to_entity: id(60),
        relation_type_filter: String::new(),
        time_range_start_unix_nanos: 0,
        time_range_end_unix_nanos: 0,
        include_superseded: false,
        include_tombstoned: false,
        limit: 100,
        cursor: Vec::new(),
        act_as: None,
    });
    round_trip(&RelationListToResponseFrame {
        items: vec![sample_relation_view()],
        next_cursor: Vec::new(),
        cumulative_count: 1,
        is_final: true,
    });

    round_trip(&SchemaGetRequest {
        namespace: "people".to_string(),
        version: 0,
    });
    round_trip(&SchemaGetResponse {
        namespace: "people".to_string(),
        schema_version: 2,
        schema_document: "entity Person {}".to_string(),
        source_blob: vec![0x7B, 0x7D],
        uploaded_at_unix_nanos: 1_700_000_000_000_000_000,
        validator_version: 1,
    });
    round_trip(&SchemaListRequest {
        namespace: "people".to_string(),
        limit: 0,
        cursor: Vec::new(),
    });
    round_trip(&SchemaListResponseFrame {
        namespace: "people".to_string(),
        items: vec![SchemaListItemWire {
            schema_version: 2,
            uploaded_at_unix_nanos: 1_700_000_000_000_000_000,
            validator_version: 1,
            has_source_text: true,
        }],
        total: 1,
        next_cursor: Vec::new(),
        is_final: true,
    });
    round_trip(&SchemaValidateRequest {
        schema_document: "entity Person {}".to_string(),
    });
    round_trip(&SchemaValidateResponse {
        namespace: "people".to_string(),
        would_be_version: 3,
        validation_errors: vec![SchemaValidationErrorWire {
            code: "ParseError".to_string(),
            message: "bad".to_string(),
            line: 1,
            column: 2,
            length: 3,
            severity: 2,
        }],
    });
}

async fn serve_read(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // Handshake.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        session_id: [0xAB; 16],
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 1 << 20,
            max_concurrent_streams: 64,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: SERVER_AGENT,
        bound_shard_id: 0,
        permissions: AgentPermissions {
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
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // GET_CAPABILITIES (unary).
    let f = read_frame(&mut sock, &mut buf).await.expect("caps");
    assert_eq!(f.opcode, Opcode::GetCapabilitiesReq as u16);
    write_one(
        &mut sock,
        Opcode::GetCapabilitiesResp,
        f.stream_id,
        &GetCapabilitiesResponse {
            capabilities: Capabilities {
                rerank: true,
                llm_extractor: false,
                classifier_extractor: true,
                pattern_extractor: true,
                schema_namespaces: vec!["people".to_string()],
                vector_dim: 384,
            },
        },
    )
    .await;

    // ENTITY_GET (unary).
    let f = read_frame(&mut sock, &mut buf).await.expect("entity get");
    assert_eq!(f.opcode, Opcode::EntityGetReq as u16);
    write_one(
        &mut sock,
        Opcode::EntityGetResp,
        f.stream_id,
        &EntityGetResponse {
            entity: sample_entity_view(),
        },
    )
    .await;

    // ENTITY_RESOLVE (unary).
    let f = read_frame(&mut sock, &mut buf)
        .await
        .expect("entity resolve");
    assert_eq!(f.opcode, Opcode::EntityResolveReq as u16);
    write_one(
        &mut sock,
        Opcode::EntityResolveResp,
        f.stream_id,
        &EntityResolveResponse {
            outcome: ResolutionOutcomeWire::Resolved,
            tier: 1,
            confidence: 1.0,
            resolved_entity: id(7),
            candidate_ids: Vec::new(),
            audit_id: [0; 16],
        },
    )
    .await;

    // STATEMENT_GET (unary).
    let f = read_frame(&mut sock, &mut buf)
        .await
        .expect("statement get");
    assert_eq!(f.opcode, Opcode::StatementGetReq as u16);
    write_one(
        &mut sock,
        Opcode::StatementGetResp,
        f.stream_id,
        &StatementGetResponse {
            statement: sample_statement_view(),
            returned_via_supersession: false,
        },
    )
    .await;

    // SCHEMA_GET (unary).
    let f = read_frame(&mut sock, &mut buf).await.expect("schema get");
    assert_eq!(f.opcode, Opcode::SchemaGetReq as u16);
    write_one(
        &mut sock,
        Opcode::SchemaGetResp,
        f.stream_id,
        &SchemaGetResponse {
            namespace: "people".to_string(),
            schema_version: 2,
            schema_document: "entity Person {}".to_string(),
            source_blob: vec![],
            uploaded_at_unix_nanos: 1,
            validator_version: 1,
        },
    )
    .await;

    // SCHEMA_VALIDATE (unary).
    let f = read_frame(&mut sock, &mut buf)
        .await
        .expect("schema validate");
    assert_eq!(f.opcode, Opcode::SchemaValidateReq as u16);
    write_one(
        &mut sock,
        Opcode::SchemaValidateResp,
        f.stream_id,
        &SchemaValidateResponse {
            namespace: "people".to_string(),
            would_be_version: 3,
            validation_errors: vec![],
        },
    )
    .await;

    // ENTITY_LIST (streamed: two frames, last is EOS).
    let f = read_frame(&mut sock, &mut buf).await.expect("entity list");
    assert_eq!(f.opcode, Opcode::EntityListReq as u16);
    let mid = Frame::new(
        Opcode::EntityListResp.as_u16(),
        0,
        f.stream_id,
        to_cbor_bytes(&EntityListResponseFrame {
            items: vec![EntityListItem {
                entity: sample_entity_view(),
            }],
            next_cursor: Vec::new(),
            cumulative_count: 1,
            is_final: false,
        }),
    );
    write_frame(&mut sock, &mid).await.expect("write mid");
    write_one(
        &mut sock,
        Opcode::EntityListResp,
        f.stream_id,
        &EntityListResponseFrame {
            items: vec![EntityListItem {
                entity: sample_entity_view(),
            }],
            next_cursor: Vec::new(),
            cumulative_count: 2,
            is_final: true,
        },
    )
    .await;

    // STATEMENT_LIST (streamed: single EOS frame).
    let f = read_frame(&mut sock, &mut buf)
        .await
        .expect("statement list");
    assert_eq!(f.opcode, Opcode::StatementListReq as u16);
    write_one(
        &mut sock,
        Opcode::StatementListResp,
        f.stream_id,
        &StatementListResponseFrame {
            items: vec![sample_statement_view()],
            next_cursor: Vec::new(),
            cumulative_count: 1,
            is_final: true,
        },
    )
    .await;

    // RELATION_LIST_FROM (streamed).
    let f = read_frame(&mut sock, &mut buf).await.expect("rel from");
    assert_eq!(f.opcode, Opcode::RelationListFromReq as u16);
    write_one(
        &mut sock,
        Opcode::RelationListFromResp,
        f.stream_id,
        &RelationListFromResponseFrame {
            items: vec![sample_relation_view()],
            next_cursor: Vec::new(),
            cumulative_count: 1,
            is_final: true,
        },
    )
    .await;

    // RELATION_LIST_TO (streamed).
    let f = read_frame(&mut sock, &mut buf).await.expect("rel to");
    assert_eq!(f.opcode, Opcode::RelationListToReq as u16);
    write_one(
        &mut sock,
        Opcode::RelationListToResp,
        f.stream_id,
        &RelationListToResponseFrame {
            items: vec![sample_relation_view()],
            next_cursor: Vec::new(),
            cumulative_count: 1,
            is_final: true,
        },
    )
    .await;

    // SCHEMA_LIST (streamed).
    let f = read_frame(&mut sock, &mut buf).await.expect("schema list");
    assert_eq!(f.opcode, Opcode::SchemaListReq as u16);
    write_one(
        &mut sock,
        Opcode::SchemaListResp,
        f.stream_id,
        &SchemaListResponseFrame {
            namespace: "people".to_string(),
            items: vec![SchemaListItemWire {
                schema_version: 2,
                uploaded_at_unix_nanos: 1,
                validator_version: 1,
                has_source_text: true,
            }],
            total: 1,
            next_cursor: Vec::new(),
            is_final: true,
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

#[tokio::test]
async fn read_side_verbs_over_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_read(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");

    let caps = client
        .capabilities(&GetCapabilitiesRequest {})
        .await
        .expect("capabilities");
    assert_eq!(caps.capabilities.vector_dim, 384);
    assert!(caps.capabilities.rerank);

    let entity = client
        .get_entity(&EntityGetRequest {
            entity_id: id(7),
            act_as: None,
        })
        .await
        .expect("get_entity");
    assert_eq!(entity.entity.canonical_name, "Alice");

    let resolved = client
        .resolve_entity(&EntityResolveRequest {
            candidate_name: "Alice".to_string(),
            context: String::new(),
            entity_type_hint: 1,
            allow_create: false,
            request_id: id(30),
            act_as: None,
        })
        .await
        .expect("resolve_entity");
    assert_eq!(resolved.outcome, ResolutionOutcomeWire::Resolved);
    assert_eq!(resolved.resolved_entity, id(7));

    let statement = client
        .get_statement(&StatementGetRequest {
            statement_id: id(3),
            follow_supersession: false,
            act_as: None,
        })
        .await
        .expect("get_statement");
    assert_eq!(statement.statement.predicate, "test:role");

    let schema = client
        .get_schema(&SchemaGetRequest {
            namespace: "people".to_string(),
            version: 0,
        })
        .await
        .expect("get_schema");
    assert_eq!(schema.schema_version, 2);

    let validated = client
        .validate_schema(&SchemaValidateRequest {
            schema_document: "entity Person {}".to_string(),
        })
        .await
        .expect("validate_schema");
    assert_eq!(validated.would_be_version, 3);

    // Streamed: flatten + frames pair.
    let entities = client
        .list_entities(&EntityListRequest {
            entity_type_id: 0,
            name_prefix: String::new(),
            mention_count_min: 0,
            include_tombstoned: false,
            include_merged: false,
            limit: 100,
            cursor: Vec::new(),
            act_as: None,
        })
        .await
        .expect("list_entities");
    assert_eq!(entities.len(), 2);

    let statements = client
        .list_statements(&StatementListRequest {
            subject: [0; 16],
            predicate: String::new(),
            kind: 0,
            min_confidence: 0.0,
            time_range_start_unix_nanos: 0,
            time_range_end_unix_nanos: 0,
            only_current: false,
            include_tombstoned: false,
            limit: 100,
            cursor: Vec::new(),
            act_as: None,
        })
        .await
        .expect("list_statements");
    assert_eq!(statements.len(), 1);

    let from = client
        .list_relations_from(&RelationListFromRequest {
            from_entity: id(11),
            relation_type_filter: String::new(),
            time_range_start_unix_nanos: 0,
            time_range_end_unix_nanos: 0,
            include_superseded: false,
            include_tombstoned: false,
            limit: 100,
            cursor: Vec::new(),
            act_as: None,
        })
        .await
        .expect("list_relations_from");
    assert_eq!(from.len(), 1);

    let to = client
        .list_relations_to(&RelationListToRequest {
            to_entity: id(12),
            relation_type_filter: String::new(),
            time_range_start_unix_nanos: 0,
            time_range_end_unix_nanos: 0,
            include_superseded: false,
            include_tombstoned: false,
            limit: 100,
            cursor: Vec::new(),
            act_as: None,
        })
        .await
        .expect("list_relations_to");
    assert_eq!(to.len(), 1);

    let schemas = client
        .list_schemas(&SchemaListRequest {
            namespace: "people".to_string(),
            limit: 0,
            cursor: Vec::new(),
        })
        .await
        .expect("list_schemas");
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0].schema_version, 2);

    client.close().await.expect("bye");
    server.await.expect("server task");
}

// ===========================================================================
// Edge + cognitive verbs: LINK, UNLINK (unary) and PLAN, REASON (streaming).
//
// No conformance corpus golden bytes exist for these ops, so they are
// exercised by CBOR round-trip (encode → decode equality) plus an in-process
// mock server that drives the unary + streamed client verbs.
// ===========================================================================

use brain_db_sdk::wire::types::{
    EdgeKindWire, InferenceKind, InferenceStep, LinkRequest, LinkResponse, ObservationInput,
    PlanBudget, PlanRequest, PlanResponseFrame, PlanState, PlanStatus, PlanStep, PlanStrategy,
    ReasonRequest, ReasonResponseFrame, ReasonStatus, TransitionKind, UnlinkRequest,
    UnlinkResponse,
};

const SOURCE_MEMORY: u128 = 0x1111_2222_3333_4444_5555_6666_7777_8888;
const TARGET_MEMORY: u128 = 0x8888_7777_6666_5555_4444_3333_2222_1111;

#[test]
fn edge_cognitive_types_round_trip() {
    round_trip(&LinkRequest {
        act_as: None,
        source: SOURCE_MEMORY,
        target: TARGET_MEMORY,
        kind: EdgeKindWire::Supports,
        weight: 0.75,
        request_id: id(1),
        txn_id: Some(id(2)),
    });
    round_trip(&LinkResponse {
        source: SOURCE_MEMORY,
        target: TARGET_MEMORY,
        kind: EdgeKindWire::Supports,
        weight: 0.75,
        created_at_unix_nanos: 1_700_000_000_000_000_000,
        already_existed: false,
    });
    round_trip(&UnlinkRequest {
        act_as: None,
        source: SOURCE_MEMORY,
        target: TARGET_MEMORY,
        kind: EdgeKindWire::Contradicts,
        request_id: id(3),
        txn_id: None,
    });
    round_trip(&UnlinkResponse {
        source: SOURCE_MEMORY,
        target: TARGET_MEMORY,
        kind: EdgeKindWire::Contradicts,
        removed: true,
    });

    round_trip(&PlanRequest {
        act_as: None,
        start: PlanState::ByMemoryId(SOURCE_MEMORY),
        goal: PlanState::ByText("arrive at the goal".to_string()),
        budget: PlanBudget {
            max_steps: 16,
            max_wall_time_ms: 5_000,
            max_branches_explored: 256,
        },
        strategy_hint: Some(PlanStrategy::AStar),
        context_filter: Some(vec![1, 2, 3]),
        request_id: Some(id(4)),
        txn_id: None,
    });
    round_trip(&PlanRequest {
        act_as: None,
        start: PlanState::ByVector {
            offset: 0,
            dim: 384,
        },
        goal: PlanState::ByMemoryId(TARGET_MEMORY),
        budget: PlanBudget {
            max_steps: 1,
            max_wall_time_ms: 1,
            max_branches_explored: 1,
        },
        strategy_hint: None,
        context_filter: None,
        request_id: None,
        txn_id: Some(id(5)),
    });
    round_trip(&PlanResponseFrame {
        steps: vec![PlanStep {
            step_index: 0,
            memory_id: SOURCE_MEMORY,
            text: "first move".to_string(),
            transition_kind: TransitionKind::Initial,
            confidence: 0.9,
            estimated_distance_to_goal: 3.5,
        }],
        is_final: true,
        plan_status: Some(PlanStatus::GoalReached),
    });
    round_trip(&PlanStep {
        step_index: 1,
        memory_id: TARGET_MEMORY,
        text: "second move".to_string(),
        transition_kind: TransitionKind::Other("teleport".to_string()),
        confidence: 0.5,
        estimated_distance_to_goal: 0.0,
    });

    round_trip(&ReasonRequest {
        act_as: None,
        observation: ObservationInput::ByText("the lights are off".to_string()),
        depth: 4,
        confidence_threshold: 0.6,
        context_filter: Some(vec![7]),
        max_inferences: 32,
        budget_wall_time_ms: 2_000,
        request_id: Some(id(6)),
        txn_id: None,
    });
    round_trip(&ReasonRequest {
        act_as: None,
        observation: ObservationInput::ByMemoryId(SOURCE_MEMORY),
        depth: 0,
        confidence_threshold: 0.0,
        context_filter: None,
        max_inferences: 1,
        budget_wall_time_ms: 1,
        request_id: None,
        txn_id: Some(id(7)),
    });
    round_trip(&ReasonResponseFrame {
        inferences: vec![InferenceStep {
            step_index: 0,
            claim: "someone left".to_string(),
            supporting_memories: vec![SOURCE_MEMORY],
            contradicting_memories: vec![TARGET_MEMORY],
            confidence: 0.8,
            inference_kind: InferenceKind::CausalExplanation,
        }],
        is_final: true,
        reason_status: Some(ReasonStatus::Complete),
    });
    round_trip(&InferenceStep {
        step_index: 1,
        claim: "by analogy".to_string(),
        supporting_memories: vec![],
        contradicting_memories: vec![],
        confidence: 0.4,
        inference_kind: InferenceKind::Other("intuition".to_string()),
    });
}

async fn serve_edge_cognitive(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // Handshake.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        session_id: [0xAB; 16],
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 1 << 20,
            max_concurrent_streams: 64,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: SERVER_AGENT,
        bound_shard_id: 0,
        permissions: AgentPermissions {
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
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // LINK (unary).
    let f = read_frame(&mut sock, &mut buf).await.expect("link");
    assert_eq!(f.opcode, Opcode::LinkReq as u16);
    let req: LinkRequest = from_cbor_bytes(&f.payload).expect("decode link");
    assert_eq!(req.kind, EdgeKindWire::Supports);
    write_one(
        &mut sock,
        Opcode::LinkResp,
        f.stream_id,
        &LinkResponse {
            source: req.source,
            target: req.target,
            kind: req.kind,
            weight: req.weight,
            created_at_unix_nanos: 42,
            already_existed: false,
        },
    )
    .await;

    // UNLINK (unary).
    let f = read_frame(&mut sock, &mut buf).await.expect("unlink");
    assert_eq!(f.opcode, Opcode::UnlinkReq as u16);
    let req: UnlinkRequest = from_cbor_bytes(&f.payload).expect("decode unlink");
    assert_eq!(req.kind, EdgeKindWire::Contradicts);
    write_one(
        &mut sock,
        Opcode::UnlinkResp,
        f.stream_id,
        &UnlinkResponse {
            source: req.source,
            target: req.target,
            kind: req.kind,
            removed: true,
        },
    )
    .await;

    // PLAN (streamed: two frames, last is EOS).
    let f = read_frame(&mut sock, &mut buf).await.expect("plan");
    assert_eq!(f.opcode, Opcode::PlanReq as u16);
    let req: PlanRequest = from_cbor_bytes(&f.payload).expect("decode plan");
    assert_eq!(req.budget.max_steps, 16);
    let mid = Frame::new(
        Opcode::PlanResp.as_u16(),
        0,
        f.stream_id,
        to_cbor_bytes(&PlanResponseFrame {
            steps: vec![PlanStep {
                step_index: 0,
                memory_id: SOURCE_MEMORY,
                text: "step 0".to_string(),
                transition_kind: TransitionKind::Initial,
                confidence: 1.0,
                estimated_distance_to_goal: 2.0,
            }],
            is_final: false,
            plan_status: None,
        }),
    );
    write_frame(&mut sock, &mid).await.expect("write plan mid");
    write_one(
        &mut sock,
        Opcode::PlanResp,
        f.stream_id,
        &PlanResponseFrame {
            steps: vec![PlanStep {
                step_index: 1,
                memory_id: TARGET_MEMORY,
                text: "step 1".to_string(),
                transition_kind: TransitionKind::Causal,
                confidence: 0.9,
                estimated_distance_to_goal: 0.0,
            }],
            is_final: true,
            plan_status: Some(PlanStatus::GoalReached),
        },
    )
    .await;

    // REASON (streamed: single EOS frame).
    let f = read_frame(&mut sock, &mut buf).await.expect("reason");
    assert_eq!(f.opcode, Opcode::ReasonReq as u16);
    let req: ReasonRequest = from_cbor_bytes(&f.payload).expect("decode reason");
    assert_eq!(req.depth, 4);
    write_one(
        &mut sock,
        Opcode::ReasonResp,
        f.stream_id,
        &ReasonResponseFrame {
            inferences: vec![
                InferenceStep {
                    step_index: 0,
                    claim: "claim a".to_string(),
                    supporting_memories: vec![SOURCE_MEMORY],
                    contradicting_memories: vec![],
                    confidence: 0.8,
                    inference_kind: InferenceKind::CausalExplanation,
                },
                InferenceStep {
                    step_index: 1,
                    claim: "claim b".to_string(),
                    supporting_memories: vec![],
                    contradicting_memories: vec![TARGET_MEMORY],
                    confidence: 0.6,
                    inference_kind: InferenceKind::EvidenceAccumulation,
                },
            ],
            is_final: true,
            reason_status: Some(ReasonStatus::Complete),
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

#[tokio::test]
async fn edge_cognitive_verbs_over_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_edge_cognitive(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");

    let linked = client
        .link(&LinkRequest {
            act_as: None,
            source: SOURCE_MEMORY,
            target: TARGET_MEMORY,
            kind: EdgeKindWire::Supports,
            weight: 0.75,
            request_id: rid(),
            txn_id: None,
        })
        .await
        .expect("link");
    assert_eq!(linked.created_at_unix_nanos, 42);
    assert!(!linked.already_existed);

    let unlinked = client
        .unlink(&UnlinkRequest {
            act_as: None,
            source: SOURCE_MEMORY,
            target: TARGET_MEMORY,
            kind: EdgeKindWire::Contradicts,
            request_id: rid(),
            txn_id: None,
        })
        .await
        .expect("unlink");
    assert!(unlinked.removed);

    // PLAN: flattened (steps across both frames) + frames pair.
    let plan_req = PlanRequest {
        act_as: None,
        start: PlanState::ByMemoryId(SOURCE_MEMORY),
        goal: PlanState::ByMemoryId(TARGET_MEMORY),
        budget: PlanBudget {
            max_steps: 16,
            max_wall_time_ms: 5_000,
            max_branches_explored: 256,
        },
        strategy_hint: Some(PlanStrategy::Auto),
        context_filter: None,
        request_id: Some(rid()),
        txn_id: None,
    };
    let steps = client.plan(&plan_req).await.expect("plan");
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].step_index, 0);
    assert_eq!(steps[1].step_index, 1);

    // REASON: flattened (inferences in the single frame).
    let inferences = client
        .reason(&ReasonRequest {
            act_as: None,
            observation: ObservationInput::ByText("the lights are off".to_string()),
            depth: 4,
            confidence_threshold: 0.6,
            context_filter: None,
            max_inferences: 32,
            budget_wall_time_ms: 2_000,
            request_id: Some(rid()),
            txn_id: None,
        })
        .await
        .expect("reason");
    assert_eq!(inferences.len(), 2);
    assert_eq!(inferences[0].claim, "claim a");
    assert_eq!(inferences[1].claim, "claim b");

    client.close().await.expect("bye");
    server.await.expect("server task");
}

// ===========================================================================
// TXN: TXN_BEGIN, TXN_COMMIT, TXN_ABORT (all unary).
//
// No conformance corpus golden bytes exist for these ops, so they are
// exercised by CBOR round-trip plus an in-process mock server driving the
// three unary client verbs.
// ===========================================================================

use brain_db_sdk::wire::types::{
    TxnAbortRequest, TxnAbortResponse, TxnBeginRequest, TxnBeginResponse, TxnCommitRequest,
    TxnCommitResponse,
};

const TXN_ID: [u8; 16] = [0x44; 16];

#[test]
fn txn_types_round_trip() {
    round_trip(&TxnBeginRequest {
        txn_id: TXN_ID,
        timeout_seconds: 30,
    });
    round_trip(&TxnBeginResponse {
        txn_id: TXN_ID,
        timeout_seconds: 30,
        started_at_unix_nanos: 1_700_000_000_000_000_000,
    });
    round_trip(&TxnCommitRequest { txn_id: TXN_ID });
    round_trip(&TxnCommitResponse {
        txn_id: TXN_ID,
        committed_at_unix_nanos: 1_700_000_001_000_000_000,
        operations_applied: 3,
    });
    round_trip(&TxnAbortRequest { txn_id: TXN_ID });
    round_trip(&TxnAbortResponse {
        txn_id: TXN_ID,
        operations_discarded: 2,
    });
}

async fn serve_txn(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // Handshake.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        session_id: [0xAB; 16],
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 1 << 20,
            max_concurrent_streams: 64,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: SERVER_AGENT,
        bound_shard_id: 0,
        permissions: AgentPermissions {
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
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // TXN_BEGIN.
    let f = read_frame(&mut sock, &mut buf).await.expect("begin");
    assert_eq!(f.opcode, Opcode::TxnBegin as u16);
    let req: TxnBeginRequest = from_cbor_bytes(&f.payload).expect("decode begin");
    assert_eq!(req.timeout_seconds, 30);
    write_one(
        &mut sock,
        Opcode::TxnBeginResp,
        f.stream_id,
        &TxnBeginResponse {
            txn_id: req.txn_id,
            timeout_seconds: req.timeout_seconds,
            started_at_unix_nanos: 99,
        },
    )
    .await;

    // TXN_COMMIT.
    let f = read_frame(&mut sock, &mut buf).await.expect("commit");
    assert_eq!(f.opcode, Opcode::TxnCommit as u16);
    let req: TxnCommitRequest = from_cbor_bytes(&f.payload).expect("decode commit");
    write_one(
        &mut sock,
        Opcode::TxnCommitResp,
        f.stream_id,
        &TxnCommitResponse {
            txn_id: req.txn_id,
            committed_at_unix_nanos: 123,
            operations_applied: 5,
        },
    )
    .await;

    // TXN_ABORT.
    let f = read_frame(&mut sock, &mut buf).await.expect("abort");
    assert_eq!(f.opcode, Opcode::TxnAbort as u16);
    let req: TxnAbortRequest = from_cbor_bytes(&f.payload).expect("decode abort");
    write_one(
        &mut sock,
        Opcode::TxnAbortResp,
        f.stream_id,
        &TxnAbortResponse {
            txn_id: req.txn_id,
            operations_discarded: 7,
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

#[tokio::test]
async fn txn_verbs_over_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_txn(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");

    let begun = client
        .txn_begin(&TxnBeginRequest {
            txn_id: TXN_ID,
            timeout_seconds: 30,
        })
        .await
        .expect("txn_begin");
    assert_eq!(begun.txn_id, TXN_ID);
    assert_eq!(begun.started_at_unix_nanos, 99);

    let committed = client
        .txn_commit(&TxnCommitRequest { txn_id: TXN_ID })
        .await
        .expect("txn_commit");
    assert_eq!(committed.operations_applied, 5);

    let aborted = client
        .txn_abort(&TxnAbortRequest { txn_id: TXN_ID })
        .await
        .expect("txn_abort");
    assert_eq!(aborted.operations_discarded, 7);

    client.close().await.expect("bye");
    server.await.expect("server task");
}
