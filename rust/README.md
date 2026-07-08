# brain-db-sdk (Rust)

The Rust client for the Brain memory database. Speaks Brain's BRN0 wire
protocol directly; no dependency on Brain's internal code.

**Status: multiplexed client (Phase 3 wired in).** The wire codec (Phase 1) is
**verified byte-for-byte against the shared conformance corpus** (all 38
`.bin`/`.json` cases re-encode to identical bytes). On top of it: an async
[`transport`], a [`MuxConnection`] that splits the socket and runs a background
reader task demultiplexing responses by `stream_id`, and a high-level
[`BrainClient`] built on it — so **every verb takes `&self` and many requests
run in flight at once over one connection** (share a client across tasks behind
an `Arc`). The full v1 + typed-graph API is present: `encode()`, `recall()`
(streaming to EOS / `recall_frames()`), `forget()`, `create_entity()`,
`create_statement()`, `create_relation()`, `upload_schema()`,
`materialize_procedural()` — each with an ergonomic builder, plus a retry layer
(`RetryPolicy` + the free `with_retry` combinator). The connection pool and
transparent reconnect are later work; the serial one-at-a-time [`Connection`]
remains for callers who want it.

The connection is async (tokio); the wire codec stays runtime-agnostic. The
full build plan is in the repo-root [`../PLAN.md`](../PLAN.md); the layered
architecture is in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

```rust
use brain_db_sdk::{BrainClient, EncodeBuilder, RecallBuilder, ForgetBuilder};

let client = BrainClient::connect(addr).await?;
let stored = client.encode(&EncodeBuilder::new("the user prefers dark mode").build()).await?;
// Recall answers like a real memory: a grounded value, a set, or episodic hits.
let answer = client.recall(&RecallBuilder::new("ui preferences").max_results(5).build()).await?;
for hit in answer.episodic() {
    println!("{}", hit.text);
}
client.forget(&ForgetBuilder::new(stored.memory_id).build()).await?;
client.close().await?;
```

Verbs take `&self`, so a shared client serves concurrent requests and the free
`with_retry` combinator wraps a verb directly — the stable `request_id` each
builder mints makes the resend idempotent; the backoff honors a server
`retry_after_ms`:

```rust
use brain_db_sdk::{with_retry, RetryPolicy};

let req = ForgetBuilder::new(stored.memory_id).build();
let resp = with_retry(&RetryPolicy::default(), || client.forget(&req)).await?;
```

```bash
cargo test          # unit + conformance + handshake + verbs + retry (mock-server round-trips)
cargo clippy --all-targets
```

The `live_server_handshake` integration test runs against a real server when
`BRAIN_TEST_ADDR=host:port` is set, and is skipped otherwise.

License: Apache-2.0.

[`transport`]: src/transport.rs
[`Connection`]: src/connection.rs
[`BrainClient`]: src/client.rs
[`MuxConnection`]: src/mux.rs

The verb builders live in [`src/verbs.rs`](src/verbs.rs).
