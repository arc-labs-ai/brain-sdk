# Changelog

## 0.1.0 (2026-10-06)


### Fixes

* **ci:** make check_protocol.sh run on GNU mktemp; clear biome errors ([f9f1104](https://github.com/arc-labs-ai/brain-sdk/commit/f9f11041236616f169e96055802f4ced7cf3f1a1))
* complete the TypeScript codecs and mirror the server's ByeRequest ([9971c4e](https://github.com/arc-labs-ai/brain-sdk/commit/9971c4ead5cbf10c92e669ad9bf89229d9bf4121))
* enforce the negotiated payload limit, and stop Rust panicking on it ([8cb42ca](https://github.com/arc-labs-ai/brain-sdk/commit/8cb42cac33f266ef29b557b56981d9048d18b9b1))
* **python-sdk:** annotate two to_map dicts that broke the pyright gate ([6f69a78](https://github.com/arc-labs-ai/brain-sdk/commit/6f69a7826ccbd363d5b24ee4d95caf5a0adecda0))
* **python-sdk:** stop the pool reconnect test racing on Linux ([fc05a5c](https://github.com/arc-labs-ai/brain-sdk/commit/fc05a5c51c02aed88a80c10f17d368468b39bd2a))
* QueryRequest was missing session_filter in all three SDKs ([b603887](https://github.com/arc-labs-ai/brain-sdk/commit/b603887b71abbe757a5cc9f1a44a9ed3f2b78e23))
* RetrieverWire is a string on the wire; Python and TypeScript sent integers ([713bc4b](https://github.com/arc-labs-ai/brain-sdk/commit/713bc4b0d29c8686b7263f41c826ef0b79bca121))
* **retry:** add full jitter to exponential backoff ([9ba2656](https://github.com/arc-labs-ai/brain-sdk/commit/9ba2656ced0bc5a0da387107003dcabb3e036022))
* **rust-sdk:** make the crate pass its own clippy gate ([b752cb1](https://github.com/arc-labs-ai/brain-sdk/commit/b752cb191d87d50f840095fc850e3d1b69bf336c))
* **rust-sdk:** satisfy clippy::assert_is_empty (new in Rust 1.99) ([d45d0a9](https://github.com/arc-labs-ai/brain-sdk/commit/d45d0a9308b93b651bd8b50e90239d706f969496))


### Features

* allow_duplicates opt-out + wire-lockstep refresh (3 langs) ([b61bf83](https://github.com/arc-labs-ai/brain-sdk/commit/b61bf83ab1c1124c6e81c37caeca63901529b876))
* **auth:** mandatory key auth — identity from the credential, fail-closed ([72eb199](https://github.com/arc-labs-ai/brain-sdk/commit/72eb199815b1e187aaa1c57a8936a7d467ee492b))
* complete the HTTP surface in all three SDKs, and gate it ([9a55493](https://github.com/arc-labs-ai/brain-sdk/commit/9a554930fbfca2b19e431907de7827a885aab649))
* fixed corpos fixes ([7faba66](https://github.com/arc-labs-ai/brain-sdk/commit/7faba669a91024c77aa50ba32ab3e0940e8e7c42))
* fixed sdk methods ([165564d](https://github.com/arc-labs-ai/brain-sdk/commit/165564d2fc4351ab1e1ecfc9283ec4cc99b98409))
* **python:** add pyright, and ship the py.typed marker that made it matter ([a7b6f30](https://github.com/arc-labs-ai/brain-sdk/commit/a7b6f309a439a8f0aafaa356658761cdc7d6391c))
* **python:** add SCHEMA_REPLACE and CANCEL_STREAM ([77d1f47](https://github.com/arc-labs-ai/brain-sdk/commit/77d1f47c54dd1b84fc7d43081dfacc98b777a1af))
* **python:** answer SERVER_PING with CLIENT_PONG (keepalive) ([76b3507](https://github.com/arc-labs-ai/brain-sdk/commit/76b35072057a764b2bf6bf1126c3e922c07af5d8))
* **rust-sdk:** add client-initiated ping() for PING/PONG parity ([202f5f8](https://github.com/arc-labs-ai/brain-sdk/commit/202f5f8904f337fd8902a52aac6ef95936fc84b1))
* **rust:** add SCHEMA_REPLACE and CANCEL_STREAM ([9000ce2](https://github.com/arc-labs-ai/brain-sdk/commit/9000ce295c9bf02bb66c05fd0bd9ce9c5092e1b3))
* **rust:** answer SERVER_PING with CLIENT_PONG (keepalive) ([d6b679f](https://github.com/arc-labs-ai/brain-sdk/commit/d6b679fb6424bb83a6eeac45879b98350a8c9e6c))
* **sdk:** RECALL-sole-read lockstep + EXTRACTOR_LIST verb (3 langs) ([bf46417](https://github.com/arc-labs-ai/brain-sdk/commit/bf46417bed519d57111bf394578fb19e51de2f7e))
* **sdk:** reconnect dead pool members in Python and TypeScript ([a7f6fb7](https://github.com/arc-labs-ai/brain-sdk/commit/a7f6fb76ce360d335e3e5ef679b9edba21cb6053))
* **sdk:** wire parity with Brain — RECALL scope + StatementHistory pagination ([6e8eb17](https://github.com/arc-labs-ai/brain-sdk/commit/6e8eb17b84f718a49596f7c6a36fe4368c73fc3a))
* **tenancy:** derive_space_id client helper + finish Python ConnectionInfo ([90a1b19](https://github.com/arc-labs-ai/brain-sdk/commit/90a1b19c60fd2ffb0c8ed73692a0977b9a7332db))
* **tenancy:** space/session wire contract across all three SDKs ([c7750ed](https://github.com/arc-labs-ai/brain-sdk/commit/c7750ed1319bfdf13fac0c9ab97d1c5ea5e27f60))
* **ts-sdk:** add client-initiated ping() for PING/PONG parity ([3f62811](https://github.com/arc-labs-ai/brain-sdk/commit/3f62811fe85845f370217ec625469645192a5a27))
* **typescript:** add SCHEMA_REPLACE and CANCEL_STREAM, and unbreak the build ([789728c](https://github.com/arc-labs-ai/brain-sdk/commit/789728c8ae7844dad2cf1ff3a1fc16169faca900))
* **typescript:** answer SERVER_PING with CLIENT_PONG (keepalive) ([a74aaec](https://github.com/arc-labs-ai/brain-sdk/commit/a74aaec25f1ab5b5d813304a5d622258bdda4a57))
* **wire:** add act_as to TxnBeginRequest (delegated transactions) ([d358271](https://github.com/arc-labs-ai/brain-sdk/commit/d3582714d040f37256565d97f44da3a60df063c1))
* **wire:** add EntityGetResponse.resolved_from (ENTITY_GET merge-redirect chain) ([7e52a3f](https://github.com/arc-labs-ai/brain-sdk/commit/7e52a3f77fbefcbaeb2a910258795801e5747318))
* **wire:** add SCHEMA_DROP opcode ([e6d00be](https://github.com/arc-labs-ai/brain-sdk/commit/e6d00bec311cde813e15bc42da7653c9274d7989))
* **wire:** RecallTraceCandidate carries item_id + kind ([3a488b8](https://github.com/arc-labs-ai/brain-sdk/commit/3a488b8745059752a1e9800439539c4a7ba9271d))


### Performance

* **mux:** make TS read-pump consumption amortized-linear ([3a3764b](https://github.com/arc-labs-ai/brain-sdk/commit/3a3764be056f6e4018a4b1cb7882f0b49a4c90c4))


### Refactoring

* one API shape across the three SDKs ([a56cc3b](https://github.com/arc-labs-ai/brain-sdk/commit/a56cc3bbbc2e358e1d8636f8ac5f84002ed6a104))
* **tenancy:** finish naming lockstep — SpacePermissions, ConnectionInfo, resolution_context ([fd59db9](https://github.com/arc-labs-ai/brain-sdk/commit/fd59db92f7507054d2b99728a79dc91dc32b8b1b))


### Tests and verification

* add space/session/materialize integration suites across all SDKs ([a925a7e](https://github.com/arc-labs-ai/brain-sdk/commit/a925a7ea6d002a3ed090b6a5c625e8e0073f8b69))
* adversarial decode suite, and fix the recursion hole it found ([de06006](https://github.com/arc-labs-ai/brain-sdk/commit/de060067288c7e88e2b60f0d4d7bb84c574775ec))
* bring Python and TypeScript integration to parity with Rust ([08761ea](https://github.com/arc-labs-ai/brain-sdk/commit/08761ead36d0c4d624ddb486b71c3360176bcd6c))
* close the API-surface boundary and fix two cross-SDK divergences ([00bc331](https://github.com/arc-labs-ai/brain-sdk/commit/00bc331534a2a2d3aada8726be68bf79ebde9ceb))
* **conformance:** vendor + wire read-side response fixtures ([904072a](https://github.com/arc-labs-ai/brain-sdk/commit/904072a48102220d84a27c10c7e4f512c0a2724c))
* cover the HTTP tier, which had no tests in any of the three SDKs ([d3201de](https://github.com/arc-labs-ai/brain-sdk/commit/d3201dea138f5f079cbe9cea620610cb112680fe))
* drive the Rust conformance runner from index.json ([ea3a9e2](https://github.com/arc-labs-ai/brain-sdk/commit/ea3a9e2fe5e0b8b3387b1479b496de6f6920f0c9))
* encode_vector_direct in all three, and make the assertions actually prove something ([017a190](https://github.com/arc-labs-ai/brain-sdk/commit/017a190fe677df9270d348937374a6f338785627))
* gate the wire types against the server's own definitions ([d41c1ee](https://github.com/arc-labs-ai/brain-sdk/commit/d41c1eece38c63683d7a086b535e882c573da4ec))
* guard field names, which the byte-level corpus cannot ([5e2b8af](https://github.com/arc-labs-ai/brain-sdk/commit/5e2b8afefe74bb0f3831aa467d30550d7ab61ab0))
* make a skipped integration run fail loudly, and gate Python properly ([96da435](https://github.com/arc-labs-ai/brain-sdk/commit/96da435c7cd9c1a386dbb718436ac8cd840dcfa1))
* make the corpus coverage gap tracked instead of invisible ([f1807df](https://github.com/arc-labs-ai/brain-sdk/commit/f1807df585c1915e7baa29c8d6dba5e0316b2674))
* **py-sdk:** integration coverage for schema-drop/extractor-list/ping; add client.ping() ([46c0eb3](https://github.com/arc-labs-ai/brain-sdk/commit/46c0eb34d8745ae2b6a5622ae67ad8cdcd437ae4))
* run the integration tier for the first time, and fix what that exposed ([89b7b1c](https://github.com/arc-labs-ai/brain-sdk/commit/89b7b1c568149a3f67d3718b7df8f3f21639ed7f))
* **rust-sdk:** integration coverage for schema-drop, extractor-list, tcp memory list/inspect and graph-fetch ([ea924d2](https://github.com/arc-labs-ai/brain-sdk/commit/ea924d283d9096c09f434af509c700f41bf8c421))
* **sdk:** STATEMENT_HISTORY limit must be 1..=1000, not 0 ([62c5e92](https://github.com/arc-labs-ai/brain-sdk/commit/62c5e925f47136c7f85947558ac4f735ea528c6f))
* stop the TypeScript integration suite flaking on a 5s timeout ([d278d49](https://github.com/arc-labs-ai/brain-sdk/commit/d278d49695edba56e3e882dd064b870b822f3351))
* **ts-sdk:** integration coverage for schema-drop/list, extractor-list, txn-abort ([538bbe2](https://github.com/arc-labs-ai/brain-sdk/commit/538bbe2b22a9d152e33c7f424a5188236c499a75))
* vendor the complete corpus — every declared opcode is now pinned ([1d76304](https://github.com/arc-labs-ai/brain-sdk/commit/1d76304380abbc74ffd4acfdc5b11823ede12280))
* vendor the QUERY_EXPLAIN / QUERY_TRACE corpus vectors ([6534e8a](https://github.com/arc-labs-ai/brain-sdk/commit/6534e8a8c29a20e6a1feb57f53523f4df4497ed5))
* **wire:** assert shared types and opcodes agree with brain-protocol ([9910a05](https://github.com/arc-labs-ai/brain-sdk/commit/9910a05d6174573f469525ec45a94dac7b861a8f))


### Build and tooling

* add the TypeScript linter, and run the integration suites for real ([fee5bed](https://github.com/arc-labs-ai/brain-sdk/commit/fee5bed2906d54af266bcf8d1b1e78653addf609))
* automate the changelog and version bump with release-please ([cb8e789](https://github.com/arc-labs-ai/brain-sdk/commit/cb8e7891011cc8ecde1e13f0766854a2fd019ea5))
* gate dev PRs and keep one CI run per commit ([840d1cd](https://github.com/arc-labs-ai/brain-sdk/commit/840d1cd2392e56a6aebb4a108f65978e1a3eb4c4))
* gate the HTTP contract alongside the wire one ([4998e28](https://github.com/arc-labs-ai/brain-sdk/commit/4998e28a000b5ec7043581dd18a0ac6267af2976))
* GitHub Actions for Rust + Python + TypeScript ([bb8cfc9](https://github.com/arc-labs-ai/brain-sdk/commit/bb8cfc9d0d02d88a8747348f292fd4215b56a5c1))
* give the SDK release the same escape hatch as brain-db ([d6baab7](https://github.com/arc-labs-ai/brain-sdk/commit/d6baab77a7c6f6f2d8bb9b93fe7a78f49be96d09))
* ignore target/.git when used as a Docker named build context ([f398869](https://github.com/arc-labs-ai/brain-sdk/commit/f39886956d2fbb0aecfc742ae24b27783edbbb9f))
* lint all three SDKs in depth, every exclusion evidence-based ([79f972f](https://github.com/arc-labs-ai/brain-sdk/commit/79f972feedcc7ec0ea9061de639dccbec9c74dd1))
* publish via OIDC trusted publishing on all three registries ([b5e50ba](https://github.com/arc-labs-ai/brain-sdk/commit/b5e50ba72294253635dea727d2bdd29cd77f0afb))
* **python-sdk:** raise the supported floor from 3.9 to 3.10 ([4859a94](https://github.com/arc-labs-ai/brain-sdk/commit/4859a941a2263783ac0e7e096adf405cee62e7f9))
* replace ESLint with Biome for both linting and formatting ([e240aa0](https://github.com/arc-labs-ai/brain-sdk/commit/e240aa08ad482dc3855fb384a637f2d8717b4dbf))
* tag releases under a PAT so the SDK publish actually fires ([b95d9b4](https://github.com/arc-labs-ai/brain-sdk/commit/b95d9b41f34a2e69fc3d6a57ef9e96a59c90b765))
* tag-triggered release pipeline → crates.io / PyPI / npm ([1356eaf](https://github.com/arc-labs-ai/brain-sdk/commit/1356eaf53bab0bf754d1747a132b3c004d6b1b30))


### Documentation

* **conformance:** refresh corpus provenance to a reproducible pin ([8ca5f49](https://github.com/arc-labs-ai/brain-sdk/commit/8ca5f49f4f93c2dfc8e94a0582032f729febe89e))
* **conformance:** update corpus provenance to the 54-fixture pin ([737aece](https://github.com/arc-labs-ai/brain-sdk/commit/737aecef950cd25106818f84eb8d2950a5b4f438))
* correct CBOR float-encoding comment and pooling status ([34e8a44](https://github.com/arc-labs-ai/brain-sdk/commit/34e8a44b3d32b3e802087cebc0cf5fdb25d53dbd))
* drop top-level ARCHITECTURE/PLAN/RELEASING; keep README + LICENSE ([d67da8c](https://github.com/arc-labs-ai/brain-sdk/commit/d67da8c57b760524370e87f23daf06494cc1e23f))
* **readme:** drop links to the removed ARCHITECTURE.md / PLAN.md ([f5d7bfa](https://github.com/arc-labs-ai/brain-sdk/commit/f5d7bfafa5804f1085525536ce56d13e54d9e902))


### Chores

* **release:** cut 0.1.0 as the first release, not 1.0.0 ([089e9eb](https://github.com/arc-labs-ai/brain-sdk/commit/089e9eb5ca5ae47017ad0c9027bf18b14d21be94))
