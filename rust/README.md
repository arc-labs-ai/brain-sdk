# brain-db-sdk (Rust)

The Rust client for the [Brain](https://github.com/arc-labs-ai/brain-db) memory database.

Brain stores what your application learns and hands it back when something is relevant. This crate is how a Rust program talks to it: write memories, recall them by meaning, and read and shape the typed graph Brain builds out of them.

```toml
[dependencies]
brain-db-sdk = "0.4"
```

MSRV 1.75, edition 2021, no cargo features — everything below builds unconditionally. The client is async and needs a **tokio** runtime; the wire codec itself is runtime-agnostic.

## Quickstart

```rust
use brain_db_sdk::{Auth, BrainClient, EncodeBuilder, RecallBuilder, ForgetBuilder};

// Auth is mandatory — there is no anonymous mode.
let client = BrainClient::connect(addr, Auth::Token(b"brain_...".to_vec())).await?;

let stored = client.encode(&EncodeBuilder::new("the user prefers dark mode").build()).await?;

let answer = client.recall(&RecallBuilder::new("ui preferences").max_results(5).build()).await?;
for hit in &answer.memories {
    println!("{}", hit.text);
}

client.forget(&ForgetBuilder::new(stored.memory_id).build()).await?;
client.close().await?;
```

`answer_kind` is `Single`, `Many`, or `None`. **`None` is an explicit "nothing I hold answers this"** — not an error, and not a nearest match returned out of politeness.

## What you can do

| | Verbs |
|---|---|
| **Memories** | `encode` · `recall` · `forget` · `link` / `unlink` · `encode_vector_direct` |
| **Ask** | `plan` · `reason` · `query_explain` / `query_trace` |
| **Entities** | `create_entity` · `get_entity` · `resolve_entity` · `list_entities` · `update_entity` · `rename_entity` · `merge_entities` / `unmerge_entity` · `tombstone_entity` |
| **Statements** | `create_statement` · `get_statement` · `list_statements` · `statement_history` · `supersede_statement` · `retract_statement` · `tombstone_statement` |
| **Relations** | `create_relation` · `get_relation` · `list_relations_from` / `list_relations_to` · `traverse_relations` · `supersede_relation` · `tombstone_relation` |
| **Schema** | `upload_schema` · `get_schema` · `list_schemas` · `validate_schema` · `replace_schema` · `drop_schema` · `materialize_procedural` |
| **Transactions** | `txn_begin` · `txn_commit` · `txn_abort` |
| **Change feed** | `subscribe` → [`Subscription`] |
| **Inspect** | `memory_list` · `memory_inspect` · `graph_fetch` · `capabilities` · `extractor_list` · `ping` |
| **Spaces & sessions** | `create_space` / `list_spaces` / `delete_space` · `create_session` / `list_sessions` / `delete_session` |

`encode`, `recall` and `forget` get ergonomic builders ([`EncodeBuilder`] / [`RecallBuilder`] / [`ForgetBuilder`] — the only three in [`verbs`]); every other verb takes a struct from [`wire::types`]. Every streaming verb has a `*_frames()` sibling that hands back raw frames instead of the drained projection.

## Concurrency

Every verb takes `&self`, so **one connection serves many requests at once**. [`MuxConnection`] runs a background reader that demultiplexes responses by `stream_id`; share a client across tasks behind an `Arc` rather than opening a socket per task.

[`Pool`] round-robins across several connections, and its `get_healthy()` replaces a member whose socket has died before handing it out — so a long-lived pool survives a server restart.

## Retry

`with_retry` wraps a verb directly. The stable `request_id` each builder mints makes the resend idempotent, and the backoff honors a server-sent `retry_after_ms` as a floor:

```rust
use brain_db_sdk::{with_retry, RetryPolicy};

let req = ForgetBuilder::new(stored.memory_id).build();
let resp = with_retry(&RetryPolicy::default(), || client.forget(&req)).await?;
```

## Configuration

`connect` uses `ClientConfig::new(auth)`: wire version 1, streaming advertised, a 10s connect timeout and a 30s per-request read timeout — except a `WaitMode::Derived` encode, which waits on the asynchronous half of the write under `derived_write_timeout` (`DEFAULT_DERIVED_WRITE_TIMEOUT`, 120s). Pass a tuned config to `connect_with`. There is deliberately no `Default`: a connection with no credential cannot exist.

## Two transports

The client above speaks Brain's **BRN0 wire protocol** straight to a socket, with no dependency on Brain's internal code. That is the one to use when you can open a TCP connection to Brain, and the only one with streaming, transactions and typed-graph management.

When Brain sits behind an HTTP edge — the Arc cloud gateway, or a self-hosted `brain-edge` — use [`BrainHttpClient`] instead. Same verb names, field names and error shape as the Python and TypeScript SDKs; the canonical contract is [`contract/http-routes.json`](https://github.com/arc-labs-ai/brain-sdk/blob/main/contract/http-routes.json).

```rust
use brain_db_sdk::http::{BrainHttpClient, EncodeInput, RecallInput};

// Key first, URL second.
let brain = BrainHttpClient::new(api_key, base_url);
let stored = brain.encode(&EncodeInput { text: "the kettle whistled".into(), ..Default::default() }).await?;
let answer = brain.recall(&RecallInput { query: "what whistled?".into(), max_results: Some(3), ..Default::default() }).await?;
```

> **`new` takes the API key first, the base URL second.** Both parameters are `impl Into<String>`, so a swapped call still compiles — and silently sends your URL as the bearer token. `BrainHttpClient::localhost(api_key)` is the one-argument form against `DEFAULT_BASE_URL` (`http://127.0.0.1:8080`).

The HTTP tier also carries the edge-only surface the wire client has no opcode for: the SSE change feed (`subscribe()` → `http::Subscription`) and the BYOK LLM-credential verbs (`put_llm_credential()` and friends). Failures surface as [`BrainHttpError`] (`status` + `code`); idempotent verbs retry under [`HttpRetryPolicy`], overridable with `.with_retry_policy(…)`, and the 30s `DEFAULT_TIMEOUT` with `.with_timeout(…)`.

## Tests

```bash
cargo test            # 180 tests across 32 suites, green with no server running
cargo clippy --all-targets
```

The wire codec is checked byte-for-byte against the shared conformance corpus: all 158 `.bin`/`.json` cases decode and re-encode to identical bytes, so this SDK and Brain cannot drift on the wire. The rest is mock-server round-trips — handshake, streaming recall, retry recovery, concurrent multiplexing, typed-graph verbs.

Integration suites run against a real server when `BRAIN_SDK_IT_DATA` is set and skip otherwise (`scripts/it-server.sh up` boots one and exports the vars; `BRAIN_SDK_IT_ADMIN`, `BRAIN_SDK_IT_ADMIN_SECRET` and `BRAIN_SDK_IT_NAMESPACE` all have defaults). Set `BRAIN_SDK_IT_REQUIRED=1` wherever a server is meant to be reachable, so a misconfigured one fails instead of reading as green.

Live HTTP edge smoke tests cover identity, capabilities, and an encode/recall/list/forget lifecycle across all three SDKs. From the repo root:

```bash
BRAIN_SDK_IT_HTTP=https://edge.example BRAIN_SDK_IT_HTTP_KEY=brain_… scripts/edge-it.sh
```

The crate exports its own release version as `SDK_VERSION`, taken from `CARGO_PKG_VERSION` so it cannot disagree with `Cargo.toml`.

The wire protocol is specified in [`brain-db`'s `spec/04_wire_protocol/`](https://github.com/arc-labs-ai/brain-db/tree/main/spec/04_wire_protocol).

License: Apache-2.0.

[`BrainHttpClient`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/http/client.rs
[`BrainHttpError`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/http/error.rs
[`HttpRetryPolicy`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/http/retry.rs
[`BrainClient`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/client.rs
[`MuxConnection`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/mux.rs
[`Subscription`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/mux.rs
[`Pool`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/pool.rs
[`verbs`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/verbs.rs
[`EncodeBuilder`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/verbs.rs
[`RecallBuilder`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/verbs.rs
[`ForgetBuilder`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/verbs.rs
[`wire::types`]: https://github.com/arc-labs-ai/brain-sdk/blob/main/rust/src/wire/types.rs
