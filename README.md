# brain-sdk

First-party client SDKs for the [Brain](https://github.com/brain-db-io/brain-db) memory database, in **Rust**, **Python**, and **TypeScript**. (`brain-sdk` is the repo; the published packages are named `brain-db-sdk` / `@brain-db/sdk` — see the table below.)

Brain ships no client of its own — its public interface is a binary wire protocol over TCP: a 32-byte `BRN0` frame header plus CBOR payloads. Each SDK here re-implements that protocol independently and hand-written, so a Brain server can be driven from any of the three languages without a server-side dependency.

A shared **conformance corpus** (vendored from Brain's reference implementation) is the byte-level drift guard every SDK tests against: each language decodes all 38 golden `.bin`/`.json` cases and re-encodes them to identical bytes, so all three agree on the wire.

**Status: feature-complete, pre-1.0.** Every SDK implements the full client surface — wire codec, async transport, handshake, a multiplexed connection (concurrent requests over one socket, demultiplexed by `stream_id`), the v1 verbs (`encode` / `recall` streaming / `forget`) with ergonomic builders, a retry layer (exponential backoff honoring the server's `retry_after_ms`), and the typed-graph verbs (`entity` / `statement` / `relation` / `schema` / `query` / `materialize_procedural`). Connection pooling, transparent reconnect, and registry publishing are the remaining work.

## Layout

Published package names share the `brain-db` identity:

| Dir | Registry | Package | Import | Status |
|---|---|---|---|---|
| [`rust/`](rust/) | crates.io | `brain-db-sdk` | `brain_db_sdk` | feature-complete |
| [`python/`](python/) | PyPI | `brain-db-sdk` | `brain_db_sdk` | feature-complete |
| [`typescript/`](typescript/) | npm | `@brain-db/sdk` | `@brain-db/sdk` | feature-complete |
| [`conformance/`](conformance/) | — | shared golden corpus | — | 38 cases, byte-verified |

Each package has its own README with a quickstart and the exact test commands.

## Wire-version compatibility

All three SDKs target Brain wire protocol **version 1** (the `version` byte in the `BRN0` header; clients advertise `supported_versions = [1]` in HELLO). A server that negotiates any other version is rejected with a clear `VersionMismatch`.

## Tests

Each SDK is verified independently against the shared corpus plus in-process mock-server round-trips (handshake, streaming recall, retry recovery, concurrent multiplexing, typed-graph verbs):

```bash
cd rust       && cargo test
cd python     && python3 -m venv .venv && .venv/bin/pip install cbor2 pytest && PYTHONPATH=src .venv/bin/python -m pytest tests/ -q
cd typescript && npm install && npm test
```

## License

Apache-2.0 — see [`LICENSE`](LICENSE). © 2026 Niraj Georgian.
