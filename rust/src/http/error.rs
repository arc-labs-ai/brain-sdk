//! The one error type the HTTP client returns.

use std::fmt;

/// One per-field problem from a validation failure, as the cloud gateway's
/// RFC 9457 body reports them in `errors[]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
    /// The request field that was rejected, e.g. `"email"`.
    pub field: String,
    /// A stable per-field code, when the server sends one.
    pub code: Option<String>,
    /// What is wrong with that field.
    pub message: String,
}

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
    /// Per-field problems on a validation failure, when the server reports
    /// them. Empty for every other failure, and for a server that answers with
    /// the edge's `{ error: { code, message } }` envelope.
    pub field_errors: Vec<FieldError>,
}

impl BrainHttpError {
    /// A transport-level failure (could not complete the request).
    pub(crate) fn transport(message: impl Into<String>) -> Self {
        Self {
            status: 0,
            code: "transport".into(),
            message: message.into(),
            field_errors: Vec::new(),
        }
    }

    /// Read an error body in either shape a Brain HTTP server sends:
    /// brain-edge's `{ "error": { code, message } }`, or the cloud gateway's
    /// RFC 9457 `application/problem+json` (`{ code, title, detail, errors[] }`).
    /// Falls back to the raw body when it is neither.
    pub(crate) fn from_body(status: u16, body: &str) -> Self {
        let (mut code, mut message) = ("http_error".to_string(), format!("HTTP {status}"));
        let mut field_errors = Vec::new();
        match serde_json::from_str::<serde_json::Value>(body) {
            Ok(v) => {
                if let Some(err) = v.get("error").filter(|e| e.is_object()) {
                    if let Some(c) = err.get("code").and_then(|c| c.as_str()) {
                        code = c.to_string();
                    }
                    if let Some(m) = err.get("message").and_then(|m| m.as_str()) {
                        message = m.to_string();
                    }
                } else if let Some(c) = v.get("code").and_then(|c| c.as_str()) {
                    code = c.to_string();
                    if let Some(m) = v
                        .get("detail")
                        .and_then(|d| d.as_str())
                        .or_else(|| v.get("title").and_then(|t| t.as_str()))
                    {
                        message = m.to_string();
                    }
                    field_errors = parse_field_errors(v.get("errors"));
                    if !field_errors.is_empty() {
                        // "one or more fields are invalid" says nothing; name
                        // the fields.
                        message = field_errors
                            .iter()
                            .map(|e| format!("{}: {}", e.field, e.message))
                            .collect::<Vec<_>>()
                            .join("; ");
                    }
                }
            }
            // Not JSON — keep the raw text rather than a bare "HTTP 500".
            Err(_) if !body.is_empty() => message = body.to_string(),
            Err(_) => {}
        }
        Self {
            status,
            code,
            message,
            field_errors,
        }
    }
}

/// The well-formed entries of an RFC 9457 `errors[]`. An entry without both a
/// `field` and a `message` is dropped rather than rendered as a half-empty
/// "`: `" line in the joined message.
fn parse_field_errors(errors: Option<&serde_json::Value>) -> Vec<FieldError> {
    let Some(items) = errors.and_then(|e| e.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|e| {
            Some(FieldError {
                field: e.get("field")?.as_str()?.to_string(),
                code: e.get("code").and_then(|c| c.as_str()).map(str::to_string),
                message: e.get("message")?.as_str()?.to_string(),
            })
        })
        .collect()
}

impl fmt::Display for BrainHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{} {}] {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for BrainHttpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_edge_envelope_is_read() {
        let e = BrainHttpError::from_body(404, r#"{"error":{"code":"not_found","message":"no"}}"#);
        assert_eq!(
            (e.status, e.code.as_str(), e.message.as_str()),
            (404, "not_found", "no")
        );
        assert_eq!(e.field_errors, [] as [FieldError; 0]);
    }

    #[test]
    fn problem_json_field_errors_replace_the_useless_summary() {
        // A 422 whose message is "one or more fields are invalid" tells the
        // caller nothing; the per-field entries are the whole point of it.
        let e = BrainHttpError::from_body(
            422,
            r#"{"code":"validation_failed","title":"Unprocessable",
                "detail":"one or more fields are invalid",
                "errors":[{"field":"email","code":"format","message":"must be valid"},
                          {"field":"name","message":"required"},
                          {"code":"orphan"}]}"#,
        );
        assert_eq!(e.code, "validation_failed");
        assert_eq!(e.message, "email: must be valid; name: required");
        assert_eq!(
            e.field_errors.len(),
            2,
            "the entry with no field is dropped"
        );
        assert_eq!(e.field_errors[0].code.as_deref(), Some("format"));
        assert_eq!(e.field_errors[1].code, None);
    }

    #[test]
    fn problem_json_without_field_errors_falls_back_to_detail_then_title() {
        let detail =
            BrainHttpError::from_body(409, r#"{"code":"conflict","title":"T","detail":"D"}"#);
        assert_eq!(detail.message, "D");
        let title = BrainHttpError::from_body(409, r#"{"code":"conflict","title":"T"}"#);
        assert_eq!(title.message, "T");
        let neither = BrainHttpError::from_body(409, r#"{"code":"conflict"}"#);
        assert_eq!(neither.message, "HTTP 409");
    }

    #[test]
    fn a_non_json_body_is_kept_verbatim() {
        let e = BrainHttpError::from_body(502, "upstream exploded");
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("http_error", "upstream exploded")
        );
    }
}
