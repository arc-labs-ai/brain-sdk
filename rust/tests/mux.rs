//! Multiplexed-connection concurrency test: two ENCODE requests in flight at
//! once, answered by the server in *reverse* order, must each be routed back to
//! the right caller by `stream_id`. Proves the reader-task demux, not just that
//! a single round-trip works.

use std::sync::Arc;

use tokio::net::{TcpListener, TcpStream};

use brain_db_sdk::mux::MuxConnection;
use brain_db_sdk::new_id;
use brain_db_sdk::transport::{read_frame, write_frame};
use brain_db_sdk::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use brain_db_sdk::wire::frame::{Frame, FLAG_EOS};
use brain_db_sdk::wire::opcode::Opcode;
use brain_db_sdk::wire::types::{
    AgentPermissions, AuthOkPayload, AuthPayload, EncodeRequest, EncodeResponse, HelloCapabilities,
    HelloPayload, MemoryKindWire, ServerFeatures, WelcomePayload,
};

async fn write_one<T: serde::Serialize>(sock: &mut TcpStream, op: Opcode, sid: u32, p: &T) {
    let frame = Frame::new(op.as_u16(), FLAG_EOS, sid, to_cbor_bytes(p));
    write_frame(sock, &frame).await.expect("write frame");
}

/// Handshake, then read TWO ENCODE requests before answering either — and
/// answer them in reverse receipt order. Each response echoes the request's
/// `context_id` as its `memory_id` so the client can verify routing.
async fn serve_two_concurrent(mut sock: TcpStream) {
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
            max_concurrent_streams: 256,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: auth.agent_id,
        bound_shard_id: 0,
        permissions: AgentPermissions {
            can_encode: true,
            can_recall: true,
            can_plan: true,
            can_reason: true,
            can_forget: true,
            can_admin: false,
        },
        server_time_unix_nanos: 1,
    };
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // Read both requests first, then reply in reverse order.
    let f1 = read_frame(&mut sock, &mut buf).await.expect("req 1");
    let r1: EncodeRequest = from_cbor_bytes(&f1.payload).expect("decode req 1");
    let f2 = read_frame(&mut sock, &mut buf).await.expect("req 2");
    let r2: EncodeRequest = from_cbor_bytes(&f2.payload).expect("decode req 2");

    // Client-initiated op streams MUST be non-zero and odd (the real server
    // rejects even/zero client streams as BadFrame). A second request on a
    // reused connection must not land on an even id — guards the mux's
    // odd-only stream allocator against regression.
    for (label, id) in [("req 1", f1.stream_id), ("req 2", f2.stream_id)] {
        assert!(
            id != 0 && id % 2 == 1,
            "{label} used non-odd client stream id {id}"
        );
    }
    assert_ne!(
        f1.stream_id, f2.stream_id,
        "concurrent requests need distinct streams"
    );

    let resp2 = encode_response(&r2, auth.agent_id);
    write_one(&mut sock, Opcode::EncodeResp, f2.stream_id, &resp2).await;
    let resp1 = encode_response(&r1, auth.agent_id);
    write_one(&mut sock, Opcode::EncodeResp, f1.stream_id, &resp1).await;

    // BYE.
    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

fn encode_response(req: &EncodeRequest, agent_id: [u8; 16]) -> EncodeResponse {
    EncodeResponse {
        memory_id: u128::from(req.context_id),
        was_deduplicated: false,
        salience: 0.5,
        auto_edges_added: 0,
        lsn: 1,
        agent_id,
        context_id: req.context_id,
        kind: req.kind,
        created_at_unix_nanos: 1,
        edges_out_count: 0,
        embedding_model_fp: [0; 16],
        pending_stages: vec![],
        has_active_schema: true,
    }
}

fn encode_request(context_id: u64) -> EncodeRequest {
    EncodeRequest {
        text: format!("memory {context_id}"),
        context_id,
        kind: MemoryKindWire::Semantic,
        salience_hint: 0.5,
        edges: vec![],
        request_id: new_id(),
        txn_id: None,
        deduplicate: true,
    }
}

