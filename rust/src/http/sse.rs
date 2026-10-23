//! The change feed over Server-Sent Events.
//!
//! [`Subscription`] is drained with `next().await`, deliberately the same
//! shape the native wire client's subscription has — a caller moving between
//! the two tiers rewrites the construction, not the loop.
//!
//! Unsubscribing is dropping the handle. The edge tears the Brain-side
//! subscription down when the HTTP response closes, which is what dropping
//! this does, so there is no teardown call to forget.

use futures_util::{Stream, StreamExt};

use super::error::BrainHttpError;
use super::types::{SubscriptionClosed, SubscriptionEvent};

/// What arrived on the feed.
#[derive(Clone, Debug)]
pub enum FeedItem {
    /// A change.
    Event(Box<SubscriptionEvent>),
    /// The feed closed. Always the last item, and it carries where the feed
    /// got to so the next connection can resume exactly rather than guess.
    Closed(SubscriptionClosed),
}

/// A live change feed.
///
/// Holds the HTTP response open, so a caller that stops draining it
/// backpressures the edge — which backpressures Brain — rather than letting
/// events pile up unbounded.
pub struct Subscription {
    stream: Box<dyn Stream<Item = reqwest::Result<bytes::Bytes>> + Send + Unpin>,
    /// Bytes received but not yet forming a complete frame.
    buf: Vec<u8>,
    /// Field accumulator for the frame being built.
    event_name: Option<String>,
    data: String,
    last_id: Option<String>,
    done: bool,
}

impl std::fmt::Debug for Subscription {
    /// Hand-written: the boxed stream is not `Debug`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("last_id", &self.last_id)
            .field("done", &self.done)
            .finish_non_exhaustive()
    }
}

impl Subscription {
    pub(crate) fn new(resp: reqwest::Response) -> Self {
        Self {
            stream: Box::new(resp.bytes_stream()),
            buf: Vec::new(),
            event_name: None,
            data: String::new(),
            last_id: None,
            done: false,
        }
    }

