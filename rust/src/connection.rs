//! A single connection: the handshake and one-at-a-time request/response
//! over a byte stream.
//!
//! [`Connection`] is generic over any `AsyncRead + AsyncWrite` so it drives
//! both a real `TcpStream` and an in-process pipe in tests. It owns the read
//! buffer and mints `stream_id`s. This phase serves one request at a time
//! (send, then read the response to EOS); the concurrent stream multiplexer
//! and connection pool are a later phase, and will reuse this type's frame
//! plumbing.
//!
//! `stream_id` 0 is reserved for the handshake exchange; request streams are
//! numbered from 1 upward.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::{BrainError, Result};
use crate::transport::{read_frame, write_frame};
use crate::wire::cbor::{from_cbor_bytes, to_cbor_bytes};
use crate::wire::frame::{Frame, FLAG_EOS};
use crate::wire::opcode::Opcode;
use crate::wire::types::{AuthOkPayload, AuthPayload, ErrorResponse, HelloPayload, WelcomePayload};

/// The `stream_id` carried by every handshake frame.
const HANDSHAKE_STREAM_ID: u32 = 0;

/// What the server told us during the handshake.
#[derive(Clone, Debug)]
pub struct HandshakeOutcome {
    pub welcome: WelcomePayload,
    pub auth_ok: AuthOkPayload,
}

/// One connection to a Brain server.
pub struct Connection<S> {
    stream: S,
    read_buf: Vec<u8>,
    next_stream_id: u32,
    request_timeout: Option<Duration>,
}

impl<S> Connection<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// Wrap an already-connected byte stream. No bytes are exchanged until
    /// [`Connection::handshake`] runs.
    #[must_use]
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            read_buf: Vec::new(),
            next_stream_id: 1,
            request_timeout: None,
        }
    }

    /// Set a per-response read deadline. `None` (the default) waits
    /// indefinitely. Applied to each `read_frame` while awaiting a response.
    pub fn set_request_timeout(&mut self, timeout: Option<Duration>) {
        self.request_timeout = timeout;
    }

    /// Run the client side of the handshake: HELLO -> WELCOME -> AUTH ->
    /// AUTH_OK. Validates that the server's chosen version is one the client
    /// offered, and that each reply carries the expected opcode.
    pub async fn handshake(
        &mut self,
        hello: HelloPayload,
        auth: AuthPayload,
    ) -> Result<HandshakeOutcome> {
        let offered = hello.supported_versions.clone();

        self.send(Opcode::Hello, HANDSHAKE_STREAM_ID, &to_cbor_bytes(&hello))
            .await?;
        let welcome_frame = self.read_handshake_reply(Opcode::Welcome).await?;
        let welcome: WelcomePayload = from_cbor_bytes(&welcome_frame.payload)?;
        if !offered.contains(&welcome.chosen_version) {
            return Err(BrainError::VersionMismatch {
                chosen: welcome.chosen_version,
                supported: offered,
            });
        }

        self.send(Opcode::Auth, HANDSHAKE_STREAM_ID, &to_cbor_bytes(&auth))
            .await?;
        let auth_ok_frame = self.read_handshake_reply(Opcode::AuthOk).await?;
        let auth_ok: AuthOkPayload = from_cbor_bytes(&auth_ok_frame.payload)?;

        Ok(HandshakeOutcome { welcome, auth_ok })
    }

    /// Send one request and collect its response frames up to and including
    /// the EOS frame. Single-shot verbs return exactly one frame; streaming
    /// verbs (RECALL/QUERY) return several. An ERROR reply on the stream
    /// surfaces as [`BrainError::Server`].
    pub async fn request(&mut self, opcode: Opcode, payload: Vec<u8>) -> Result<Vec<Frame>> {
        let stream_id = self.take_stream_id();
        self.send(opcode, stream_id, &payload).await?;

        let mut frames = Vec::new();
        loop {
            let frame = self.read_frame_timed().await?;
            if frame.opcode == Opcode::Error as u16 {
                let err: ErrorResponse = from_cbor_bytes(&frame.payload)?;
                return Err(BrainError::from_server(err));
            }
            if frame.stream_id != stream_id {
                return Err(BrainError::Protocol(format!(
                    "response on stream {} but request used stream {stream_id}",
                    frame.stream_id
                )));
            }
            let is_last = frame.flags & FLAG_EOS != 0;
            frames.push(frame);
            if is_last {
                return Ok(frames);
            }
        }
    }

    /// Send one request and require exactly one EOS response frame — the
    /// shape every single-shot verb (ENCODE / FORGET / typed-graph create)
    /// uses.
    pub async fn request_one(&mut self, opcode: Opcode, payload: Vec<u8>) -> Result<Frame> {
        let mut frames = self.request(opcode, payload).await?;
        if frames.len() != 1 {
            return Err(BrainError::Protocol(format!(
                "expected a single response frame, got {}",
                frames.len()
            )));
        }
        Ok(frames.remove(0))
    }

    /// Send BYE to end the session cleanly. The server closes without a
    /// reply, so this does not read.
    pub async fn send_bye(&mut self) -> Result<()> {
        self.send(Opcode::Bye, HANDSHAKE_STREAM_ID, &[]).await
    }

    /// Consume the connection, returning the underlying stream.
    pub fn into_inner(self) -> S {
        self.stream
    }

    // ---- internals ----

    /// Write one request/handshake frame (single payload, EOS-terminated).
    async fn send(&mut self, opcode: Opcode, stream_id: u32, payload: &[u8]) -> Result<()> {
        let frame = Frame::new(opcode.as_u16(), FLAG_EOS, stream_id, payload.to_vec());
        write_frame(&mut self.stream, &frame).await
    }

    /// Read one handshake reply and require it to carry `expected`. An ERROR
    /// frame is decoded into a server error; any other opcode is a protocol
    /// violation that aborts the handshake.
    async fn read_handshake_reply(&mut self, expected: Opcode) -> Result<Frame> {
        let frame = self.read_frame_timed().await?;
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

    /// Read one frame, honoring the configured request timeout.
    async fn read_frame_timed(&mut self) -> Result<Frame> {
        match self.request_timeout {
            Some(timeout) => {
                tokio::time::timeout(timeout, read_frame(&mut self.stream, &mut self.read_buf))
                    .await
                    .map_err(|_| BrainError::Timeout(timeout))?
            }
            None => read_frame(&mut self.stream, &mut self.read_buf).await,
        }
    }

    /// Hand out the next request `stream_id`, wrapping past `u32::MAX` back
    /// to 1 (0 stays reserved for the handshake).
    fn take_stream_id(&mut self) -> u32 {
        let id = self.next_stream_id;
        self.next_stream_id = self.next_stream_id.checked_add(1).unwrap_or(1);
        id
    }
}
