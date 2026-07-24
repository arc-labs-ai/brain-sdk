//! Ergonomic request builders for the v1 verbs.
//!
//! The wire structs in [`crate::wire::types`] mirror the protocol exactly —
//! every field present, in wire order. That is what the codec needs, but it is
//! a poor calling convention: most fields have an obvious default and only a
//! few matter per call. These builders fill the defaults, mint a `request_id`,
//! and expose just the knobs a caller tunes. The verbs on [`crate::BrainClient`]
//! accept either the builder (via `.build()`) or a hand-built wire struct.

use crate::client::new_id;
use crate::wire::types::{
    ActAs, EncodeRequest, ForgetMode, ForgetRequest, MemoryKindWire, RecallRequest, WaitMode,
    WireMemoryId,
};

/// Builder for an ENCODE request. Stores one text memory; `session` defaults
/// to 0 and `occurred_at` is unset (the server stamps ingest time).
#[derive(Clone, Debug)]
pub struct EncodeBuilder {
    text: String,
    session_id: u64,
    occurred_at_unix_nanos: Option<u64>,
    act_as: Option<ActAs>,
    wait: WaitMode,
    allow_duplicates: bool,
}

impl EncodeBuilder {
    /// Start an ENCODE for `text` (session 0, no explicit occurred-at).
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            session_id: 0,
            occurred_at_unix_nanos: None,
            act_as: None,
            wait: WaitMode::Ack,
            allow_duplicates: false,
        }
    }

    /// Set the write-completion mode. [`WaitMode::Ack`] (the default) returns
    /// after the durable ack; [`WaitMode::Derived`] blocks until async
    /// derivation completes and returns a populated `trace` on the
    /// [`EncodeResponse`].
    #[must_use]
    pub fn wait(mut self, wait: WaitMode) -> Self {
        self.wait = wait;
        self
    }

    /// Block until async derivation completes and return the full write trace
    /// — convenience for `.wait(WaitMode::Derived)`.
    #[must_use]
    pub fn wait_derived(mut self) -> Self {
        self.wait = WaitMode::Derived;
        self
    }

    /// Run this encode on behalf of another `(namespace, space_id)` identity.
    /// Requires the connection principal to hold the `can_act_as` grant; set
    /// per request, never on the client, so a pooled client can serve many
    /// effective identities.
    #[must_use]
    pub fn act_as(mut self, namespace: impl Into<String>, space_id: impl Into<String>) -> Self {
        self.act_as = Some(ActAs {
            namespace: namespace.into(),
            space_id: space_id.into(),
        });
        self
    }

    /// Set the session (conversation) the memory belongs to.
    #[must_use]
    pub fn session(mut self, session_id: u64) -> Self {
        self.session_id = session_id;
        self
    }

    /// Set the event time the memory describes (unix nanos). Unset means the
    /// server stamps the ingest time.
    #[must_use]
    pub fn occurred_at(mut self, occurred_at_unix_nanos: u64) -> Self {
        self.occurred_at_unix_nanos = Some(occurred_at_unix_nanos);
        self
    }

    /// Opt out of content dedup and force a distinct memory. By default Brain
    /// dedupes byte-identical text on `(space_id, session_id, BLAKE3(text))` and
    /// returns the existing memory (`was_deduplicated = true`) without writing.
    /// Call this when the same text is a genuinely distinct observation that
    /// must coexist (e.g. the same fact re-stated at a different `occurred_at`).
    #[must_use]
    pub fn allow_duplicates(mut self, allow: bool) -> Self {
        self.allow_duplicates = allow;
        self
    }

    /// Finish into a wire [`EncodeRequest`], minting a fresh `request_id`.
    #[must_use]
    pub fn build(self) -> EncodeRequest {
        EncodeRequest {
            text: self.text,
            session_id: self.session_id,
            request_id: new_id(),
            txn_id: None,
            occurred_at_unix_nanos: self.occurred_at_unix_nanos,
            act_as: self.act_as,
            wait: self.wait,
            allow_duplicates: self.allow_duplicates,
        }
    }
}

/// Builder for a RECALL request. Defaults answer the cue across all of the
/// agent's own memories with text and edges included; the server decides
/// whether the answer is a single memory, many memories, or none.
#[derive(Clone, Debug)]
pub struct RecallBuilder {
    cue_text: String,
    subject_name: String,
    max_results: u32,
    confidence_threshold: f32,
    session_filter: Option<Vec<u64>>,
    age_bound_unix_nanos: Option<u64>,
    as_of_record_time_unix_nanos: Option<u64>,
    kind_filter: Option<Vec<MemoryKindWire>>,
    salience_floor: f32,
    include_edges: bool,
    include_graph: bool,
    include_text: bool,
    trace: bool,
    act_as: Option<ActAs>,
}

impl RecallBuilder {
    /// Start a RECALL for `cue_text` (up to 10 results, text + edges, own
    /// agent only, no subject pin).
    #[must_use]
    pub fn new(cue_text: impl Into<String>) -> Self {
        Self {
            cue_text: cue_text.into(),
            subject_name: String::new(),
            max_results: 10,
            confidence_threshold: 0.0,
            session_filter: None,
            age_bound_unix_nanos: None,
            as_of_record_time_unix_nanos: None,
            kind_filter: None,
            salience_floor: 0.0,
            include_edges: true,
            include_graph: false,
            include_text: true,
            trace: false,
            act_as: None,
        }
    }

