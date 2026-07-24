# @brain-db/sdk

The TypeScript client for the Brain memory database. Speaks Brain's BRN0 wire
protocol directly; no dependency on Brain's internal code. Async by design.

**Status: typed-graph verbs (Phase 6).** The wire codec (Phase 1) is **verified
byte-for-byte against the shared conformance corpus** (all 86 `.bin`/`.json`
cases re-encode to identical bytes). On top of it, an async connection layer (a
`FrameChannel` transport turning a socket's byte stream into whole frames, a
`Connection` running the handshake HELLO → WELCOME → AUTH → AUTH_OK and
request/response, a `BrainClient` holding the negotiated connection grant), the
three v1 verbs with ergonomic builders (`encode()`, `recall()` streaming to EOS /
`recallFrames()`, `forget()`), a `withRetry` helper + `RetryPolicy` (exponential
backoff, server `retryAfterMs`), the space + session registry verbs
(`spaceCreate()`, `spaceList()`, `spaceDelete()`, `sessionCreate()`,
`sessionList()`, `sessionDelete()`), and the typed-graph verbs: `createEntity()`,
`createStatement()`, `createRelation()`, `uploadSchema()`, and
`materializeProcedural()`. `BrainClient` is built on a `MuxConnection`: a single
`data` pump demultiplexes responses by `streamId`, so **every verb is
concurrency-safe** and many requests run in flight at once over one shared
connection. A `Pool` opens a fixed set of such connections and hands them out
round-robin for socket-level parallelism. Transparent reconnect is later work.

The full build plan is in the repo-root [`PLAN.md`](../PLAN.md); the layered
architecture is in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

```typescript
import { BrainClient, newId } from "@brain-db/sdk";

const client = await BrainClient.connect("127.0.0.1", 7878);
console.log(client.connection.serverId, client.connection.chosenVersion);

// Group memories into a session within the connection's space, then list them.
await client.sessionCreate({ sessionId: 7n, title: "project alpha", requestId: newId(), actAs: null });
const { sessions } = await client.sessionList({ limit: 50, actAs: null });

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
  client.ts     high-level BrainClient: connect, handshake, connection grant, verbs
```

## HTTP tier

For hosted Brain (the Arc cloud gateway) or a self-hosted `brain-edge` edge, the
package also ships `BrainHttpClient` — a JSON-over-HTTP client with the same verb
surface, field names, and error shape as the Rust and Python SDKs (the canonical
contract is [`../HTTP_CONTRACT.md`](../HTTP_CONTRACT.md)). Use it when you talk to
Brain through an HTTP edge and authenticate with an API key; use the wire
`BrainClient` above for a direct socket, streaming, transactions, and typed-graph
management. It has no third-party dependency — native `fetch`.

```typescript
import { BrainHttpClient } from "@brain-db/sdk";

const brain = new BrainHttpClient({ apiKey, baseUrl: "https://api.arc-labs.ai" });
const stored = await brain.encode({ text: "the kettle whistled" });
const answer = await brain.recall({ query: "what whistled?", max_results: 3 });
const who = await brain.whoami(); // namespace + agent_id + permissions
```

Dependencies: `cborg` (runtime). CRC32C is implemented in software.
License: Apache-2.0.
