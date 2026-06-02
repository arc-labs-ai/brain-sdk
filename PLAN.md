# brain-sdk — build plan

Production-grade, hand-written client SDKs for the Brain memory database in **Rust, Python, and TypeScript**. Published as `brain-db-sdk` (crates.io, PyPI) and `@brain-db/sdk` (npm).

> The **internal architecture** — layer stack, connection actor, stream multiplexer, request queue, buffer/packet management, error taxonomy, design patterns — is in [`ARCHITECTURE.md`](ARCHITECTURE.md). This file is the *what/when* (phases); that file is the *how*. Status: **scaffold** — compiling skeletons + this plan. Build only after user review (plan-first).

## Architecture

Three independent, hand-written clients, one shared **conformance corpus** (vendored from Brain) as the cross-language byte-level drift guard. Each SDK re-implements Brain's §04 wire protocol from the spec — no path-dependency on Brain's internal crates, no cross-repo CI into the Brain repo. **Rust is the reference implementation** (built first, most complete); Python and TypeScript mirror its shape.

## Key decisions (confirm before the build phase)

1. **Independent codec, not a shared library.** Each SDK writes its own frame+CBOR codec from §04. This is the whole premise (Brain ships no SDK; the protocol is the contract) and avoids coupling. Drift is caught by the vendored corpus. — *recommended, applied in the scaffold.*
2. **Monorepo (this repo), not 3 separate repos.** One repo with `rust/` `python/` `typescript/` keeps the shared corpus + cross-language parity tests in one place; can split later if publishing cadences diverge. — *recommended.*
3. **Conformance corpus = copy-with-version-pin.** Copy Brain's `crates/brain-protocol/tests/conformance/corpus/` into `conformance/corpus/` here with a `SOURCE.txt` naming the upstream commit. Not a git submodule, not a CI fetch (cross-repo coupling is disallowed). Refresh is a deliberate reviewed step. — *recommended.*
4. **Async posture per language:** Rust async (tokio); Python sync-first (a `BrainClient`), async (`asyncio`) as a later phase; TypeScript async (native). — *confirm.*
5. **CBOR library per language:** Rust `ciborium`; Python `cbor2`; TypeScript `cbor-x` or `cborg` — must distinguish CBOR **byte strings** from arrays (ids are byte strings) and emit deterministic/fixed-field-order maps. — *confirm the TS lib in Phase 1.*

## Wire contract (already researched — see `brain-shell/PLAN.md` for full file:line cites)

- 32-byte `BRN0` header, all multi-byte fields **big-endian**: magic, version(1), opcode(u16 BE; hi byte = namespace 0x00 substrate / 0x01 typed-graph), flags(EOS=0x80/MPL=0x40/CMP=0x20), header_crc32c (CRC32C over bytes 0..8 ++ 12..32), stream_id(u32), payload_len(u24), payload_crc32c. Header consts encoded in all three scaffolds.
- Payload = CBOR map + optional trailing raw little-endian f32 vector section.
- **Cross-language gotchas:** ids/`[u8;N]`/UUIDs are CBOR **byte strings** (not int-arrays/strings); enums are **integer discriminants**; f32 are 32-bit on the wire.
- Handshake: HELLO→WELCOME→AUTH(`AuthMethod::None` for dev)→AUTH_OK.
- v1 verbs: ENCODE(0x0020/resp 0x00A0), RECALL(0x0021/resp 0x00A1, EOS-terminated stream), FORGET(0x0024/resp 0x00A4), plus BYE(0x001F).

## Phases (each with "done when")

**Phase 0 — scaffold** ✅: 3 compiling skeletons (header consts + stubbed codec), shared `conformance/` README, this plan. *Done when: `cargo build` / `py_compile` / files-present all green.* ← we are here.

**Phase 1 — wire codec + conformance oracle (Rust first, then Py, then TS).** Implement `encode_frame`/`decode_frame` (CRC32C both fields; enforce `MAX_PAYLOAD_BYTES` before alloc; clamp any wire-driven `with_capacity`) + the CBOR payload codec for the handshake + 3 verbs. Vendor the corpus (decision 3). *Done when: each language decodes every corpus `.bin` to match its `.json` AND re-encodes to the exact bytes.*

**Phase 2 — handshake.** HELLO→WELCOME→AUTH→AUTH_OK over a TCP socket; negotiate version, carry `agent_id`. *Done when: each SDK completes a handshake against a real `brain-server` (docker).*

**Phase 3 — connection / transport.** Frame read/write loop, stream-id demux, EOS handling, timeouts; Rust adds a connection pool + reconnect. *Done when: a connection survives encode→recall→forget→bye without leaks.*

**Phase 4 — core verbs.** Typed `encode()`/`recall()`/`forget()` with ergonomic request builders + typed responses (RECALL streams MemoryResult frames to EOS). *Done when: round-trip against a real server; results match.*

**Phase 5 — errors / retries.** Map wire ErrorCode→language-native typed errors; retry policy keyed on the retryable category; idempotency-key generation. *Done when: malformed/again-able paths behave per the §04.07 taxonomy.*

**Phase 6 — typed-graph verbs (later).** ENTITY/STATEMENT/RELATION/SCHEMA/QUERY ops.

**Phase 7 — packaging/publish.** crates.io / PyPI / npm, versioned, with the wire-version they target documented.

## Testing strategy

The vendored conformance corpus is the primary drift guard for Phase 1 in every language (decode==json, re-encode==bytes). Cross-language parity falls out for free — if all three pass the same goldens they agree on the wire. Integration tests against a dockerized `brain-server` come in Phase 2+. No CI is added to the Brain repo.

## Dependency budget

Minimal + justified per language. Rust: ciborium/serde/serde_bytes/serde_repr/crc32c (+ tokio/thiserror/uuid in build phase). Python: cbor2/google-crc32c (+ pytest dev). TypeScript: a byte-string-aware CBOR lib + a CRC32C impl (+ tsx/vitest dev). Anything beyond requires justification.
