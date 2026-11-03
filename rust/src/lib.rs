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
//! task demultiplexes responses by `stream_id`) — the one connection type — and
//! [`client`] is the high-level [`BrainClient`] built on it — every verb takes
//! `&self`, so one client serves concurrent requests. [`verbs`] holds the
//! ergonomic request builders, [`retry`] the backoff combinator, and [`pool`] a
//! fixed-size connection pool for socket-level parallelism whose
//! [`Pool::get_healthy`] replaces a member whose socket has died before handing
//! it out. A verb call on an already-dropped connection is not transparently
//! retried — reconnect through the pool, or open a fresh client.

pub mod client;
pub mod error;
pub mod http;
pub mod mux;
pub mod pool;
pub mod retry;
pub mod transport;
pub mod verbs;
pub mod wire;

pub use client::{
    derive_space_id, new_id, Auth, BrainClient, ClientConfig, ConnectionInfo, RecallAnswer,
    DEFAULT_DERIVED_WRITE_TIMEOUT,
};
pub use error::{BrainError, Result};
pub use mux::{HandshakeOutcome, MuxConnection, Subscription};
pub use pool::Pool;
pub use retry::{with_default_retry, with_retry, RetryPolicy};
pub use verbs::{EncodeBuilder, ForgetBuilder, RecallBuilder};

// HTTP tier — the hosted-edge client (talks to `brain-edge` / the Arc gateway).
// Only the client + error are re-exported at the root (unique names); the
// contract types live under `http::` to avoid colliding with the wire types.
pub use http::{BrainHttpClient, BrainHttpError, HttpRetryPolicy};

/// This SDK crate's release version.
///
/// Taken from `CARGO_PKG_VERSION`, so it is the version cargo is building and
/// cannot drift from `Cargo.toml` — there is no second place to bump and
/// nothing for a test to compare.
///
/// The Python and TypeScript SDKs expose the same number as `__version__` and
/// `SDK_VERSION`, and both reached it the hard way: each carried a hand-typed
/// literal that silently fell three releases behind, so a compatibility check,
/// a bug report or a telemetry tag read a version that had not existed for a
/// year. This crate never had the constant at all, which is the same gap from
/// the other side — a Rust caller had no way to report which SDK it was
/// running. `env!` closes it without adding a thing to maintain.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