#[tokio::test]
async fn two_requests_in_flight_route_back_correctly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_two_concurrent(sock).await;
    });

    let stream = TcpStream::connect(addr).await.expect("connect");
    let hello = HelloPayload {
        client_id: "mux-test".to_string(),
        supported_versions: vec![1],
        capabilities: HelloCapabilities {
            streaming: true,
            compression_zstd: false,
            server_push: false,
        },
        client_session_token: None,
    };
    let auth = AuthPayload {
        method: brain_db_sdk::wire::types::AuthMethod::None,
        agent_id: new_id(),
        credentials: brain_db_sdk::wire::types::AuthCredentials::None,
    };
    let (conn, outcome) = MuxConnection::handshake(stream, hello, auth, None)
        .await
        .expect("handshake");
    assert_eq!(outcome.welcome.chosen_version, 1);

    let conn = Arc::new(conn);

    // Fire both requests concurrently on the shared connection.
    let a = {
        let conn = Arc::clone(&conn);
        tokio::spawn(async move {
            conn.request_one(Opcode::EncodeReq, to_cbor_bytes(&encode_request(100)))
                .await
        })
    };
    let b = {
        let conn = Arc::clone(&conn);
        tokio::spawn(async move {
            conn.request_one(Opcode::EncodeReq, to_cbor_bytes(&encode_request(200)))
                .await
        })
    };

    let fa = a.await.expect("join a").expect("request a");
    let fb = b.await.expect("join b").expect("request b");
    let ra: EncodeResponse = from_cbor_bytes(&fa.payload).expect("decode resp a");
    let rb: EncodeResponse = from_cbor_bytes(&fb.payload).expect("decode resp b");

    // Despite the server replying in reverse order, each response routed back
    // to the request whose context it echoes.
    assert_eq!(ra.memory_id, 100);
    assert_eq!(ra.context_id, 100);
    assert_eq!(rb.memory_id, 200);
    assert_eq!(rb.context_id, 200);

    conn.send_bye().await.expect("bye");
    server.await.expect("server task");
}

// ===========================================================================
// SUBSCRIBE: a long-lived server-push stream.
//
// The mock server, on SUBSCRIBE_REQ, pushes two SUBSCRIBE_EVENT frames
// (non-EOS) on the subscription's stream, then — on UNSUBSCRIBE_REQ — replies
// UNSUBSCRIBE_RESP (EOS) plus a final EOS SUBSCRIBE_EVENT (empty terminator)
// on the subscription stream. The client must drain exactly the two events,
// `unsubscribe()` must succeed, `next()` must then return `None`, and the
// route table must be empty afterward (no leaked subscription route).
// ===========================================================================

use brain_db_sdk::wire::types::{
    EventType, SubscribeRequest, SubscriptionEvent, SubscriptionFilter, UnsubscribeRequest,
    UnsubscribeResponse,
};

fn sample_event(lsn: u64) -> SubscriptionEvent {
    SubscriptionEvent {
        event_type: EventType::Encoded,
        memory_id: u128::from(lsn),
        context_id: 1,
        text: format!("event {lsn}"),
        kind: MemoryKindWire::Semantic,
        salience: 0.5,
        timestamp_unix_nanos: lsn,
        lsn,
        graph_payload: None,
        edge_payload: None,
        stage_kind: None,
        stage_outcome: None,
        stage_payload: None,
    }
}

async fn serve_subscription(mut sock: TcpStream) {
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
            max_concurrent_streams: 256,
            idle_timeout_seconds: 300,
            auth_methods: vec![],
        },
    };
    write_one(&mut sock, Opcode::Welcome, 0, &welcome).await;

    let auth_frame = read_frame(&mut sock, &mut buf).await.expect("auth");
    let auth: AuthPayload = from_cbor_bytes(&auth_frame.payload).expect("decode auth");
    let auth_ok = AuthOkPayload {
        agent_id: auth.agent_id,
        bound_shard_id: 0,
        permissions: AgentPermissions {
            can_encode: true,
            can_recall: true,
            can_plan: true,
            can_reason: true,
            can_forget: true,
            can_admin: false,
        },
        server_time_unix_nanos: 1,
    };
    write_one(&mut sock, Opcode::AuthOk, 0, &auth_ok).await;

    // SUBSCRIBE_REQ on stream N.
    let f = read_frame(&mut sock, &mut buf).await.expect("subscribe");
    assert_eq!(f.opcode, Opcode::SubscribeReq as u16);
    assert_ne!(f.flags & FLAG_EOS, 0, "SUBSCRIBE_REQ is a single EOS frame");
    let sub_stream = f.stream_id;

    // Two events, pushed without EOS (the stream stays open).
    for lsn in 1..=2 {
        let ev = Frame::new(
            Opcode::SubscribeEvent.as_u16(),
            0,
            sub_stream,
            to_cbor_bytes(&sample_event(lsn)),
        );
        write_frame(&mut sock, &ev).await.expect("write event");
    }

    // UNSUBSCRIBE_REQ on a fresh stream M.
    let f = read_frame(&mut sock, &mut buf).await.expect("unsubscribe");
    assert_eq!(f.opcode, Opcode::UnsubscribeReq as u16);
    let unsub: UnsubscribeRequest = from_cbor_bytes(&f.payload).expect("decode unsubscribe");
    assert_eq!(unsub.target_stream_id, sub_stream);

    // UNSUBSCRIBE_RESP (EOS) on stream M.
    write_one(
        &mut sock,
        Opcode::UnsubscribeResp,
        f.stream_id,
        &UnsubscribeResponse {
            target_stream_id: sub_stream,
            final_lsn: 2,
        },
    )
    .await;

    // Final EOS SUBSCRIBE_EVENT on stream N: an empty-payload terminator that
    // closes the subscription stream. The client observes this as end-of-stream.
    let terminator = Frame::new(
        Opcode::SubscribeEvent.as_u16(),
        FLAG_EOS,
        sub_stream,
        Vec::new(),
    );
    write_frame(&mut sock, &terminator)
        .await
        .expect("write terminator");

    let bye = read_frame(&mut sock, &mut buf).await.expect("bye");
    assert_eq!(bye.opcode, Opcode::Bye as u16);
}

