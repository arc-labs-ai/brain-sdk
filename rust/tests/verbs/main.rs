//! Verb round-trip tests: RECALL streaming and FORGET against an in-process
//! mock server, plus the ergonomic builders' defaults.
//!
//! RECALL is the streaming case: the mock server replies with two
//! `RECALL_RESP` frames on the request's stream, the first without EOS and the
//! second with it, and the client must collect both and flatten their results.

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AnswerKindWire, AuthOkPayload, AuthPayload, ForgetRequest, ForgetResponse, HelloPayload,
    MemoryKindWire, MemoryResult, RecallRequest, RecallResponseFrame, ServerFeatures,
    SpacePermissions, WelcomePayload,
};
use brain_db_sdk::{Auth, BrainClient, ForgetBuilder, RecallBuilder};

/// The agent id the mock server assigns from the credential.
const SERVER_AGENT: [u8; 16] = [0x22; 16];

/// Drive the handshake, then one RECALL (two streamed frames) and one FORGET.
async fn serve_recall_forget(mut sock: TcpStream) {
    let mut buf = Vec::new();

    // Handshake.
    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        connection_id: [0xCD; 16],
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
        space_id: SERVER_AGENT,
        bound_shard_id: 0,
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
        server_time_unix_nanos: 1,
    };
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // RECALL: two streamed frames, EOS only on the second.
    let recall_frame = read_frame(&mut sock, &mut buf).await.expect("recall");
    assert_eq!(recall_frame.opcode, Opcode::RecallReq as u16);
    let recall: RecallRequest = from_cbor_bytes(&recall_frame.payload).expect("decode recall");
    assert_eq!(recall.cue_text, "dark mode");
    let sid = recall_frame.stream_id;

    let first = RecallResponseFrame {
        answer_kind: AnswerKindWire::Many,
        memories: vec![sample_result(0xAA, "first hit")],
        is_final: false,
        cumulative_count: 1,
        estimated_remaining: Some(1),
        trace: None,
    };
    write_streamed(&mut sock, Opcode::RecallResp, sid, &first, false).await;

    let second = RecallResponseFrame {
        answer_kind: AnswerKindWire::Many,
        memories: vec![sample_result(0xBB, "second hit")],
        is_final: true,
        cumulative_count: 2,
        estimated_remaining: Some(0),
        trace: None,
    };
    write_streamed(&mut sock, Opcode::RecallResp, sid, &second, true).await;

    // FORGET: single frame.
    let forget_frame = read_frame(&mut sock, &mut buf).await.expect("forget");
    assert_eq!(forget_frame.opcode, Opcode::ForgetReq as u16);
    let forget: ForgetRequest = from_cbor_bytes(&forget_frame.payload).expect("decode forget");
    let resp = ForgetResponse {
        memory_id: forget.memory_id,
        was_already_forgotten: false,
        edges_removed: 3,
    };
    write_one(&mut sock, Opcode::ForgetResp, forget_frame.stream_id, &resp).await;

    // BYE.
    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

fn sample_result(tag: u8, text: &str) -> MemoryResult {
    MemoryResult {
        memory_id: u128::from(tag),
        text: text.to_string(),
        similarity_score: 0.9,
        confidence: 0.8,
        salience: 0.5,
        kind: MemoryKindWire::Semantic,
        space_id: [tag; 16],
        session_id: 0,
        created_at_unix_nanos: 1,
        last_accessed_at_unix_nanos: 1,
        edges: None,
        contributing_retrievers: vec![],
        fused_score: 0.7,
        rerank_score: None,
        salience_initial: 0.5,
        access_count: 0,
        lsn: 1,
        flags: 0,
        consolidated_at_unix_nanos: None,
        occurred_at_unix_nanos: None,
        edges_out_count: 0,
        edges_in_count: 0,
        graph: None,
    }
}

async fn write_one<T: serde::Serialize>(sock: &mut TcpStream, op: Opcode, sid: u32, p: &T) {
    write_streamed(sock, op, sid, p, true).await;
}

async fn write_streamed<T: serde::Serialize>(
    sock: &mut TcpStream,
    op: Opcode,
    sid: u32,
    p: &T,
    eos: bool,
) {
    let flags = if eos { FLAG_EOS } else { 0 };
    let frame = Frame::new(op.as_u16(), flags, sid, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

#[tokio::test]
async fn recall_streams_and_flattens_then_forget() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_recall_forget(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec()))
        .await
        .expect("connect");

    // RECALL: builder defaults + the two streamed frames flatten in order.
    let answer = client
        .recall(&RecallBuilder::new("dark mode").max_results(5).build())
        .await
        .expect("recall");
    assert_eq!(answer.answer_kind, AnswerKindWire::Many);
    assert_eq!(answer.memories.len(), 2);
    assert_eq!(answer.memories[0].text, "first hit");
    assert_eq!(answer.memories[1].text, "second hit");

    // FORGET via the builder.
    let resp = client
        .forget(&ForgetBuilder::new(0xAA).build())
        .await
        .expect("forget");
    assert_eq!(resp.memory_id, 0xAA);
    assert_eq!(resp.edges_removed, 3);

    client.close().await.expect("bye");
    server.await.expect("server task");
}

#[test]
fn builder_defaults_are_sane() {
    let recall = RecallBuilder::new("hi").build();
    assert_eq!(recall.max_results, 10);
    assert!(recall.include_text);
    assert!(recall.include_edges);
    assert!(recall.request_id.is_some());

    let forget = ForgetBuilder::new(7).build();
    assert_eq!(forget.memory_id, 7);
    // Soft by default; .hard() flips it.
    let hard = ForgetBuilder::new(7).hard().build();
    assert_ne!(
        format!("{:?}", forget.mode),
        format!("{:?}", hard.mode),
        "hard() must change the mode"
    );
}
