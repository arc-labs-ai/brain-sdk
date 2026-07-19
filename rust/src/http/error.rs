//! The one error type the HTTP client returns.

use std::fmt;

/// A Brain HTTP edge failure. Mirrors the Python/TypeScript `BrainHttpError`:
/// `status` (`0` for transport failures), `code`, `message`.
#[derive(Clone, Debug)]
pub struct BrainHttpError {
    /// HTTP status, or `0` for a transport failure.
    pub status: u16,
    /// Stable error code (`"transport"` for network failures).
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

impl BrainHttpError {
    /// A transport-level failure (could not complete the request).
    pub(crate) fn transport(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            code: "transport".into(),
            message: message.into(),
        }
    }

    /// Parse the edge's `{ "error": { code, message } }` envelope; fall back to
    /// the raw body when it isn't that shape.
    pub(crate) fn from_body(status: u16, body: &str) -> Self {
        let (mut code, mut message) = ("http_error".to_string(), format!("HTTP {status}"));
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(err) = v.get("error") {
                if let Some(c) = err.get("code").and_then(|c| c.as_str()) {
                    code = c.to_string();
                }
                if let Some(m) = err.get("message").and_then(|m| m.as_str()) {
                    message = m.to_string();
                }
            }
        } else if !body.is_empty() {
            message = body.to_string();
        }
        Self {
            status,
            code,
            message,
        }
    }
}

impl fmt::Display for BrainHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{} {}] {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for BrainHttpError {}
