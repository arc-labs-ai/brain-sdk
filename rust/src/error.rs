//! Client error taxonomy.
//!
//! Every fallible client call returns [`Result`]. A [`BrainError`] separates
//! the layers a caller reacts to differently: local I/O, a malformed frame or
//! payload off the wire, a protocol-sequence violation, a structured error the
//! server chose to return, version negotiation failure, a clean peer close, and
//! a timeout. The server-returned [`BrainError::Server`] carries the full
//! [`ErrorResponse`] so callers can branch on its stable code and category and
//! honor `retry_after_ms` — which the [`crate::retry`] combinator consumes to
//! back off retryable failures.

use std::time::Duration;

use crate::wire::cbor::CborError;
use crate::wire::frame::FrameError;
use crate::wire::types::{ErrorCategoryWire, ErrorCodeWire, ErrorResponse};

/// Result alias for client operations.
pub type Result<T> = std::result::Result<T, BrainError>;

/// A failure from any client operation.
#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    /// Local socket I/O failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A frame off the wire failed to decode (bad magic / CRC / reserved
    /// bits / oversize). A frame error desynchronizes the byte stream, so
    /// the connection is no longer usable.
    #[error("frame codec error: {0}")]
    Frame(#[from] FrameError),

    /// A frame's CBOR payload failed to encode or decode.
    #[error("payload codec error: {0}")]
    Cbor(#[from] CborError),

    /// The peer broke the protocol sequence — e.g. an unexpected opcode
    /// where the handshake expects WELCOME, or a response on an unknown
    /// stream.
    #[error("protocol violation: {0}")]
    Protocol(String),

    /// The server returned a structured ERROR frame in response to a
    /// request. The full payload is preserved for code/category branching.
    #[error("server error [{code:?} / {category:?}]: {message}")]
    Server {
        /// Specific error code; branch on this for programmatic handling.
        code: ErrorCodeWire,
        /// Coarse class of the failure, for deciding whether to retry at all.
        category: ErrorCategoryWire,
        /// Human-readable detail from the server.
        message: String,
        /// Server-supplied backoff hint, when it sent one.
        retry_after_ms: Option<u32>,
        /// The full decoded ERROR payload, kept so no field is lost to this
        /// projection.
        response: Box<ErrorResponse>,
    },

    /// The server chose a wire version the client does not support. Versions
    /// are `u8` on the wire (HELLO `supported_versions` / WELCOME
    /// `chosen_version`).
    #[error("version mismatch: server chose {chosen}, client supports {supported:?}")]
    VersionMismatch {
        /// The version the server picked in WELCOME.
        chosen: u8,
        /// The versions this client offered in HELLO.
        supported: Vec<u8>,
    },

    /// The peer closed the connection (read returned zero bytes).
    #[error("connection closed by peer")]
    Closed,

    /// An operation did not complete within its deadline.
    #[error("operation timed out after {0:?}")]
    Timeout(Duration),
}

impl BrainError {
    /// Build a [`BrainError::Server`] from a decoded ERROR payload.
    #[must_use]
    pub fn from_server(response: ErrorResponse) -> Self {
        BrainError::Server {
            code: response.code,
            category: response.category,
            message: response.message.clone(),
            retry_after_ms: response.retry_after_ms,
            response: Box::new(response),
        }
    }

    /// Whether retrying the operation could plausibly succeed. A transient
    /// transport drop or a resource-exhaustion / unavailable server verdict
    /// is retryable; a malformed-input or auth verdict is not. Consumed by
    /// [`crate::retry::with_retry`].
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            BrainError::Io(_) | BrainError::Closed | BrainError::Timeout(_) => true,
            BrainError::Server { category, .. } => matches!(
                category,
                ErrorCategoryWire::ResourceExhausted | ErrorCategoryWire::Unavailable
            ),
            _ => false,
        }
    }

    /// The server-requested cool-off before retrying, when the ERROR carried a
    /// `retry_after_ms`. The retry combinator prefers this over its own
    /// backoff schedule.
    #[must_use]
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            BrainError::Server {
                retry_after_ms: Some(ms),
                ..
            } => Some(Duration::from_millis(u64::from(*ms))),
            _ => None,
        }
    }
}