    /// Run this recall on behalf of another `(namespace, space_id)` identity.
    /// Requires the connection principal to hold the `can_act_as` grant; set
    /// per request, never on the client, so a pooled client can serve many
    /// effective identities.
    #[must_use]
    pub fn act_as(mut self, namespace: impl Into<String>, space_id: impl Into<String>) -> Self {
        self.act_as = Some(ActAs {
            namespace: namespace.into(),
            space_id: space_id.into(),
        });
        self
    }

    /// Pin the recall to a named subject (anchors fact-shaped lookups).
    #[must_use]
    pub fn subject(mut self, name: impl Into<String>) -> Self {
        self.subject_name = name.into();
        self
    }

    /// Cap the number of results returned.
    #[must_use]
    pub fn max_results(mut self, max_results: u32) -> Self {
        self.max_results = max_results;
        self
    }

    /// Recall as the graph stood at this record time (unix nanos).
    #[must_use]
    pub fn as_of(mut self, as_of_record_time_unix_nanos: u64) -> Self {
        self.as_of_record_time_unix_nanos = Some(as_of_record_time_unix_nanos);
        self
    }

    /// Drop results below this confidence (0.0..=1.0).
    #[must_use]
    pub fn confidence_threshold(mut self, threshold: f32) -> Self {
        self.confidence_threshold = threshold;
        self
    }

    /// Restrict to these sessions.
    #[must_use]
    pub fn sessions(mut self, sessions: Vec<u64>) -> Self {
        self.session_filter = Some(sessions);
        self
    }

    /// Restrict to these memory kinds.
    #[must_use]
    pub fn kinds(mut self, kinds: Vec<MemoryKindWire>) -> Self {
        self.kind_filter = Some(kinds);
        self
    }

    /// Drop results below this salience floor.
    #[must_use]
    pub fn salience_floor(mut self, floor: f32) -> Self {
        self.salience_floor = floor;
        self
    }

    /// Include the per-result local edge set.
    #[must_use]
    pub fn include_edges(mut self, include: bool) -> Self {
        self.include_edges = include;
        self
    }

    /// Include graph enrichment (entities / statements / relations).
    #[must_use]
    pub fn include_graph(mut self, include: bool) -> Self {
        self.include_graph = include;
        self
    }

    /// Ask for the per-stage read-pipeline trace on the final frame
    /// (`RecallResponseFrame::trace`). Off by default; costs nothing when off.
    #[must_use]
    pub fn trace(mut self, trace: bool) -> Self {
        self.trace = trace;
        self
    }

    /// Include the stored memory text in each result.
    #[must_use]
    pub fn include_text(mut self, include: bool) -> Self {
        self.include_text = include;
        self
    }

    /// Finish into a wire [`RecallRequest`], minting a fresh `request_id`.
    #[must_use]
    pub fn build(self) -> RecallRequest {
        RecallRequest {
            cue_text: self.cue_text,
            subject_name: self.subject_name,
            max_results: self.max_results,
            confidence_threshold: self.confidence_threshold,
            session_filter: self.session_filter,
            age_bound_unix_nanos: self.age_bound_unix_nanos,
            as_of_record_time_unix_nanos: self.as_of_record_time_unix_nanos,
            kind_filter: self.kind_filter,
            salience_floor: self.salience_floor,
            include_edges: self.include_edges,
            include_graph: self.include_graph,
            include_text: self.include_text,
            request_id: Some(new_id()),
            txn_id: None,
            trace: self.trace,
            act_as: self.act_as,
        }
    }
}

/// Builder for a FORGET request. Defaults to a soft forget (tombstone with a
/// grace period); `.hard()` zeroes immediately.
#[derive(Clone, Debug)]
pub struct ForgetBuilder {
    memory_id: WireMemoryId,
    mode: ForgetMode,
    act_as: Option<ActAs>,
}

impl ForgetBuilder {
    /// Start a soft FORGET of `memory_id`.
    #[must_use]
    pub fn new(memory_id: WireMemoryId) -> Self {
        Self {
            memory_id,
            mode: ForgetMode::Soft,
            act_as: None,
        }
    }

    /// Run this forget on behalf of another `(namespace, space_id)` identity.
    /// Requires the connection principal to hold the `can_act_as` grant; set
    /// per request, never on the client, so a pooled client can serve many
    /// effective identities.
    #[must_use]
    pub fn act_as(mut self, namespace: impl Into<String>, space_id: impl Into<String>) -> Self {
        self.act_as = Some(ActAs {
            namespace: namespace.into(),
            space_id: space_id.into(),
        });
        self
    }

    /// Switch to a hard forget (immediate zeroing, no grace period).
    #[must_use]
    pub fn hard(mut self) -> Self {
        self.mode = ForgetMode::Hard;
        self
    }

    /// Set the forget mode explicitly.
    #[must_use]
    pub fn mode(mut self, mode: ForgetMode) -> Self {
        self.mode = mode;
        self
    }

    /// Finish into a wire [`ForgetRequest`], minting a fresh `request_id`.
    #[must_use]
    pub fn build(self) -> ForgetRequest {
        ForgetRequest {
            memory_id: self.memory_id,
            mode: self.mode,
            request_id: new_id(),
            txn_id: None,
            act_as: self.act_as,
        }
    }
}
