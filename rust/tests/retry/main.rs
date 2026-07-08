//! Retry combinator integration test: a server that returns a retryable
//! `ResourceExhausted` ERROR once, then succeeds, is recovered transparently
//! by `with_retry` wrapping a verb call — and the same `request_id` is resent
//! both times (idempotent retry).

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AgentPermissions, AuthOkPayload, AuthPayload, ErrorCategoryWire, ErrorCodeWire, ErrorResponse,
    ForgetRequest, ForgetResponse, HelloPayload, ServerFeatures, WelcomePayload,
};
use brain_db_sdk::{with_retry, Auth, BrainClient, ForgetBuilder, RetryPolicy};

/// The agent id the mock server assigns from the credential.
const SERVER_AGENT: [u8; 16] = [0x22; 16];

/// Handshake, then a FORGET that errors once (ResourceExhausted) and succeeds
/// on the retry. Asserts both FORGET frames carried the same `request_id`.
async fn serve_forget_then_recover(mut sock: TcpStream) {
    let mut buf = Vec::new();

    let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
    let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
    let welcome = WelcomePayload {
        server_id: "mock-brain".to_string(),
        chosen_version: 1,
        session_id: [0xEE; 16],
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

    // First FORGET -> retryable ERROR (with a short server retry_after).
    let first = read_frame(&mut sock, &mut buf).await.expect("forget 1");
    assert_eq!(first.opcode, Opcode::ForgetReq as u16);
    let first_req: ForgetRequest = from_cbor_bytes(&first.payload).expect("decode forget 1");
    let err = ErrorResponse {
        code: ErrorCodeWire::RateLimited,
        category: ErrorCategoryWire::ResourceExhausted,
        message: "slow down".to_string(),
        details: None,
        retry_after_ms: Some(5),
    };
    write_streamed(&mut sock, Opcode::Error, first.stream_id, &err, true).await;

    // Second FORGET (the retry) -> success. Same request_id proves idempotency.
    let second = read_frame(&mut sock, &mut buf).await.expect("forget 2");
    assert_eq!(second.opcode, Opcode::ForgetReq as u16);
    let second_req: ForgetRequest = from_cbor_bytes(&second.payload).expect("decode forget 2");
    assert_eq!(
        first_req.request_id, second_req.request_id,
        "retry must resend the same request_id (idempotent)"
    );
    let resp = ForgetResponse {
        memory_id: second_req.memory_id,
        was_already_forgotten: false,
        edges_removed: 1,
    };
    write_one(&mut sock, Opcode::ForgetResp, second.stream_id, &resp).await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
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
async fn with_retry_recovers_a_resource_exhausted_forget() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_forget_then_recover(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");

    // One stable request so the retry resends the same request_id. Now that the
    // verbs take `&self`, the free `with_retry` combinator wraps them directly.
    let req = ForgetBuilder::new(0xBEEF).build();
    let policy = RetryPolicy::new(3, std::time::Duration::ZERO, std::time::Duration::ZERO);
    let resp = with_retry(&policy, || client.forget(&req))
        .await
        .expect("forget should recover on retry");
    assert_eq!(resp.memory_id, 0xBEEF);
    assert_eq!(resp.edges_removed, 1);

    client.close().await.expect("bye");
    server.await.expect("server task");
}

#[tokio::test]
async fn with_retry_gives_up_and_surfaces_the_server_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut sock, _peer) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();

        let hello_frame = read_frame(&mut sock, &mut buf).await.expect("hello");
        let hello: HelloPayload = from_cbor_bytes(&hello_frame.payload).expect("decode hello");
        let welcome = WelcomePayload {
            server_id: "mock-brain".to_string(),
            chosen_version: 1,
            session_id: [0u8; 16],
            capabilities: hello.capabilities,
            server_features: ServerFeatures {
                max_payload_size: 0,
                max_concurrent_streams: 0,
                idle_timeout_seconds: 0,
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

        // Every FORGET errors (retryable). The client exhausts its attempts.
        loop {
            let Ok(frame) = read_frame(&mut sock, &mut buf).await else {
                return;
            };
            if frame.opcode == Opcode::Bye as u16 {
                return;
            }
            let err = ErrorResponse {
                code: ErrorCodeWire::Overloaded,
                category: ErrorCategoryWire::Unavailable,
                message: "busy".to_string(),
                details: None,
                retry_after_ms: None,
            };
            write_streamed(&mut sock, Opcode::Error, frame.stream_id, &err, true).await;
        }
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec())).await.expect("connect");
    let req = ForgetBuilder::new(1).build();
    let policy = RetryPolicy::new(2, std::time::Duration::ZERO, std::time::Duration::ZERO);
    let result = with_retry(&policy, || client.forget(&req)).await;
    assert!(
        matches!(
            result,
            Err(brain_db_sdk::BrainError::Server {
                category: ErrorCategoryWire::Unavailable,
                ..
            })
        ),
        "after exhausting attempts the last server error surfaces"
    );

    client.close().await.expect("bye");
}
