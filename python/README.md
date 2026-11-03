# brain-db-sdk (Python)

The Python client for the [Brain](https://github.com/arc-labs-ai/brain-db) memory database.

Brain stores what your application learns and hands it back when something is relevant. This package is how a Python program talks to it: write memories, recall them by meaning, and read and shape the typed graph Brain builds out of them.

```bash
pip install brain-db-sdk
```

Python 3.10+. One runtime dependency, `cbor2>=5.9` (a security floor, not a feature one). Ships `py.typed`, so annotations reach downstream type checkers.

## Quickstart

```python
from brain_db_sdk import (
    Auth, BrainClient, EncodeBuilder, RecallBuilder, ForgetBuilder, RetryPolicy, with_retry,
)

# Auth is mandatory — there is no anonymous mode.
with BrainClient.connect("127.0.0.1", 9090, Auth.token(b"brain_...")) as client:
    stored = client.encode(EncodeBuilder("the user prefers dark mode").build())

    answer = client.recall(RecallBuilder("ui preferences").limit(5).build())
    for memory in answer.memories:
        print(memory.text)

    # The stable request_id makes a resend idempotent, so retrying is safe.
    req = ForgetBuilder(stored.memory_id).build()
    with_retry(lambda: client.forget(req), RetryPolicy())
```

`answer.answer_kind` is `"Single"`, `"Many"` or `"None"`. **`"None"` is an explicit "nothing I hold answers this"** — not an error, and not a nearest match returned out of politeness.

## What you can do

75 verbs, each with a `_frames()` variant where the response streams.

| | Verbs |
|---|---|
| **Memories** | `encode` · `recall` · `forget` · `link` / `unlink` · `encode_vector_direct` |
| **Ask** | `plan` · `reason` · `query_explain` / `query_trace` |
| **Typed graph** | `create_entity` · `create_statement` · `create_relation` · plus the read, supersede, retract and tombstone verbs for each |
| **Schema** | `upload_schema` · `validate_schema` · `replace_schema` · `drop_schema` · `materialize_procedural` |
| **Transactions** | `txn_begin` · `txn_commit` · `txn_abort` |
| **Change feed** | `subscribe` → `Subscription` |
| **Inspect** | `memory_list` · `memory_inspect` · `graph_fetch` · `capabilities` · `extractor_list` · `ping` |
| **Spaces & sessions** | `create_space` / `list_spaces` / `delete_space` · `create_session` / `list_sessions` / `delete_session` |

A **space** is the per-request isolation unit and a **session** groups a conversation; a trusted principal targets either with `act_as`.

## Which tier to use

Three clients ship here. Pick one per program, not per call.

| Tier | Use it when |
|---|---|
| `BrainClient` | ordinary synchronous code, a direct socket to Brain |
| `aio.AsyncBrainClient` | you already run an event loop — FastAPI, asyncio workers |
| `BrainHttpClient` | Brain is behind an HTTP edge (Arc cloud gateway, or self-hosted `brain-edge`) |

The first two speak Brain's **BRN0 wire protocol** straight to a socket, with no dependency on Brain's internal code, and are the only ones with transactions, frame-level stream control and mTLS.

### asyncio

`AsyncBrainClient` is the asyncio twin of `BrainClient`: the same verbs with the same signatures, every one a coroutine, over the same multiplexed connection. A request in flight suspends its task instead of blocking a thread, so one connection carries thousands of concurrent requests on a single OS thread. No new dependency — just the standard library.

```python
import asyncio
from brain_db_sdk import Auth, EncodeBuilder, RecallBuilder
from brain_db_sdk.aio import AsyncBrainClient

async def main() -> None:
    async with await AsyncBrainClient.connect(
        "127.0.0.1", 9090, Auth.token(b"brain_...")
    ) as client:
        # Independent writes cost one round trip, not three.
        await asyncio.gather(
            client.encode(EncodeBuilder("Ada works at Arc Labs").build()),
            client.encode(EncodeBuilder("Arc Labs builds Brain").build()),
            client.encode(EncodeBuilder("Brain is a memory database").build()),
        )
        answer = await client.recall(RecallBuilder("where does Ada work?").build())
        for memory in answer.memories:
            print(memory.text)

asyncio.run(main())
```

`AsyncPool`, `AsyncSubscription` (drained with `async for`) and an awaiting `with_retry` come with it. Everything below the transport is shared rather than duplicated — the frame codec, payload types, builders, error taxonomy, retry curve and the `Auth` / `ClientConfig` / `ConnectionInfo` types are the same objects both tiers use. `tests/aio_parity` compares the two surfaces by reflection and fails the build if a verb, a signature or a default ever drifts.

Two things that will bite otherwise:

- **Don't mix tiers.** The sync client blocks the event loop from inside a coroutine; wrapping the async one in `asyncio.run` from sync code opens and tears down a loop per call, and raises outright if a loop is already running (FastAPI, Jupyter).
- **A connection belongs to the loop it was opened on.** That binding is checked on every call rather than left to chance, because a connection driven from a second loop does not raise — it waits forever on a future nothing will complete.

### HTTP

Same verb names, field names and error shape as the Rust and TypeScript SDKs; the canonical contract is [`contract/http-routes.json`](https://github.com/arc-labs-ai/brain-sdk/blob/main/contract/http-routes.json). Pure `urllib`, no third-party dependency.

```python
from brain_db_sdk import BrainHttpClient

# base_url defaults to http://127.0.0.1:8080 — point it at your edge.
brain = BrainHttpClient(api_key, base_url=base_url)
stored = brain.encode(text="the kettle whistled")
answer = brain.recall(query="what whistled?", max_results=3)
who = brain.whoami()  # namespace + space_id + permissions
```

It covers the typed-graph verbs and an SSE `subscribe()` feed, plus the hosted-only BYOK LLM credential surface (`put_llm_credential()` / `get_llm_credential()` / `verify_llm_credential()`) and its own `HttpRetryPolicy`.

## Concurrency

`BrainClient` is built on a `MuxConnection`: a background reader thread demultiplexes responses by `stream_id`, so **every verb is concurrency-safe** and many requests run in flight at once over one connection from multiple threads.

`Pool` opens a fixed set of connections and hands them out round-robin; `Pool.get_healthy()` checks the member it is about to hand out and dials a replacement in place if its socket has died.

## Layout

```
src/brain_db_sdk/
  wire/        frame + CBOR codec, opcodes, typed payloads (corpus-verified)
  errors.py    client error taxonomy (BrainError + subclasses)
  transport.py sync read/write of whole frames over a socket
  mux.py       handshake + MuxConnection (reader thread, demux by stream_id)
               + Subscription
  client.py    high-level BrainClient: connect, handshake, the whole verb surface
  verbs.py     ergonomic EncodeBuilder / RecallBuilder / ForgetBuilder
  retry.py     RetryPolicy + with_retry (exponential backoff, server retry_after)
  pool.py      Pool: fixed-size round-robin connections, get_healthy()
  aio/         the asyncio tier: AsyncBrainClient, AsyncPool, async transport+mux
  http/        the hosted-edge tier: BrainHttpClient, contract types, SSE feed
```

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
PYTHONPATH=src .venv/bin/python -m pytest tests/ -q
```

Install the `dev` extra, not individual packages: `pyproject.toml` sets `asyncio_mode = "auto"`, so without `pytest-asyncio` the ~240 `tests/aio_*` tests **fail** rather than skip. The extra also brings `ruff` and `pyright`.

The wire codec is checked byte-for-byte against the shared conformance corpus: all 158 `.bin`/`.json` cases decode and re-encode to identical bytes, so this SDK and Brain cannot drift on the wire. CRC32C is pure Python.

Integration suites run against a real server when `BRAIN_SDK_IT_DATA` is set and skip otherwise. Set `BRAIN_SDK_IT_REQUIRED=1` wherever a server is meant to be reachable, so a misconfigured one fails instead of reading as green.

Live HTTP edge smoke tests cover identity, capabilities, and an encode/recall/list/forget lifecycle across all three SDKs. From the repo root:

```bash
BRAIN_SDK_IT_HTTP=https://edge.example BRAIN_SDK_IT_HTTP_KEY=brain_… scripts/edge-it.sh
```

The package exports its own release version as `brain_db_sdk.__version__`, read from the installed distribution metadata so it cannot disagree with `pyproject.toml`.

The wire protocol is specified in [`brain-db`'s `spec/04_wire_protocol/`](https://github.com/arc-labs-ai/brain-db/tree/main/spec/04_wire_protocol).

License: Apache-2.0.
