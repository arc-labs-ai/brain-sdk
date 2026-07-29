//! Multiplexed connection: many requests in flight at once over one socket.
//!
//! A [`MuxConnection`] splits the stream, runs a background **reader task** that
//! demultiplexes every inbound frame to the waiting request by its `stream_id`,
//! and lets callers issue requests concurrently — verbs take `&self`, so one
//! connection is shared (e.g. behind an `Arc`) across tasks.
//!
//! Each request registers an unbounded channel under a fresh `stream_id`,
//! writes its frame (writes are serialized by a mutex so frames never
//! interleave on the wire), and awaits frames routed to that channel until the
//! EOS frame — so streaming verbs (RECALL / QUERY) and single-shot verbs share
//! one path. An ERROR frame on the stream surfaces as [`BrainError::Server`].
//! When the reader task dies (a transport drop or a fatal frame-codec error)
//! it fails every outstanding request.
//!
//! `stream_id` 0 is the handshake stream; the handshake completes *before* the
//! reader task starts, so request stream ids (numbered from 1) never collide
//! with it even after the `u32` counter wraps.
//!
//! [`Subscription`] is the long-lived exception to the request/response shape:
//! SUBSCRIBE opens a stream the server pushes events on indefinitely, so it
//! can't collect to EOS like [`MuxConnection::request`]. It registers a route,
//! sends the SUBSCRIBE frame, and hands back a handle the caller drains one
//! event at a time. The shared write half, route table, stream-id counter and
//! timeout all live in a single [`Shared`] behind an `Arc` so a subscription
//! can send its own UNSUBSCRIBE on a fresh stream without borrowing the
//! connection.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{split, AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{BrainError, Result};
use crate::transport::{read_frame, write_frame};
use crate::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use crate::wire::frame::{Frame, FLAG_EOS};
use crate::wire::opcode::Opcode;
use crate::wire::types::{
    AuthOkPayload, AuthPayload, ByeRequest, ClientPongRequest, ErrorResponse, HelloPayload,
    ServerPingResponse, SubscribeRequest, SubscriptionEvent, UnsubscribeRequest,
    UnsubscribeResponse, WelcomePayload,
};

const HANDSHAKE_STREAM_ID: u32 = 0;

/// What the server told us during the handshake: the negotiated [`WelcomePayload`]
/// (chosen wire version + server features) and the [`AuthOkPayload`] (the resolved
/// session — agent id and tenant namespace). Returned by
/// [`MuxConnection::connect`] and surfaced to the caller as the initial session.
#[derive(Clone, Debug)]
pub struct HandshakeOutcome {
    pub welcome: WelcomePayload,
    pub auth_ok: AuthOkPayload,
}

/// Wall-clock nanoseconds since the Unix epoch, saturating at 0 if the
/// clock is before the epoch. Used to stamp CLIENT_PONG replies.
fn now_unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The route table the reader task delivers frames into. `closed` is set once
/// the reader exits, so a request started after the connection died fails fast
/// instead of hanging.
struct RouteTable {
    routes: HashMap<u32, mpsc::UnboundedSender<Frame>>,
    closed: Option<String>,
}

/// State both the connection and any live [`Subscription`] share: the write
/// half (serialized by a mutex), the route table, the stream-id allocator, and
/// the per-request timeout. Held behind an `Arc` so a subscription can send its
/// own UNSUBSCRIBE on a fresh stream without borrowing the `MuxConnection`.
struct Shared<S> {
    // Shared with the reader task so it can answer SERVER_PING with
    // CLIENT_PONG without a separate writer handle.
    writer: Arc<tokio::sync::Mutex<WriteHalf<S>>>,
    table: Arc<Mutex<RouteTable>>,
    next_stream_id: AtomicU32,
    request_timeout: Option<Duration>,
}

