# @brain-db/sdk

The TypeScript client for the [Brain](https://github.com/arc-labs-ai/brain-db) memory database.

Brain stores what your application learns and hands it back when something is relevant. This package is how a TypeScript program talks to it: write memories, recall them by meaning, and read and shape the typed graph Brain builds out of them.

```bash
npm install @brain-db/sdk
```

**ESM only.** `package.json` sets `"type": "module"`, and its `exports` map declares an `import` condition and no `require` one for both `.` and `./http` — so `require()` of either entry fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Use `import`, or `await import()` from CommonJS. `engines` asks for Node >= 18.

## Quickstart

```typescript
import { BrainClient, EncodeBuilder, RecallBuilder, ForgetBuilder } from "@brain-db/sdk";

// Auth is mandatory — there is no anonymous mode.
const client = await BrainClient.connect("127.0.0.1", 9090, {
  auth: { kind: "token", token: new TextEncoder().encode("brain_...") },
});

const stored = await client.encode(new EncodeBuilder("the user prefers dark mode").build());

const answer = await client.recall(new RecallBuilder("ui preferences").maxResults(5).build());
for (const memory of answer.memories) {
  console.log(memory.text);
}

await client.forget(new ForgetBuilder(stored.memoryId).build());
await client.close();
```

`answer.answerKind` is `Single`, `Many` or `None`. **`None` is an explicit "nothing I hold answers this"** — not an error, and not a nearest match returned out of politeness.

## What you can do

Every verb that streams has a `*Frames()` sibling handing back raw frames instead of the drained projection.

| | Verbs |
|---|---|
| **Memories** | `encode` · `recall` · `forget` · `link` / `unlink` · `encodeVectorDirect` |
| **Ask** | `plan` · `reason` · `queryExplain` / `queryTrace` |
| **Entities** | `createEntity` · `getEntity` · `resolveEntity` · `listEntities` · `updateEntity` · `renameEntity` · `mergeEntities` / `unmergeEntity` · `tombstoneEntity` |
| **Statements** | `createStatement` · `getStatement` · `listStatements` · `statementHistory` · `supersedeStatement` · `retractStatement` · `tombstoneStatement` |
| **Relations** | `createRelation` · `getRelation` · `listRelationsFrom` / `listRelationsTo` · `traverseRelations` · `supersedeRelation` · `tombstoneRelation` |
| **Schema** | `uploadSchema` · `getSchema` · `listSchemas` · `validateSchema` · `replaceSchema` · `dropSchema` · `materializeProcedural` |
| **Transactions** | `txnBegin` · `txnCommit` · `txnAbort` |
| **Change feed** | `subscribe` → an async-iterable `Subscription` · `cancelStream` |
| **Inspect** | `memoryList` · `memoryInspect` · `graphFetch` · `capabilities` · `extractorList` · `ping` |
| **Spaces & sessions** | `createSpace` / `listSpaces` / `deleteSpace` · `createSession` / `listSessions` / `deleteSession` |

## Concurrency

One connection, many requests. `MuxConnection` owns the socket and runs a single `data` pump that demultiplexes responses by `streamId`, so **every verb is concurrency-safe** and requests run in flight at once over one shared connection.

`Pool` opens a fixed set of connections and hands them out round-robin; `Pool.getHealthy()` replaces a member whose socket has died before handing it out, and concurrent callers landing on the same dead slot share one reconnect. A verb call on an already-dropped connection is not transparently retried — open a fresh one.

`withRetry` + `RetryPolicy` give exponential backoff with full jitter, honoring a server-sent `retryAfterMs` as the floor.

## Two transports

The client above speaks Brain's **BRN0 wire protocol** straight to a socket, with no dependency on Brain's internal code. That is the one to use when you can open a TCP connection, and the only one with streaming, transactions and typed-graph management.

When Brain sits behind an HTTP edge — the Arc cloud gateway, or a self-hosted `brain-edge` — use `BrainHttpClient`. Same verb names, field names and error shape as the Rust and Python SDKs; the canonical contract is [`contract/http-routes.json`](https://github.com/arc-labs-ai/brain-sdk/blob/main/contract/http-routes.json). No third-party dependency — native `fetch`.

```typescript
import { BrainHttpClient } from "@brain-db/sdk/http";

// baseUrl is your edge; http://127.0.0.1:8080 for a local brain-edge.
const brain = new BrainHttpClient({ apiKey, baseUrl });
const stored = await brain.encode({ text: "the kettle whistled" });
const answer = await brain.recall({ query: "what whistled?", maxResults: 3 });
const who = await brain.whoami(); // namespace + spaceId + permissions
```

Field names are **camelCase in and out** — `maxResults`, not `max_results`. The client snake_cases bodies and query strings at the seam, because that is what the edge deserializes. A snake_case key passed in is an excess property that never reaches the wire, so the server silently applies its default instead.

### Import from `@brain-db/sdk/http` on a runtime without `node:`

The package root re-exports both tiers, and the wire tier imports `node:net` and `node:crypto`. That is fine in Node and fatal anywhere else: a Workers, Deno, Bun or Next.js Edge build that imports `BrainHttpClient` **from the root** fails on a module its own code never mentions —

```text
Failed to load external module node:crypto:
TypeError: Native module not found: node:crypto
```

The `./http` subpath is the whole HTTP tier and nothing else. Its import closure touches no Node builtin, at runtime or in a type position, so it loads wherever `fetch` does. `test/http-standalone` asserts that and fails the build if an import ever puts it back.

Both entries export the same `BrainHttpClient`, so on Node the choice is only about how much you pull in. In a mixed codebase, import the wire client from the root and the HTTP client from `./http`.

## Layout

```
src/
  wire/         frame + CBOR codec, opcodes, typed payloads (corpus-verified)
  errors.ts     client error taxonomy (BrainError + subclasses)
  describe.ts   rendering a thrown value; shared by both tiers, so node-free
  transport.ts  FrameChannel: whole-frame reads + write over a socket
  connection.ts the HandshakeOutcome shape, named by both mux and client
  mux.ts        MuxConnection: socket + data pump, handshake, per-streamId routing
  client.ts     high-level BrainClient: connect, handshake, connection grant, verbs
  verbs.ts      Encode/Recall/Forget request builders
  retry.ts      RetryPolicy + withRetry (exponential backoff, full jitter)
  pool.ts       fixed-size round-robin Pool, plus reconnecting getHealthy()
  http/         the HTTP tier: BrainHttpClient, contract types, SSE
```

`MuxConnection` owns its socket and frames the byte stream itself; the standalone `FrameChannel` in `transport.ts` is the same job factored out for the test harnesses, and is not on the client's path.

## Tests

```bash
npm install
npm test          # vitest: corpus byte-exactness, handshake, verbs, mux, pool,
                  #   retry, entry surface, HTTP tier
npm run typecheck # tsc --noEmit (src + tests)
npm run lint      # biome check .
npm run build     # tsc -> dist/
```

The wire codec is checked byte-for-byte against the shared conformance corpus: all 158 `.bin`/`.json` cases decode and re-encode to identical bytes, so this SDK and Brain cannot drift on the wire. CRC32C is implemented in software; the one runtime dependency is `cborg`.

Integration suites run against a real server when `BRAIN_SDK_IT_DATA` is set and skip otherwise. Set `BRAIN_SDK_IT_REQUIRED=1` wherever a server is meant to be reachable, so a misconfigured one fails instead of reading as green.

Live HTTP edge smoke tests cover identity, capabilities, and an encode/recall/list/forget lifecycle across all three SDKs. From the repo root:

```bash
BRAIN_SDK_IT_HTTP=https://edge.example BRAIN_SDK_IT_HTTP_KEY=brain_… scripts/edge-it.sh
```

The package exports its own release version as `SDK_VERSION`; `test/version` holds it in lockstep with `package.json`. The wire protocol is specified in [`brain-db`'s `spec/04_wire_protocol/`](https://github.com/arc-labs-ai/brain-db/tree/main/spec/04_wire_protocol).

License: Apache-2.0.
