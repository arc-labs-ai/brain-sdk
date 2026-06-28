//! brain-db-sdk — Rust client for the Brain memory database.
//!
//! Brain ships no client library; its contract is the wire protocol — a
//! 32-byte `BRN0` frame header plus CBOR payloads over TCP. This crate
//! re-implements that protocol independently (the protocol, not a shared
//! library, is the source of truth) and is verified byte-for-byte
//! against Brain's vendored conformance corpus.
//!
//! The [`wire`] module is the codec: the frame codec ([`wire::frame`]),
//! the CBOR payload codec ([`wire::cbor`]), the opcode table
//! ([`wire::opcode`]), and the typed payload structs ([`wire::types`]) for
//! the handshake and the verbs — all runtime-agnostic and verified against
//! the corpus.
//!
//! Layered on top: [`transport`] reads/writes whole frames over an async byte
//! stream, [`mux`] is the multiplexed [`MuxConnection`] (a background reader
//! task demultiplexes responses by `stream_id`), and [`client`] is the
//! high-level [`BrainClient`] built on it — every verb takes `&self`, so one
//! client serves concurrent requests. [`verbs`] holds the ergonomic request
//! builders, [`retry`] the backoff combinator, and [`pool`] a fixed-size
//! connection pool for socket-level parallelism. The serial one-at-a-time
//! [`connection::Connection`] remains for callers who want it. Transparent
//! reconnect and connection-pool health-checking are the remaining later work.

pub mod client;
pub mod connection;
pub mod error;
pub mod mux;
pub mod pool;
pub mod retry;
pub mod transport;
pub mod verbs;
pub mod wire;

pub use client::{new_id, Auth, BrainClient, ClientConfig, RecallAnswer, SessionInfo};
pub use connection::{Connection, HandshakeOutcome};
pub use error::{BrainError, Result};
pub use mux::{MuxConnection, Subscription};
pub use pool::Pool;
pub use retry::{with_default_retry, with_retry, RetryPolicy};
pub use verbs::{EncodeBuilder, ForgetBuilder, RecallBuilder};