impl<S> Shared<S>
where
    S: AsyncWrite,
{
    fn alloc_stream_id(&self) -> u32 {
        // Client-initiated op streams MUST be non-zero and ODD (stream 0 is
        // the connection/handshake stream; the server rejects even client
        // streams as `BadFrame`). Start at 1 and step by 2 so every request
        // on a reused connection (REPL, pool) stays odd.
        self.next_stream_id.fetch_add(2, Ordering::Relaxed)
    }

    /// Register a route for `stream_id`, returning its receiver. Fails if the
    /// connection has already closed.
    fn register(&self, stream_id: u32) -> Result<mpsc::UnboundedReceiver<Frame>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut table = self.table.lock().expect("route table mutex poisoned");
        if let Some(reason) = &table.closed {
            return Err(BrainError::Protocol(format!("connection closed: {reason}")));
        }
        table.routes.insert(stream_id, tx);
        Ok(rx)
    }

    fn deregister(&self, stream_id: u32) {
        self.table
            .lock()
            .expect("route table mutex poisoned")
            .routes
            .remove(&stream_id);
    }

    /// Write one frame, serialized against every other writer on the socket.
    async fn write(&self, frame: &Frame) -> Result<()> {
        let mut w = self.writer.lock().await;
        write_frame(&mut *w, frame).await
    }

    /// Send `opcode`+`payload` as a single EOS frame on `stream_id`, then
    /// collect routed frames up to and including the inbound EOS.
    async fn request_on(
        &self,
        stream_id: u32,
        mut rx: mpsc::UnboundedReceiver<Frame>,
        opcode: Opcode,
        payload: Vec<u8>,
    ) -> Result<Vec<Frame>> {
        let frame = Frame::new(opcode.as_u16(), FLAG_EOS, stream_id, payload);
        if let Err(e) = self.write(&frame).await {
            self.deregister(stream_id);
            return Err(e);
        }

        let mut frames = Vec::new();
        loop {
            let next = match self.request_timeout {
                Some(timeout) => match tokio::time::timeout(timeout, rx.recv()).await {
                    Ok(v) => v,
                    Err(_) => {
                        self.deregister(stream_id);
                        return Err(BrainError::Timeout(timeout));
                    }
                },
                None => rx.recv().await,
            };
            match next {
                Some(frame) if frame.opcode == Opcode::Error as u16 => {
                    self.deregister(stream_id);
                    let err: ErrorResponse = from_cbor_bytes(&frame.payload)?;
                    return Err(BrainError::from_server(err));
                }
                Some(frame) => {
                    let is_last = frame.flags & FLAG_EOS != 0;
                    frames.push(frame);
                    if is_last {
                        // The reader removes the route on EOS; nothing to clean up.
                        return Ok(frames);
                    }
                }
                None => return Err(self.closed_error()),
            }
        }
    }

    /// The error to surface when a request's channel closed without an EOS —
    /// the reader recorded a failure reason, or the peer simply went away.
    fn closed_error(&self) -> BrainError {
        let table = self.table.lock().expect("route table mutex poisoned");
        match &table.closed {
            Some(reason) => BrainError::Protocol(format!("connection closed: {reason}")),
            None => BrainError::Closed,
        }
    }
}

/// A connection that serves many concurrent requests over one socket.
pub struct MuxConnection<S> {
    shared: Arc<Shared<S>>,
    reader: JoinHandle<()>,
}

impl<S> Drop for MuxConnection<S> {
    fn drop(&mut self) {
        // The reader task borrows only the read half (moved into it); aborting
        // it on drop avoids a leaked task once the connection goes away.
        self.reader.abort();
    }
}