    /// The id of the most recent event — its LSN.
    ///
    /// Pass it as `from_lsn` on a reconnect to resume after it. Kept on the
    /// handle so a caller that loses the connection mid-loop still has it;
    /// the alternative is remembering every event's lsn yourself purely to
    /// know where you were.
    #[must_use]
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }

    /// The next item, or `None` once the feed has ended.
    ///
    /// # Errors
    /// A transport failure, or a frame whose JSON does not decode.
    pub async fn next(&mut self) -> Option<Result<FeedItem, BrainHttpError>> {
        if self.done {
            return None;
        }
        loop {
            // Anything already buffered may complete a frame without another
            // read — a single TCP segment often carries several events.
            if let Some(item) = self.take_frame() {
                return Some(item);
            }
            match self.stream.next().await {
                Some(Ok(chunk)) => self.buf.extend_from_slice(&chunk),
                Some(Err(e)) => {
                    self.done = true;
                    return Some(Err(BrainHttpError::transport(format!(
                        "read subscription stream: {e}"
                    ))));
                }
                None => {
                    self.done = true;
                    // A clean close with nothing pending is the end of the
                    // feed, not an error: the edge closes after its terminal
                    // event, and the caller has already seen that.
                    return None;
                }
            }
        }
    }

    /// Pull one complete SSE frame out of the buffer, if there is one.
    fn take_frame(&mut self) -> Option<Result<FeedItem, BrainHttpError>> {
        while let Some(end) = self.buf.iter().position(|b| *b == b'\n') {
            // `\r\n` is as legal as `\n`; servers and proxies differ.
            let mut line = self.buf.drain(..=end).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();

            if line.is_empty() {
                // Blank line dispatches the frame.
                if self.data.is_empty() {
                    // A keep-alive comment produces no data; nothing to
                    // dispatch, keep reading.
                    self.event_name = None;
                    continue;
                }
                let name = self.event_name.take();
                let data = std::mem::take(&mut self.data);
                return Some(Self::decode(name.as_deref(), &data));
            }
            // A comment — the keep-alive the edge sends on an idle feed.
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => self.event_name = Some(value.to_owned()),
                "id" => self.last_id = Some(value.to_owned()),
                "data" => {
                    if !self.data.is_empty() {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                // `retry` and anything unknown are ignored, per the SSE spec.
                _ => {}
            }
        }
        None
    }

    fn decode(name: Option<&str>, data: &str) -> Result<FeedItem, BrainHttpError> {
        if name == Some("closed") {
            return serde_json::from_str(data)
                .map(FeedItem::Closed)
                .map_err(|e| BrainHttpError::transport(format!("decode subscription close: {e}")));
        }
        serde_json::from_str(data)
            .map(|e| FeedItem::Event(Box::new(e)))
            .map_err(|e| BrainHttpError::transport(format!("decode subscription event: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the frame parser directly: it is the part with the logic, and it
    /// needs no socket.
    fn feed(chunks: &[&str]) -> Vec<FeedItem> {
        let mut sub = Subscription {
            stream: Box::new(futures_util::stream::empty()),
            buf: Vec::new(),
            event_name: None,
            data: String::new(),
            last_id: None,
            done: false,
        };
        let mut out = Vec::new();
        for c in chunks {
            sub.buf.extend_from_slice(c.as_bytes());
            while let Some(item) = sub.take_frame() {
                out.push(item.expect("frame decodes"));
            }
        }
        out
    }

    const EVENT: &str = r#"{"event_type":"encoded","memory_id":"5","session_id":1,"text":"hi","kind":1,"salience":0.5,"timestamp_unix_nanos":7,"lsn":42}"#;

    #[test]
    fn a_frame_split_across_chunks_still_arrives() {
        // A TCP read boundary falls wherever it falls; a parser that assumed
        // one chunk per frame would drop events under load and nowhere else.
        let items = feed(&["id: 42\ndata: ", EVENT, "\n\n"]);
        assert_eq!(items.len(), 1);
        let FeedItem::Event(e) = &items[0] else {
            panic!("expected an event")
        };
        assert_eq!(e.lsn, 42);
        assert_eq!(e.memory_id, "5");
    }

    #[test]
    fn several_frames_in_one_chunk_all_arrive() {
        let one = format!("id: 1\ndata: {EVENT}\n\nid: 2\ndata: {EVENT}\n\n");
        assert_eq!(feed(&[&one]).len(), 2);
    }

    #[test]
    fn keepalive_comments_are_not_events() {
        let items = feed(&[": keepalive\n\n", &format!("data: {EVENT}\n\n")]);
        assert_eq!(items.len(), 1, "the comment produced no item");
    }

    #[test]
    fn crlf_line_endings_parse() {
        let items = feed(&[&format!("id: 9\r\ndata: {EVENT}\r\n\r\n")]);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn the_terminal_event_is_distinguished_by_its_name() {
        let items = feed(&[r#"event: closed
data: {"final_lsn":99,"reason":"unsubscribed"}

"#]);
        let FeedItem::Closed(c) = &items[0] else {
            panic!("expected the close")
        };
        assert_eq!(c.final_lsn, 99);
        assert_eq!(c.reason, "unsubscribed");
    }

    #[test]
    fn the_last_id_is_remembered_for_resumption() {
        let mut sub = Subscription {
            stream: Box::new(futures_util::stream::empty()),
            buf: format!("id: 7\ndata: {EVENT}\n\n").into_bytes(),
            event_name: None,
            data: String::new(),
            last_id: None,
            done: false,
        };
        let _ = sub.take_frame();
        // Without this a caller that loses the connection mid-loop has to
        // have tracked every event's lsn itself just to know where it was.
        assert_eq!(sub.last_event_id(), Some("7"));
    }
}
