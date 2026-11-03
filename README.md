# brain-sdk

First-party client SDKs for the [Brain](https://github.com/arc-labs-ai/brain-db) memory database, in **Rust**, **Python** and **TypeScript**.

Brain stores what your application learns and hands it back when something is relevant. These are the clients your code uses to talk to it: write memories, recall them by meaning, and read and shape the typed graph Brain builds out of them.

```bash
cargo add brain-db-sdk        # Rust  — MSRV 1.75, needs a tokio runtime
pip install brain-db-sdk      # Python — 3.10+
npm install @brain-db/sdk     # TypeScript — Node 18+, ESM only
```

| Dir | Registry | Package | Import |
|---|---|---|---|
| [`rust/`](rust/) | crates.io | `brain-db-sdk` | `brain_db_sdk` |
| [`python/`](python/) | PyPI | `brain-db-sdk` | `brain_db_sdk` |
| [`typescript/`](typescript/) | npm | `@brain-db/sdk` | `@brain-db/sdk` |

Each package has its own README with a quickstart, the full verb surface, and its test commands.

## Two transports

Every SDK can reach Brain two ways, and which you want depends on where Brain is.

**The native wire** — Brain's own interface, a binary protocol over TCP: a 32-byte `BRN0` frame header plus CBOR payloads. Each SDK re-implements it by hand, so a Brain server can be driven from any of the three languages with no server-side dependency. Use it when you can open a socket to Brain. It is the only transport with streaming recall, transactions and typed-graph management.

**The HTTP tier** — JSON over HTTP to a Brain HTTP edge: `brain-edge` self-hosted, or the Arc cloud gateway. Server-Sent Events carry the change feed. Same verb names and field names in all three languages, against one contract ([`contract/http-routes.json`](contract/http-routes.json)). Use it when Brain sits behind a gateway rather than on a socket you can open, and you authenticate with an API key.

## What they do

The surface is the same in all three, in each language's own casing:

| | |
|---|---|
| **Memories** | write, recall by meaning, forget, link and unlink |
| **Ask** | plan, reason, and explain or trace a query |
| **Typed graph** | entities, statements and relations — create, read, supersede, retract, tombstone |
| **Schema** | upload, validate, replace, drop, materialize procedural |
| **Transactions** | begin, commit, abort |
| **Change feed** | subscribe to changes as they land |
| **Spaces & sessions** | the per-request isolation unit, and conversation groupings |

Each client multiplexes: one connection carries many requests at once, demultiplexed by `stream_id`, so verbs are concurrency-safe. Each ships a round-robin pool whose healthy-member accessor replaces a connection whose peer has gone away, and a retry layer with exponential backoff and full jitter that honors a server-sent `retry_after_ms` as its floor.

## One wire, three implementations

The three SDKs share no code, so the thing that keeps them honest is a **conformance corpus** vendored from Brain's reference implementation. Each language decodes all 158 golden `.bin`/`.json` cases and re-encodes them to identical bytes. A change that would drift one SDK off the wire fails its own test suite rather than surfacing as a mystery at runtime.

The wire transport targets Brain wire protocol **version 1** (the `version` byte in the `BRN0` header; clients advertise `supported_versions = [1]` in HELLO). A server negotiating any other version is rejected with a clear `VersionMismatch`. The HTTP tier is versioned by its route prefix and does not negotiate.

## Tests

Each SDK is verified independently against the corpus plus in-process mock-server round-trips — handshake, streaming recall, retry recovery, concurrent multiplexing, typed-graph verbs. None of these need a running Brain; the integration suites that do are skipped unless `BRAIN_SDK_IT_*` is set.

```bash
cd rust       && cargo test
cd python     && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && .venv/bin/python -m pytest tests/ -q
cd typescript && npm install && npm test
```

The Python line installs the `dev` extra rather than naming packages one by one, and that matters: `pyproject.toml` sets `asyncio_mode = "auto"`, so without `pytest-asyncio` every `tests/aio_*` case fails on collection rather than skipping.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). © 2026 Niraj Georgian.