impl<S> MuxConnection<S>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    /// Run the handshake on `stream`, then split it and spawn the reader task.
    /// Returns the live connection and the negotiated [`HandshakeOutcome`].
    ///
    /// The handshake runs inline on the split halves (HELLO → WELCOME → AUTH →
    /// AUTH_OK on stream 0); any bytes buffered past AUTH_OK are handed to the
    /// reader task so no frame is lost at the seam.
    pub async fn handshake(
        stream: S,
        hello: HelloPayload,
        auth: AuthPayload,
        request_timeout: Option<Duration>,
    ) -> Result<(Self, HandshakeOutcome)> {
        let (mut read_half, mut write_half) = split(stream);
        let mut buf = Vec::new();
        let offered = hello.supported_versions.clone();

        send(&mut write_half, Opcode::Hello, HANDSHAKE_STREAM_ID, &hello).await?;
        let welcome_frame =
            read_handshake_reply(&mut read_half, &mut buf, Opcode::Welcome, request_timeout)
                .await?;
        let welcome: WelcomePayload = from_cbor_bytes(&welcome_frame.payload)?;
        if !offered.contains(&welcome.chosen_version) {
            return Err(BrainError::VersionMismatch {
                chosen: welcome.chosen_version,
                supported: offered,
            });
        }

        send(&mut write_half, Opcode::Auth, HANDSHAKE_STREAM_ID, &auth).await?;
        let auth_ok_frame =
            read_handshake_reply(&mut read_half, &mut buf, Opcode::AuthOk, request_timeout).await?;
        let auth_ok: AuthOkPayload = from_cbor_bytes(&auth_ok_frame.payload)?;

        let table = Arc::new(Mutex::new(RouteTable {
            routes: HashMap::new(),
            closed: None,
        }));
        let writer = Arc::new(tokio::sync::Mutex::new(write_half));
        let reader = tokio::spawn(reader_loop(
            read_half,
            buf,
            Arc::clone(&table),
            Arc::clone(&writer),
        ));

        let shared = Arc::new(Shared {
            writer,
            table,
            next_stream_id: AtomicU32::new(1),
            request_timeout,
        });

        let conn = Self { shared, reader };
        Ok((conn, HandshakeOutcome { welcome, auth_ok }))
    }

    /// Send one request and collect its response frames up to and including the
    /// EOS frame. Safe to call concurrently from many tasks on a shared
    /// connection; responses are routed back by `stream_id`.
    pub async fn request(&self, opcode: Opcode, payload: Vec<u8>) -> Result<Vec<Frame>> {
        let stream_id = self.shared.alloc_stream_id();
        let rx = self.shared.register(stream_id)?;
        self.shared.request_on(stream_id, rx, opcode, payload).await
    }

    /// Send one request and require exactly one EOS response frame.
    pub async fn request_one(&self, opcode: Opcode, payload: Vec<u8>) -> Result<Frame> {
        let mut frames = self.request(opcode, payload).await?;
        if frames.len() != 1 {
            return Err(BrainError::Protocol(format!(
                "expected a single response frame, got {}",
                frames.len()
            )));
        }
        Ok(frames.remove(0))
    }

    /// Open a long-lived subscription. Allocates a stream id, registers its
    /// route, sends the SUBSCRIBE frame, and returns a [`Subscription`] the
    /// caller drains with [`Subscription::next`]. Unlike [`Self::request`],
    /// this does **not** collect to EOS — the server pushes events until the
    /// client unsubscribes.
    pub async fn subscribe(&self, request: &SubscribeRequest) -> Result<Subscription<S>> {
        let stream_id = self.shared.alloc_stream_id();
        let rx = self.shared.register(stream_id)?;
        let frame = Frame::new(
            Opcode::SubscribeReq.as_u16(),
            FLAG_EOS,
            stream_id,
            to_cbor_bytes(request),
        );
        if let Err(e) = self.shared.write(&frame).await {
            self.shared.deregister(stream_id);
            return Err(e);
        }
        Ok(Subscription {
            shared: Arc::clone(&self.shared),
            stream_id,
            rx,
            ended: false,
        })
    }

    /// Send BYE to end the session cleanly.
    pub async fn send_bye(&self) -> Result<()> {
        // `0xA0` (empty CBOR map), not an empty payload: the server decodes
        // this as a `ByeRequest`, and zero bytes is not valid CBOR.
        let frame = Frame::new(
            Opcode::Bye.as_u16(),
            FLAG_EOS,
            HANDSHAKE_STREAM_ID,
            to_cbor_bytes(&ByeRequest::default()),
        );
        self.shared.write(&frame).await
    }

    /// Number of live routes in the table. Test/diagnostics hook: a clean
    /// subscription teardown must leave no leaked route behind.
    #[must_use]
    pub fn route_count(&self) -> usize {
        self.shared
            .table
            .lock()
            .expect("route table mutex poisoned")
            .routes
            .len()
    }
}

