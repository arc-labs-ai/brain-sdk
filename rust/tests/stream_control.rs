//! SCHEMA_REPLACE and CANCEL_STREAM round-trips against an in-process mock
//! server.
//!
//! These two verbs are NOT in the vendored conformance corpus — it ships
//! vectors for 38 cases and neither of these is among them — so unlike the
//! rest of the wire surface they have no byte-level drift guard. Until Brain
//! regenerates the corpus with them, these tests are the only thing pinning
//! their opcodes and payload shapes, which is why they assert the numeric
//! opcode explicitly rather than trusting the enum.

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AuthOkPayload, AuthPayload, CancelStreamAck, CancelStreamRequest, CancellationReason,
    HelloPayload, SchemaReplaceRequest, SchemaReplaceResponse, ServerFeatures, SpacePermissions,
    WelcomePayload,
};
use brain_db_sdk::{Auth, BrainClient};

const SERVER_AGENT: [u8; 16] = [0x22; 16];
const REQUEST_ID: [u8; 16] = [0x44; 16];
/// The stream the client asks the server to stop.
const TARGET_STREAM: u32 = 7;

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

    // SCHEMA_REPLACE.
    let f = read_frame(&mut sock, &mut buf)
        .await
        .expect("schema replace");
    assert_eq!(f.opcode, 0x0127, "SCHEMA_REPLACE opcode");
    let req: SchemaReplaceRequest = from_cbor_bytes(&f.payload).expect("decode replace");
    assert_eq!(req.schema_document, "entity Person {}");
    assert!(
        req.force_drop_existing,
        "the SDK must not send force_drop_existing=false — the server rejects it"
    );
    write_one(
        &mut sock,
        Opcode::SchemaReplaceResp,
        f.stream_id,
        &SchemaReplaceResponse {
            namespace: "app".to_string(),
            schema_version: 4,
            dropped_count: 129,
            validation_errors: vec![],
        },
    )
    .await;

    // CANCEL_STREAM. Travels on its own stream id, naming another in the body.
    let f = read_frame(&mut sock, &mut buf).await.expect("cancel");
    assert_eq!(f.opcode, 0x0050, "CANCEL_STREAM opcode");
    let req: CancelStreamRequest = from_cbor_bytes(&f.payload).expect("decode cancel");
    assert_eq!(req.target_stream_id, TARGET_STREAM);
    assert_eq!(req.reason, CancellationReason::ClientUnneeded);
    assert_ne!(
        f.stream_id, TARGET_STREAM,
        "cancel must not ride the stream it is cancelling, or it queues behind \
         the very frames it is trying to stop"
    );
    write_one(
        &mut sock,
        Opcode::CancelStreamAck,
        f.stream_id,
        &CancelStreamAck {
            target_stream_id: TARGET_STREAM,
            cancelled_at_unix_nanos: 1234,
        },
    )
    .await;

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

#[tokio::test]
async fn schema_replace_and_cancel_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve(sock).await;
    });

    let client = BrainClient::connect(addr, Auth::Token(b"test-token".to_vec()))
        .await
        .expect("connect");

    let replaced = client
        .replace_schema(&SchemaReplaceRequest {
            schema_document: "entity Person {}".to_string(),
            force_drop_existing: true,
            request_id: REQUEST_ID,
        })
        .await
        .expect("replace_schema");
    assert_eq!(replaced.schema_version, 4);
    assert_eq!(
        replaced.dropped_count, 129,
        "dropped_count is the whole point of the verb — it is how a caller \
         learns how much the swap destroyed"
    );

    let ack = client
        .cancel_stream(TARGET_STREAM, CancellationReason::ClientUnneeded)
        .await
        .expect("cancel_stream");
    assert_eq!(ack.target_stream_id, TARGET_STREAM);
    assert_eq!(ack.cancelled_at_unix_nanos, 1234);

    client.close().await.expect("bye");
    server.await.expect("server task");
}
