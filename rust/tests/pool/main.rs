//! Connection-pool integration test: a pool of 3 opens 3 independent sockets,
//! and round-robin `get()` spreads requests across all three. The mock server
//! tags each accepted connection with its accept order and echoes that tag as
//! the ENCODE response's `memory_id`, so the client can prove which socket
//! served each request — three round-robin encodes must touch all three.

use std::collections::HashSet;

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AgentPermissions, AuthOkPayload, AuthPayload, EncodeRequest, EncodeResponse, HelloPayload,
    MemoryKindWire, ServerFeatures, WaitMode, WelcomePayload,
};
use brain_db_sdk::{new_id, Auth, Pool};

/// The agent id the mock server assigns from the credential.
const SERVER_AGENT: [u8; 16] = [0x22; 16];

async fn write_one<T: serde::Serialize>(sock: &mut TcpStream, op: Opcode, sid: u32, p: &T) {
    let frame = Frame::new(op.as_u16(), FLAG_EOS, sid, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

/// Serve one pooled connection: handshake, then answer every ENCODE with a
/// response whose `memory_id` is this connection's accept-order `tag` — so the
/// client can tell the sockets apart.
async fn serve_member(mut sock: TcpStream, tag: u128) {
    let mut buf = Vec::new();

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
            can_admin: false,
        },
        namespace: String::new(),
        server_time_unix_nanos: 1,
    };
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // Answer ENCODEs (tagged with this socket's id) until the peer goes away.
    loop {
        let frame = match read_frame(&mut sock, &mut buf).await {
            Ok(f) => f,
            Err(_) => return,
        };
        if frame.opcode == Opcode::Bye as u16 {
            return;
        }
        if frame.opcode != Opcode::EncodeReq as u16 {
            continue;
        }
        let req: EncodeRequest = from_cbor_bytes(&frame.payload).expect("decode encode");
        let resp = EncodeResponse {
            memory_id: tag,
            was_deduplicated: false,
            salience: 0.5,
            auto_edges_added: 0,
            lsn: 1,
            agent_id: SERVER_AGENT,
            context_id: req.context_id,
            kind: MemoryKindWire::Semantic,
            created_at_unix_nanos: 1,
            edges_out_count: 0,
            embedding_model_fp: [0; 16],
            pending_stages: vec![],
            has_active_schema: true,
            trace: None,
        };
        write_one(&mut sock, Opcode::EncodeResp, frame.stream_id, &resp).await;
    }
}

fn request() -> EncodeRequest {
    EncodeRequest {
        act_as: None,
        text: "pooled".to_string(),
        context_id: 1,
        request_id: new_id(),
        txn_id: None,
        occurred_at_unix_nanos: None,
        wait: WaitMode::Ack,
        allow_duplicates: false,
    }
}

#[tokio::test]
async fn pool_spreads_requests_across_all_members() {
    const SIZE: usize = 3;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");

    // Accept SIZE connections, tagging each with its accept order.
    let server = tokio::spawn(async move {
        for tag in 0..SIZE as u128 {
            let (sock, _peer) = listener.accept().await.expect("accept");
            tokio::spawn(serve_member(sock, tag));
        }
    });

    let pool = Pool::connect(addr, SIZE, Auth::Token(b"test-token".to_vec())).await.expect("pool connect");
    assert_eq!(pool.size(), SIZE);

    // Three round-robin encodes should touch three distinct sockets, so the
    // returned memory_ids (each the serving socket's tag) cover {0, 1, 2}.
    let mut seen = HashSet::new();
    for _ in 0..SIZE {
        let client = pool.get();
        let resp = client.encode(&request()).await.expect("encode");
        seen.insert(resp.memory_id);
    }
    assert_eq!(
        seen,
        (0..SIZE as u128).collect::<HashSet<_>>(),
        "round-robin must spread across every pooled socket"
    );

    server.await.expect("server task");
}

#[tokio::test]
async fn pool_rejects_zero_size() {
    // 127.0.0.1:1 is never connected to — the size check fires before any I/O.
    // `Pool` isn't `Debug` (it holds a live connection), so match rather than
    // `expect_err`.
    let addr = "127.0.0.1:1".parse().expect("addr");
    match Pool::connect(addr, 0, Auth::Token(b"test-token".to_vec())).await {
        Err(brain_db_sdk::BrainError::Protocol(_)) => {}
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("zero size should be rejected"),
    }
}
