# brain-sdk — architecture

How the SDKs are built internally: the layer stack, the connection actor + stream multiplexer, the request queue and buffer/packet management, the error model, the command surface, and the design patterns that hold it together. Language-agnostic design; per-language realizations differ where noted (§9).

This is the *internal* architecture. The *wire contract* it implements is Brain's §04 (frame + CBOR + the three verbs); see [`PLAN.md`](PLAN.md) for that summary and the phase order.

---

## 1. Design goals (what every decision optimizes for)

1. **Spec-faithful, independently implemented.** No dependency on Brain's crates; the conformance corpus is the byte-level proof of correctness. (PLAN §key-decisions.)
2. **One TCP connection multiplexes many concurrent requests.** The protocol is built for this (`stream_id` demux, cross-stream interleave). The SDK must exploit it — not open a socket per request.
3. **Allocation-frugal on the hot path.** Encode/decode/serve should reuse buffers, not allocate per frame. The server is built this way; a client that allocates per request becomes the bottleneck.
4. **Backpressure is first-class, never "drop."** The protocol does flow control by stalling, not dropping (streaming §flow-control). The client mirrors that: bounded queues that apply backpressure to the caller.
5. **Errors are typed and classified, not strings.** Every wire `ErrorCode` maps to a typed error in a stable taxonomy with an explicit retryable/not verdict (§6).
6. **The same shape in three languages.** Rust is the reference; Python/TS mirror its layering so behavior and tests transfer.

---

## 2. The layer stack

```
┌──────────────────────────────────────────────────────────────┐
│ L6  Client API        BrainClient / pool / retry / idempotency │  user-facing
│                       observability hooks                      │
├──────────────────────────────────────────────────────────────┤
│ L5  Commands          encode()/recall()/forget() + builders,   │  typed verbs
│                       typed request/response structs            │
├──────────────────────────────────────────────────────────────┤
│ L4  Request queue     outbound queue, in-flight registry,      │  scheduling
│                       backpressure, pipelining, cancellation    │
├──────────────────────────────────────────────────────────────┤
│ L3  Stream mux        stream_id alloc, demux by stream_id,      │  the "connection
│     (Connection)      EOS/stream lifecycle, the connection actor│   actor"
├──────────────────────────────────────────────────────────────┤
│ L2  Payload codec     CBOR map <-> typed struct, + trailing     │  bytes <-> values
│                       raw LE-f32 vector section                  │
├──────────────────────────────────────────────────────────────┤
│ L1  Frame codec       32-byte BRN0 header, CRC32C, read         │  framing
│                       assembly, write coalescing, buffer pool    │
├──────────────────────────────────────────────────────────────┤
│ L0  Transport         TCP (+ optional TLS), socket options,     │  the wire
│                       connect / reconnect                        │
└──────────────────────────────────────────────────────────────┘
```

Each layer has one job and a narrow seam to the next. L0–L3 are protocol mechanics (shared shape across languages, validated by the corpus at L1/L2). L4–L6 are ergonomics + reliability.

---

## 3. L0 — Transport