#[test]
fn subscribe_types_round_trip() {
    let req = SubscribeRequest {
        filter: SubscriptionFilter {
            contexts: Some(vec![1, 2]),
            kinds: Some(vec![MemoryKindWire::Semantic]),
            similar_to: None,
            agents: Some(vec![[7u8; 16]]),
        },
        include_history: true,
        from_lsn: Some(42),
        max_inflight: 16,
    };
    let bytes = to_cbor_bytes(&req);
    let back: SubscribeRequest = from_cbor_bytes(&bytes).expect("decode subscribe req");
    assert_eq!(back, req);

    let ev = sample_event(9);
    let bytes = to_cbor_bytes(&ev);
    let back: SubscriptionEvent = from_cbor_bytes(&bytes).expect("decode event");
    assert_eq!(back, ev);

    let resp = UnsubscribeResponse {
        target_stream_id: 5,
        final_lsn: 99,
    };
    let bytes = to_cbor_bytes(&resp);
    let back: UnsubscribeResponse = from_cbor_bytes(&bytes).expect("decode unsub resp");
    assert_eq!(back, resp);
}

#[tokio::test]
async fn subscription_drains_events_unsubscribes_and_leaks_no_route() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        serve_subscription(sock).await;
    });

    let stream = TcpStream::connect(addr).await.expect("connect");
    let hello = HelloPayload {
        client_id: "sub-test".to_string(),
        supported_versions: vec![1],
        capabilities: HelloCapabilities {
            streaming: true,
            compression_zstd: false,
            server_push: true,
        },
        client_session_token: None,
    };
    let auth = AuthPayload {
        method: brain_db_sdk::wire::types::AuthMethod::None,
        agent_id: new_id(),
        credentials: brain_db_sdk::wire::types::AuthCredentials::None,
    };
    let (conn, _outcome) = MuxConnection::handshake(stream, hello, auth, None)
        .await
        .expect("handshake");
    let conn = Arc::new(conn);

    let mut sub = conn
        .subscribe(&SubscribeRequest {
            filter: SubscriptionFilter {
                contexts: None,
                kinds: None,
                similar_to: None,
                agents: None,
            },
            include_history: false,
            from_lsn: None,
            max_inflight: 8,
        })
        .await
        .expect("subscribe");

    // The subscription occupies exactly one route while live.
    assert_eq!(conn.route_count(), 1, "subscription route registered");

    // Drain exactly the two pushed events.
    let e1 = sub.next().await.expect("event 1").expect("event 1 ok");
    assert_eq!(e1.lsn, 1);
    let e2 = sub.next().await.expect("event 2").expect("event 2 ok");
    assert_eq!(e2.lsn, 2);

    // Clean teardown: UNSUBSCRIBE on a fresh stream; server EOS-closes the
    // subscription stream in response.
    let resp = sub.unsubscribe().await.expect("unsubscribe");
    assert_eq!(resp.final_lsn, 2);

    // The terminating EOS event ends the stream — no deadlock here proves the
    // subscription path doesn't block forever waiting on EOS like `request()`.
    assert!(sub.next().await.is_none(), "stream ended after unsubscribe");

    // No leaked route: the subscription stream's route was removed on EOS, and
    // the unsubscribe stream's route was removed on its own EOS response.
    drop(sub);
    assert_eq!(conn.route_count(), 0, "no leaked routes after teardown");

    conn.send_bye().await.expect("bye");
    server.await.expect("server task");
}