/// A live server-push subscription stream. Drain events with [`Self::next`];
/// call [`Self::unsubscribe`] for a clean teardown (the server then EOS-closes
/// the event stream, which `next` observes as end-of-stream).
///
/// Dropping a subscription deregisters its route so a forgotten handle doesn't
/// leak an entry in the route table — but `Drop` can't send UNSUBSCRIBE (it
/// isn't async), so a dropped-without-unsubscribe subscription leaves the
/// server pushing into a now-dead channel until it notices. Prefer
/// `unsubscribe().await` before dropping.
pub struct Subscription<S> {
    shared: Arc<Shared<S>>,
    stream_id: u32,
    rx: mpsc::UnboundedReceiver<Frame>,
    /// Set once an EOS frame has been observed: the next `next()` returns
    /// `None` without touching the (already-removed) channel.
    ended: bool,
}

impl<S> Subscription<S>
where
    S: AsyncWrite,
{
    /// The stream id the server pushes events on. Pass it to the server's
    /// UNSUBSCRIBE target if driving the protocol manually.
    #[must_use]
    pub fn stream_id(&self) -> u32 {
        self.stream_id
    }

    /// Await the next subscription event. Returns `Some(Ok(event))` for each
    /// pushed `SUBSCRIBE_EVENT`, `Some(Err(_))` if a frame failed to decode or
    /// the server sent an ERROR on the stream, and `None` once the stream has
    /// ended (the server EOS-closed it, or the connection dropped).
    ///
    /// An EOS-flagged frame carrying an event yields that event; the *following*
    /// call returns `None`. An EOS frame with an empty payload ends the stream
    /// immediately.
    pub async fn next(&mut self) -> Option<Result<SubscriptionEvent>> {
        if self.ended {
            return None;
        }
        let frame = self.rx.recv().await?;
        if frame.opcode == Opcode::Error as u16 {
            self.ended = true;
            return Some(match from_cbor_bytes::<ErrorResponse>(&frame.payload) {
                Ok(err) => Err(BrainError::from_server(err)),
                Err(e) => Err(e.into()),
            });
        }
        if frame.flags & FLAG_EOS != 0 {
            // Last frame on the stream. The reader has already removed the
            // route; mark ended so the next call short-circuits to `None`.
            self.ended = true;
            // A terminal EOS frame may carry a final event or be empty.
            if frame.payload.is_empty() {
                return None;
            }
        }
        Some(from_cbor_bytes::<SubscriptionEvent>(&frame.payload).map_err(Into::into))
    }

    /// Tear the subscription down cleanly: send UNSUBSCRIBE on a fresh stream
    /// and await its UNSUBSCRIBE_RESP. The server then EOS-closes the event
    /// stream, which a subsequent [`Self::next`] observes as `None`.
    pub async fn unsubscribe(&self) -> Result<UnsubscribeResponse> {
        let req = UnsubscribeRequest {
            target_stream_id: self.stream_id,
        };
        let stream_id = self.shared.alloc_stream_id();
        let rx = self.shared.register(stream_id)?;
        let mut frames = self
            .shared
            .request_on(stream_id, rx, Opcode::UnsubscribeReq, to_cbor_bytes(&req))
            .await?;
        if frames.len() != 1 {
            return Err(BrainError::Protocol(format!(
                "expected a single UNSUBSCRIBE_RESP frame, got {}",
                frames.len()
            )));
        }
        let frame = frames.remove(0);
        if frame.opcode != Opcode::UnsubscribeResp as u16 {
            return Err(BrainError::Protocol(format!(
                "expected UNSUBSCRIBE_RESP ({:#06x}), got {:#06x}",
                Opcode::UnsubscribeResp as u16,
                frame.opcode
            )));
        }
        Ok(from_cbor_bytes(&frame.payload)?)
    }
}

impl<S> Drop for Subscription<S> {
    fn drop(&mut self) {
        // Deregister the subscription's route so a dropped handle doesn't leak
        // a route-table entry. Cannot send UNSUBSCRIBE here (Drop isn't async);
        // a clean shutdown should call `unsubscribe().await` first.
        self.shared
            .table
            .lock()
            .expect("route table mutex poisoned")
            .routes
            .remove(&self.stream_id);
    }
}

