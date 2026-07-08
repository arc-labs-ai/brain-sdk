# @brain-db/sdk

The TypeScript client for the Brain memory database. Speaks Brain's BRN0 wire
protocol directly; no dependency on Brain's internal code. Async by design.

**Status: typed-graph verbs (Phase 6).** The wire codec (Phase 1) is **verified
byte-for-byte against the shared conformance corpus** (all 38 `.bin`/`.json`
cases re-encode to identical bytes). On top of it, an async connection layer (a
`FrameChannel` transport turning a socket's byte stream into whole frames, a
`Connection` running the handshake HELLO → WELCOME → AUTH → AUTH_OK and
request/response, a `BrainClient` holding the negotiated session), the three v1
verbs with ergonomic builders (`encode()`, `recall()` streaming to EOS /
`recallFrames()`, `forget()`), a `withRetry` helper + `RetryPolicy` (exponential
backoff, server `retryAfterMs`), and the typed-graph verbs: `createEntity()`,
`createStatement()`, `createRelation()`, `uploadSchema()`, and
`materializeProcedural()`. `BrainClient` is built on a `MuxConnection`: a single
`data` pump demultiplexes responses by `streamId`, so **every verb is
concurrency-safe** and many requests run in flight at once over one shared
connection. A `Pool` opens a fixed set of such connections and hands them out
round-robin for socket-level parallelism. Transparent reconnect is later work.

The full build plan is in the repo-root [`PLAN.md`](../PLAN.md); the layered
architecture is in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

```typescript
import { BrainClient } from "@brain-db/sdk";

const client = await BrainClient.connect("127.0.0.1", 7878);
console.log(client.session.serverId, client.session.chosenVersion);
await client.close();
```

Develop + verify:

```bash
npm install
npm test          # vitest: corpus byte-exactness + handshake round-trip
npm run typecheck # tsc --noEmit (src + tests)
npm run build     # tsc -> dist/
```

The `live server handshake` test runs against a real server when
`BRAIN_TEST_ADDR=host:port` is set, and is skipped otherwise.

Layout (folder-per-concern, mirroring the reference Rust SDK):

```
src/
  wire/         frame + CBOR codec, opcodes, typed payloads (corpus-verified)
  errors.ts     client error taxonomy (BrainError + subclasses)
  transport.ts  async FrameChannel: whole-frame reads + write over a socket
  connection.ts handshake + one-at-a-time request/response
  client.ts     high-level BrainClient: connect, handshake, session, encode
```

Dependencies: `cborg` (runtime). CRC32C is implemented in software.
License: Apache-2.0.