- **TCP, optional TLS 1.3.** Default port per the server config (`listen_addr`). TLS is a wrapper at this layer; nothing above it changes.
- **Socket options** (match the server's keepalive posture, §04.01): `TCP_NODELAY` on (the SDK does its own write coalescing at L1 — see §5.2 — so Nagle would only add latency); `SO_KEEPALIVE` with idle 30s / interval 10s / retries 3 as the default detection budget; large `SO_RCVBUF`/`SO_SNDBUF` for throughput.
- **Connect** establishes the socket; the handshake (L3) runs immediately after before any user request is admitted.
- **Reconnect** is owned here mechanically but driven by the connection state machine (§3.3): exponential backoff with jitter, capped.

---

## 4. L1 — Frame codec (buffers + packets)

The 32-byte `BRN0` header is fixed and portable (already in each scaffold's `wire/frame`). The interesting engineering is **buffer management** — getting frames on and off the socket without per-frame allocation.

### 4.1 Read path — frame reassembly

TCP is a byte stream; frames don't align to `read()` boundaries. The reader maintains a growable **read buffer** and a small state machine:

```
state NeedHeader(have < 32):   read into buf; once >=32, parse+validate header,
                               learn payload_len, transition.
state NeedPayload(need N):      read until buf has 32+N; verify payload CRC; emit
                               one Frame referencing the slice; compact the buffer.
```

- **Header validation before allocation.** Parse magic/version/reserved, verify `header_crc32c`, read `payload_len` (u24), and **reject `payload_len > MAX_PAYLOAD_BYTES` (16 MiB−1) before reserving payload space** — the same pre-alloc cap the server enforces. This is the client-side guard against a hostile/again corrupt length. (Mirrors the server bug class audited as P1-1.)
- **CRC verify on every frame** (header + payload, CRC32C). A mismatch is fail-stop for the connection, not a per-frame skip — a corrupt frame means the stream is desynchronized.
- **Buffer compaction, not reallocation.** After emitting a frame, the consumed prefix is dropped by advancing a read cursor; the buffer is compacted (memmove the tail to front) only when the cursor passes a threshold, so steady-state reading reuses one buffer. A ring/`BytesMut`-style buffer (Rust `bytes::BytesMut`, TS a cursor over a growable `Uint8Array`, Python a `bytearray` + memoryview) gives O(1) slicing without copying payloads out.

### 4.2 Write path — packet coalescing

Naively, each request = one `write()` syscall. Under pipelining (many small ENCODEs), that's syscall-bound. The writer **coalesces**:

- A bounded **outbound byte queue**: encoded frames are appended to a single write buffer; the writer task flushes opportunistically — when the queue drains to the socket, it writes *everything pending in one `writev`/`write`*, then awaits writability.
- This batches N queued frames into 1–few syscalls under load, and degrades to 1 frame = 1 write when idle (no added latency). `TCP_NODELAY` ensures the OS doesn't re-buffer on top.
- **Vectored I/O** where available (`writev`): header and payload (and the raw-vector trailer) are separate slices — vectored write avoids concatenating them into a temp buffer.

### 4.3 Buffer pooling

- A small **free-list pool** of byte buffers for encode scratch + read buffers, sized to the steady-state frame size. Acquire on encode, release after the frame is on the wire. Eliminates the per-request `Vec`/`Buffer`/`bytearray` churn that otherwise dominates a high-QPS client's allocation profile.
- Pool is bounded; on exhaustion it allocates (never blocks) — the pool is an optimization, not a semaphore.

---

## 5. L2 — Payload codec (CBOR + vector trailer)

- **Structured section = CBOR map**, one map per opcode, fields per the §05 schema. Each language uses a byte-string-aware, deterministic CBOR lib (Rust `ciborium`, Python `cbor2`, TS `cbor-x`/`cborg`). The three cross-language invariants the corpus enforces:
  - **IDs / `[u8;N]` / fingerprints → CBOR byte strings** (major type 2), not int-arrays/strings. (This was the P1-1 wire bug; the corpus pins it.)
  - **Enums → integer discriminants** (`MemoryKind`, `ForgetMode`, `AuthMethod`).
  - **f32 fields → 32-bit floats** on the wire.
- **Trailing raw vector section.** For vector-bearing ops (`ENCODE_VECTOR_DIRECT`, cue-vector RECALL), the embedding is **not** in the CBOR — it's a raw little-endian f32 block appended after the CBOR section. The codec returns `(struct, Option<&[f32]>)` on decode and takes the same on encode. Zero-copy on the vector: the f32 block is a view into the frame buffer, not re-parsed element-by-element.
- **Determinism.** Encoding is reproducible (fixed field order, shortest-form ints) — required so request fingerprints (idempotency) and the golden corpus are stable. Not full RFC-8949 key-sort canonical; schema-order is the contract.

---

## 6. L3 — Stream multiplexer (the connection actor)

This is the heart of the SDK: **one connection, many concurrent in-flight requests**, demuxed by `stream_id`.

### 6.1 The actor model

The connection is owned by a single **reader task** and a single **writer task** (or one task driving both halves), never shared mutably across callers. Callers interact via channels. This is the actor pattern — it makes "single owner of the socket" structural, the same discipline the server uses (single-writer-per-shard).

```
caller ──Request{frame, reply: oneshot}──▶ [outbound queue] ──▶ writer task ──▶ socket
                                                                                  │
caller ◀──── oneshot / stream channel ◀── [in-flight registry] ◀── reader task ◀─┘
                                          (keyed by stream_id)
```

### 6.2 stream_id allocation

- Client-initiated streams use **odd IDs**, incremented by 2, wrapping on u32 overflow and **skipping IDs still in flight** (per streaming spec). Stream 0 is reserved for connection-level frames (handshake).
- An allocator hands out the next free odd id; it consults the in-flight registry to skip live ones on wrap.
- Reuse-while-in-flight is a client bug the server rejects with `StreamIdInUse` (0x0063) — the allocator's contract prevents it.

### 6.3 In-flight registry + demux

- A map `stream_id → pending`. `pending` is either a **oneshot** (single-result ops: ENCODE/FORGET — resolved by the sole EOS frame) or a **stream sink** (multi-result: RECALL/QUERY — frames pushed until EOS).
- The reader loop: read frame → look up `stream_id`:
  - known + single-result → resolve the oneshot, remove the entry.
  - known + multi-result → push to the stream sink; if EOS, close + remove.
  - `ERROR` frame (0x00FF) with EOS → resolve the entry as a typed error (§7), remove.
  - unknown/retired `stream_id` → **drop** (a late frame after cancel) — never crash.
- Cross-stream interleave is handled for free: each frame routes by its id; a slow RECALL on stream 3 doesn't block an ENCODE on stream 5.

### 6.4 Cancellation

- Dropping a response handle (Rust: drop the future; Python/TS: cancel the awaitable) triggers `CANCEL_STREAM` (0x0011) for that `stream_id`; the registry marks it cancelled and discards subsequent frames until `CANCEL_STREAM_ACK` (0x0091, EOS) frees the id.
- Best-effort: committed work isn't rolled back (matches the protocol).

### 6.5 Connection state machine (reconnect)

```
Disconnected ──connect──▶ Connecting ──tcp ok──▶ Handshaking
   ▲                                                  │ HELLO/WELCOME/AUTH/AUTH_OK
   │                                                  ▼
Backoff ◀──error/timeout──── Ready ◀──auth ok──── (admit requests)
   │                           │
   └──── reconnect ◀───────────┘  on I/O error: fail all in-flight with a
                                  Retryable(ConnectionLost), then backoff+reconnect
```

- **Typed-state handshake.** The connection is only `Ready` after AUTH_OK; the type system (Rust) / internal state guard (Py/TS) prevents sending a verb before the handshake completes — a request submitted during `Handshaking` queues until `Ready` or fails on timeout.
- On disconnect, all in-flight entries resolve to `ConnectionLost` (retryable); the retry layer (§8) decides whether to replay.

---

## 7. L4 — Request queue, pipelining, backpressure

- **Outbound queue** (bounded mpsc): callers enqueue `(frame, reply-handle)`. Bounded depth = the SDK's pipelining window. When full, `submit()` **applies backpressure to the caller** (await a slot) rather than buffering unboundedly — mirroring the protocol's "stall, don't drop."
- **Pipelining**: multiple requests ride the wire without waiting for prior responses — each gets its own `stream_id`, the writer coalesces them (§4.2), responses demux back (§6.3). Throughput scales with the in-flight window, not round-trip latency.
- **Read-side draining**: the reader drains the socket into per-stream sinks promptly; a slow consumer on one stream eventually head-of-line-blocks the connection at TCP (the protocol has no per-stream credit in v1), so per-stream sinks are themselves bounded and a stalled consumer surfaces as backpressure on *that* stream's `next()`.
- **In-flight cap** aligns with the server's per-connection budget (default 1024); the SDK won't exceed it.

---

## 8. L5/L6 — Commands, client, reliability

### 8.1 Command layer (verbs)

- One typed request struct + builder per verb; one typed response. `encode()`, `recall()`, `forget()` for v1; entity/statement/relation/query later.
- **Builder pattern** for ergonomic optional fields (RECALL has ~10): `client.recall("cue").top_k(5).include_graph().await`.
- **RECALL returns a stream**, not a Vec — an async iterator over `MemoryResult` terminated by EOS, so large result sets don't buffer. A `.collect()` convenience exists for the common small case.
- Each command knows its request opcode, response opcode, and whether it's single- or multi-result — so L3 sets up the right `pending` kind.

### 8.2 Idempotency

- Mutating verbs carry a `request_id` (UUIDv7) the SDK mints. On a transparent retry after `ConnectionLost`, the **same** `request_id` is replayed so the server dedups (24h TTL) — at-least-once on the wire becomes effectively-once. Same id + different params is a server `Conflict` (a client bug the SDK avoids by freezing the id with the request).

### 8.3 Retry policy

- Retry is driven by the **error category** (§6 below), never by string matching. `Unavailable`/`ResourceExhausted`(RateLimited) → retry with exp backoff + jitter, honoring a server-supplied `retry_after_ms` when present. `ConnectionLost` → reconnect + replay idempotent ops. `Validation`/`NotFound`/`Conflict`/`Authorization` → never retry (propagate). Bounded attempts.

### 8.4 Connection pool

- For concurrency beyond one connection's comfortable in-flight window, a **pool** of connections with health checks and round-robin/least-in-flight dispatch. Each pooled connection is a full L3 actor. Pool handles connect storms (jittered), eviction of dead connections, and a min/max size.

### 8.5 Observability

- Hook points (not a hard dep): a span per request (opcode, stream_id, latency), counters (requests, retries, reconnects, in-flight gauge), and a tracing trait the host app can implement. Rust: `tracing`; Python: stdlib `logging` + optional OTel; TS: a pluggable logger.

---

## 9. Error model (the taxonomy)

The wire carries a `u16` `ErrorCode` in an ERROR frame `{code, category, message, details?, retry_after_ms?}`. The SDK maps it through three levels:

```
wire ErrorCode (u16)  ──▶  ErrorCategory (9)  ──▶  typed SDK error  ──▶  retry verdict
0x0040 InvalidArgument     Validation              InvalidArgument{field}   never
0x0050 MemoryNotFound      NotFound                NotFound                 never
0x0060 IdempotencyConflict Conflict                Conflict                 never
0x0073 RateLimited         ResourceExhausted       RateLimited{retry_after} backoff
0x0090 ShardUnavailable    Unavailable             Unavailable              backoff
0x000A MalformedPayload    Protocol                Protocol (bug)           never (fix client)
 …
```

- **Nine categories** (stable, the retry axis): `Protocol(0) Authentication(1) Authorization(2) Validation(3) NotFound(4) Conflict(5) ResourceExhausted(6) Internal(7) Unavailable(8)`.
- **Code ranges** mirror the namespace: `0x000x` framing/protocol, `0x002x` handshake, `0x003x` authz, `0x004x` validation, `0x005x` not-found, `0x006x` conflict, `0x007x` resource-exhausted, `0x008x` internal, `0x009x` unavailable, `0x01xx` typed-graph.
- **Each language exposes a typed error** (Rust `enum BrainError`, Python exception hierarchy, TS discriminated union) carrying the code, category, message, and structured `details` (e.g. the offending field). The category drives retry; the code gives precise programmatic handling; the message is human-facing only.
- **Decode failures** (a frame the SDK can't parse) are a distinct local error class — they mean SDK/server drift, surfaced loudly, never swallowed.

---

## 10. Design patterns (summary)

| Pattern | Where | Why |
|---|---|---|
| **Actor / single-owner socket** | L3 connection (reader+writer tasks, channel inbox) | structural "one writer" — no shared-mut socket; matches server discipline |
| **Future/oneshot correlation** | L3 in-flight registry (stream_id → oneshot/sink) | demux concurrent responses on one connection |
| **Typed-state** | handshake (Connecting→Handshaking→Ready) | can't send a verb before AUTH_OK |
| **Builder** | L5 request construction | ergonomic optional-heavy requests (RECALL) |
| **Command** | L5 verbs carry (req-opcode, resp-opcode, arity) | uniform dispatch into L3 |
| **Async stream / iterator** | RECALL/QUERY responses | stream large result sets, EOS-terminated, no buffering |
| **Object pool** | L1 buffers | kill per-request allocation |
| **Strategy** | retry policy keyed on error category | pluggable backoff, no string matching |
| **Adapter** | per-language CBOR + async runtime | one architecture, three runtimes |

---

## 11. Per-language realization

| Concern | Rust | Python | TypeScript |
|---|---|---|---|
| Async runtime | tokio | sync-first (`BrainClient`), `asyncio` later | native promises |
| Connection actor | tokio task + `mpsc` + `oneshot` | thread + `queue.Queue` (sync) / task (async) | async loop + `Map<id, resolver>` |
| Read buffer | `bytes::BytesMut` | `bytearray` + `memoryview` | growable `Uint8Array` + cursor |
| Stream type | `impl Stream<Item=Result<MemoryResult>>` | generator / async-generator | `AsyncIterable` |
| Error surface | `enum BrainError` + `thiserror` | exception hierarchy | discriminated union |
| Vector trailer | `&[f32]` view (zero-copy) | `memoryview`→`array('f')` | `Float32Array` over the buffer |

Rust is built first and most complete; it's the reference the other two are checked against — together with the shared conformance corpus, which guarantees all three put identical bytes on the wire.

---

## 12. What this buys

- **Throughput**: pipelining + write coalescing + buffer pooling turn a per-request-round-trip client into one bounded by the in-flight window and the socket, not by syscalls or allocation.
- **Correctness**: the corpus + CRC + typed errors mean wire drift and corruption surface immediately, never as silent wrong data.
- **Resilience**: the connection state machine + idempotent replay + category-driven retry make transient failures invisible to the caller without at-most-once surprises.
- **Maintainability**: one layered design in three languages; the protocol mechanics (L0–L3) are corpus-validated and identical in shape.

Build order follows [`PLAN.md`](PLAN.md): L1+L2 against the corpus first (Phase 1), then L3 handshake/connection (Phases 2–3), then L4–L6 (Phases 4–5).