/// Demultiplex inbound frames to waiting requests until the stream ends or a
/// fatal error occurs, then fail every outstanding request.
async fn reader_loop<S>(
    mut read_half: ReadHalf<S>,
    mut buf: Vec<u8>,
    table: Arc<Mutex<RouteTable>>,
    writer: Arc<tokio::sync::Mutex<WriteHalf<S>>>,
) where
    // `ReadHalf<S>`/`WriteHalf<S>` are `Unpin` regardless of `S`, so the
    // read/write calls need only `S: AsyncRead + AsyncWrite`. Send/'static
    // for the spawned task come from the call site (handshake bound).
    S: AsyncRead + AsyncWrite,
{
    loop {
        match read_frame(&mut read_half, &mut buf).await {
            Ok(frame) => {
                // Server idle-timer heartbeat: reply CLIENT_PONG on stream 0
                // so the server doesn't reap an otherwise-idle connection.
                // The reply echoes the server timestamp (0 if the payload
                // can't be decoded — the server only needs *a* frame to reset
                // its idle timer). Best-effort: a write failure surfaces as
                // the next read error, which closes the connection cleanly.
                if frame.opcode == Opcode::ServerPing.as_u16() {
                    let server_ts = from_cbor_bytes::<ServerPingResponse>(&frame.payload)
                        .map(|p| p.server_timestamp_unix_nanos)
                        .unwrap_or(0);
                    let pong = ClientPongRequest {
                        server_timestamp_unix_nanos: server_ts,
                        client_timestamp_unix_nanos: now_unix_nanos(),
                    };
                    let reply = Frame::new(
                        Opcode::ClientPong.as_u16(),
                        FLAG_EOS,
                        HANDSHAKE_STREAM_ID,
                        to_cbor_bytes(&pong),
                    );
                    let mut w = writer.lock().await;
                    let _ = write_frame(&mut *w, &reply).await;
                    continue;
                }
                let stream_id = frame.stream_id;
                let is_last = frame.flags & FLAG_EOS != 0;
                let mut t = table.lock().expect("route table mutex poisoned");
                if let Some(tx) = t.routes.get(&stream_id) {
                    // A receiver dropped (request cancelled) just means the send
                    // fails; drop the frame and the route.
                    let _ = tx.send(frame);
                    if is_last {
                        t.routes.remove(&stream_id);
                    }
                }
                // An unknown stream_id is a late frame for a timed-out/cancelled
                // request; drop it.
            }
            Err(e) => {
                let mut t = table.lock().expect("route table mutex poisoned");
                t.closed = Some(e.to_string());
                // Dropping every sender wakes each waiting `rx.recv()` with
                // `None`, so all outstanding requests fail.
                t.routes.clear();
                return;
            }
        }
    }
}

/// Write a CBOR-bodied frame on a write half (handshake helper).
async fn send<W, T>(write_half: &mut W, opcode: Opcode, stream_id: u32, payload: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: serde::Serialize,
{
    let frame = Frame::new(
        opcode.as_u16(),
        FLAG_EOS,
        stream_id,
        crate::wire::cbor::to_cbor_bytes(payload),
    );
    write_frame(write_half, &frame).await
}

/// Read one handshake reply and require it to carry `expected`.
async fn read_handshake_reply<R: AsyncRead + Unpin>(
    read_half: &mut R,
    buf: &mut Vec<u8>,
    expected: Opcode,
    timeout: Option<Duration>,
) -> Result<Frame> {
    let frame = match timeout {
        Some(t) => tokio::time::timeout(t, read_frame(read_half, buf))
            .await
            .map_err(|_| BrainError::Timeout(t))??,
        None => read_frame(read_half, buf).await?,
    };
    if frame.opcode == Opcode::Error as u16 {
        let err: ErrorResponse = from_cbor_bytes(&frame.payload)?;
        return Err(BrainError::from_server(err));
    }
    if frame.opcode != expected.as_u16() {
        return Err(BrainError::Protocol(format!(
            "expected {expected:?} ({:#06x}), got opcode {:#06x}",
            expected.as_u16(),
            frame.opcode
        )));
    }
    Ok(frame)
}
