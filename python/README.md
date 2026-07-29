# brain-db-sdk (Python)

The Python client for the Brain memory database. Speaks Brain's BRN0 wire
protocol directly; no dependency on Brain's internal code.

**Status: typed-graph verbs (Phase 6).** The wire codec (Phase 1) is **verified
byte-for-byte against the shared conformance corpus** (all 86 `.bin`/`.json`
cases re-encode to identical bytes). On top of it, a synchronous connection
layer (a `transport` over a socket, a `Connection` running the handshake HELLO →
WELCOME → AUTH → AUTH_OK and request/response, a `BrainClient` holding the
negotiated session), the three v1 verbs with ergonomic builders (`encode()`,
`recall()` streaming to EOS / `recall_frames()`, `forget()`), a `with_retry`
helper + `RetryPolicy` (exponential backoff, server `retry_after_ms`), and the
typed-graph verbs: `create_entity()`, `create_statement()`, `create_relation()`,
`upload_schema()`, and `materialize_procedural()`; and the space/session registry
verbs: `create_space()` / `list_spaces()` / `delete_space()` and
`create_session()` / `list_sessions()` / `delete_session()` for managing the
per-request isolation unit (space) and conversation groupings (session) that a
trusted principal targets via `act_as`. `BrainClient` is built on a
`MuxConnection`: a background reader thread demultiplexes responses by
`stream_id`, so **every verb is concurrency-safe** and many requests run in
flight at once over one connection from multiple threads. A `Pool` opens a fixed
set of such connections and hands them out round-robin for socket-level
parallelism. Transparent reconnect and an `asyncio` client are later phases.

The full build plan is in the repo-root [`../PLAN.md`](../PLAN.md); the
layered architecture is in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

```python
from brain_db_sdk import (
    BrainClient, EncodeBuilder, RecallBuilder, ForgetBuilder, RetryPolicy, with_retry,
)

with BrainClient.connect("127.0.0.1", 7878) as client:
    stored = client.encode(EncodeBuilder("the user prefers dark mode").build())
    answer = client.recall(RecallBuilder("ui preferences").limit(5).build())
    # answer.answer_kind is Single/Set (fact answer.values) or Episodic
    # (memory answer.results); NoSubject/NoMemory means "don't know".
    # Ride out transient ResourceExhausted/Unavailable; the stable request_id
    # makes the resend idempotent.
    req = ForgetBuilder(stored.memory_id).build()
    with_retry(lambda: client.forget(req), RetryPolicy())
```

Develop + verify against the corpus:

```bash
python3 -m venv .venv && .venv/bin/pip install cbor2 pytest
PYTHONPATH=src .venv/bin/python -m pytest tests/ -q
```

The integration suites run against a real server when `BRAIN_SDK_IT_DATA` is
set, and skip otherwise; `scripts/it-server.sh up` boots one and prints the
vars. Set `BRAIN_SDK_IT_REQUIRED=1` wherever a server is meant to be reachable
so a misconfigured one fails instead of reading as green.

Layout (folder-per-concern, mirroring the reference Rust SDK):

```
src/brain_db_sdk/
  wire/        frame + CBOR codec, opcodes, typed payloads (corpus-verified)
  errors.py    client error taxonomy (BrainError + subclasses)
  transport.py sync read/write of whole frames over a socket
  connection.py handshake + one-at-a-time request/response
  client.py    high-level BrainClient: connect, handshake, encode/recall/forget
  verbs.py     ergonomic EncodeBuilder / RecallBuilder / ForgetBuilder
  retry.py     RetryPolicy + with_retry (exponential backoff, server retry_after)
```

## HTTP tier

For hosted Brain (the Arc cloud gateway) or a self-hosted `brain-edge` edge, the
package also ships `BrainHttpClient` — a JSON-over-HTTP client with the same verb
surface, field names, and error shape as the Rust and TypeScript SDKs (the
canonical contract is [`../HTTP_CONTRACT.md`](../HTTP_CONTRACT.md)). Use it when
you talk to Brain through an HTTP edge and authenticate with an API key; use the
wire `BrainClient` above for a direct socket, streaming, transactions, and
typed-graph management. It has no third-party dependency — pure `urllib`.

```python
from brain_db_sdk import BrainHttpClient

brain = BrainHttpClient(api_key, base_url="https://api.arc-labs.ai")
stored = brain.encode(text="the kettle whistled")
answer = brain.recall(query="what whistled?", max_results=3)
who = brain.whoami()  # namespace + space_id + permissions
```

Dependencies: `cbor2` (runtime), `pytest` (dev). CRC32C is pure Python.
License: Apache-2.0.
