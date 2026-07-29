//! Handshake + round-trip integration tests.
//!
//! The default test stands up an in-process mock server on a loopback socket
//! that speaks the server side of the protocol (HELLO -> WELCOME -> AUTH ->
//! AUTH_OK, then one ENCODE -> ENCODE_RESP, then BYE) and drives a real
//! [`BrainClient`] against it — exercising the TCP connect, transport,
//! handshake, and request/response paths without needing a Linux
//! `brain-server`.
//!
//! The live-server counterparts live in `main.rs` and go through the
//! `BRAIN_SDK_IT_*` harness, which mints a real data-plane key.

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AuthOkPayload, AuthPayload, EncodeRequest, EncodeResponse, HelloPayload, MemoryKindWire,
    ServerFeatures, SpacePermissions, StageKind, WaitMode, WelcomePayload,
};
use brain_db_sdk::{new_id, Auth, BrainClient, BrainError};

const SESSION_ID: [u8; 16] = [0xAB; 16];
/// The agent id the mock server assigns from the credential. The client never
/// claims an identity any more.
const SERVER_AGENT: [u8; 16] = [0x22; 16];
const MEMORY_ID: u128 = 0x0102_0304_0506_0708_090A_0B0C_0D0E_0F10;

/// The server side of the protocol for one connection, as a test double.
async fn serve_one(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // HELLO -> WELCOME.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("read hello");
    assert_eq!(hello_frame.opcode, Opcode::Hello as u16);
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    assert!(hello.supported_versions.contains(&1));

    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        connection_id: SESSION_ID,
        capabilities: hello.capabilities,
        server_features: ServerFeatures {
            max_payload_size: 16 * 1024 * 1024,
            max_concurrent_streams: 256,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_payload(&mut sock, Opcode::Welcome, 0, &welcome).await;

    // AUTH -> AUTH_OK (echo the agent id the client presented).
    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("read auth");
    assert_eq!(auth_frame.opcode, Opcode::Auth as u16);
    let _auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");

    let auth_ok = AuthOkPayload {
        space_id: SERVER_AGENT,
        bound_shard_id: 3,
        permissions: SpacePermissions {
            can_act_as: false,
            can_encode: true,
            can_recall: true,
            can_plan: true,
            can_reason: true,
            can_forget: true,
            can_admin: false,
        },
        namespace: String::new(),
        server_time_unix_nanos: 1_700_000_000_000_000_000,
    };
    write_payload(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // ENCODE -> ENCODE_RESP on the request's stream id.
    let enc_frame = read_frame(&mut sock, &mut buf).await.expect("read encode");
    assert_eq!(enc_frame.opcode, Opcode::EncodeReq as u16);
    let enc: EncodeRequest = from_cbor_bytes(&enc_frame.payload).expect("decode encode");

    let resp = EncodeResponse {
        memory_id: MEMORY_ID,
        was_deduplicated: false,
        salience: 0.75,
        auto_edges_added: 0,
        lsn: 42,
        space_id: SERVER_AGENT,
        session_id: enc.session_id,
        kind: MemoryKindWire::Semantic,
        created_at_unix_nanos: 1_700_000_000_000_000_001,
        edges_out_count: 0,
        embedding_model_fp: [0x22; 16],
        pending_stages: vec![StageKind::AutoEdge, StageKind::Extractor],
        has_active_schema: true,
        trace: None,
    };
    write_payload_stream(&mut sock, Opcode::EncodeResp, enc_frame.stream_id, &resp).await;

    // BYE ends the session.
    let bye = read_frame(&mut sock, &mut buf).await.expect("read bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

async fn write_payload<T: serde::Serialize>(
    sock: &mut TcpStream,
    op: Opcode,
    stream_id: u32,
    p: &T,
) {
    write_payload_stream(sock, op, stream_id, p).await;
}

async fn write_payload_stream<T: serde::Serialize>(
    sock: &mut TcpStream,
    op: Opcode,
    stream_id: u32,
    p: &T,
) {
    let frame = Frame::new(op.as_u16(), FLAG_EOS, stream_id, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

fn sample_encode_request() -> EncodeRequest {
    EncodeRequest {
        act_as: None,
        text: "the user prefers dark mode".to_string(),
        session_id: 9,
        request_id: new_id(),
        txn_id: None,
        occurred_at_unix_nanos: None,
        wait: WaitMode::Ack,
        allow_duplicates: false,
    }
}

#[tokio::test]
async fn connect_handshake_encode_round_trip_against_mock_server() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");

    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_one(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec()))
        .await
        .expect("connect");

    let session = client.connection();
    assert_eq!(session.chosen_version, 1);
    assert_eq!(session.server_id, "mock-brain");
    assert_eq!(session.bound_shard_id, 3);
    assert_eq!(session.connection_id, SESSION_ID);
    assert!(session.permissions.can_encode);
    assert!(!session.permissions.can_admin);
    assert_eq!(session.server_features.max_concurrent_streams, 256);

    let req = sample_encode_request();
    let resp = client.encode(&req).await.expect("encode");
    assert_eq!(resp.memory_id, MEMORY_ID);
    assert_eq!(resp.lsn, 42);
    assert_eq!(resp.session_id, req.session_id);
    assert_eq!(resp.space_id, client.space_id());
    assert_eq!(
        resp.pending_stages,
        vec![StageKind::AutoEdge, StageKind::Extractor]
    );

    client.close().await.expect("bye");
    server.await.expect("server task");
}

#[tokio::test]
async fn rejects_a_server_that_chooses_an_unoffered_version() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");

    tokio::spawn(async move {
        let (mut sock, _peer) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        let hello_frame = read_frame(&mut sock, &mut buf).await.expect("read hello");
        let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
        // Choose a version the client never offered.
        let welcome = WelcomePayload {
            server_id: "mock-brain".to_string(),
            chosen_version: 99,
            connection_id: [0u8; 16],
            capabilities: hello.capabilities,
            server_features: ServerFeatures {
                max_payload_size: 0,
                max_concurrent_streams: 0,
                idle_timeout_seconds: 0,
                auth_methods: vec![],
            },
        };
        let frame = Frame::new(
            Opcode::Welcome.as_u16(),
            FLAG_EOS,
            0,
            to_cbor_bytes(&welcome),
        );
        write_frame(&mut sock, &frame).await.expect("write welcome");
    });

    // BrainClient has no Debug, so match the error rather than `expect_err`.
    match BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await {
        Err(BrainError::VersionMismatch { chosen, .. }) => assert_eq!(chosen, 99),
        Err(other) => panic!("expected VersionMismatch, got {other:?}"),
        Ok(_) => panic!("expected the handshake to be rejected"),
    }
}
