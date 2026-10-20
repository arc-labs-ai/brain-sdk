"""Every HTTP verb, against a running edge, success paths and failure paths.

Set ``BRAIN_SDK_IT_HTTP`` and ``BRAIN_SDK_IT_HTTP_KEY`` (or
``BRAIN_SDK_IT_API_KEY``) to run these. ``BRAIN_SDK_IT_REQUIRED=1`` turns a
missing configuration into a failure, which is what CI wants — a silent skip
is how a live suite rots without anyone noticing.

WHY THIS EXISTS ALONGSIDE ``test_http_edge.py``. That file covers six verbs:
whoami, capabilities, encode, recall, memory_list, forget. The client exposes
**25**, and the nineteen with no live coverage are exactly where the drift has
been found — ``include_trace`` and the list cursors shipped in one SDK only,
and nothing exercising them end to end would have said so.

FAILURES ARE ASSERTED, NOT AVOIDED. Half of what an SDK owes its caller is a
legible error: the right status, a code you can branch on, and no retry of a
request that cannot succeed. Each failure below pins a status that was
observed against a real server, so a change in the server's error mapping
fails here rather than in somebody's agent.
"""

from __future__ import annotations

import json
import os
from uuid import uuid4

import pytest

from brain_db_sdk.http import BrainHttpClient, HttpRetryPolicy
from brain_db_sdk.http.errors import BrainHttpError

#: The entity type every fixture uses. `1` is Person in the stock schema;
#: `list_entities` REQUIRES a type filter (the edge answers 400 without one),
#: so this is not cosmetic.
PERSON_TYPE_ID = 1

#: An id that is syntactically valid and certainly absent.
ABSENT_UUID = "00000000-0000-0000-0000-000000000000"


def _config() -> tuple[str, str]:
    base_url = os.environ.get("BRAIN_SDK_IT_HTTP")
    api_key = os.environ.get("BRAIN_SDK_IT_HTTP_KEY") or os.environ.get("BRAIN_SDK_IT_API_KEY")
    if not base_url or not api_key:
        message = (
            "live edge tests require BRAIN_SDK_IT_HTTP and "
            "BRAIN_SDK_IT_HTTP_KEY (or BRAIN_SDK_IT_API_KEY)"
        )
        if os.environ.get("BRAIN_SDK_IT_REQUIRED") == "1":
            pytest.fail(message)
        pytest.skip(message)
    return base_url, api_key


@pytest.fixture
def client() -> BrainHttpClient:
    """A client tuned for a LIVE suite, not for a hot path.

    The plan's ceiling is 60 requests/minute on Free, and an all-operations
    pass makes more than that — so being throttled part-way through is the
    normal case, not an error. The server answers 429 with ``Retry-After``;
    the default policy clamps that hint to ``max_delay`` (2s), far short of a
    60s fixed window, so the retries burn out and the suite fails on a
    condition that would have cleared by itself.

    Raising the cap past the window lets the hint through, which turns
    throttling into a pause instead of a failure — and exercises the 429 retry
    path against a real server while it is at it.
    """
    base_url, api_key = _config()
    return BrainHttpClient(
        api_key,
        base_url,
        retry=HttpRetryPolicy(max_attempts=4, base_delay=0.5, max_delay=70.0),
    )


@pytest.fixture
def stored(client: BrainHttpClient):
    """One memory that exists for the duration of a test, then does not.

    Every test that needs stored state makes its own and forgets it, so the
    suite is re-runnable and leaves the namespace as it found it.
    """
    text = f"all-ops probe {uuid4()}: Dana prefers dark mode in the editor."
    result = client.encode(text=text)
    try:
        yield result, text
    finally:
        client.forget(result.memory_id)


# ── identity ────────────────────────────────────────────────────────────────


def test_whoami_reports_named_permission_flags(client: BrainHttpClient) -> None:
    me = client.whoami()
    assert me.namespace
    assert me.space_id
    # Named flags, not a bitset. The cloud gateway served the latter for a
    # while and this client could not read it at all.
    assert isinstance(me.permissions.can_encode, bool)
    assert isinstance(me.permissions.can_recall, bool)


def test_capabilities_describes_the_shard(client: BrainHttpClient) -> None:
    caps = client.capabilities()
    assert caps.vector_dim > 0
    assert isinstance(caps.schema_namespaces, list)


# ── memory lifecycle ────────────────────────────────────────────────────────


def test_encode_recall_inspect_list_forget(client: BrainHttpClient, stored) -> None:
    result, text = stored

    assert result.memory_id
    assert result.was_deduplicated is False

    answer = client.recall(query=text, max_results=5)
    assert answer.answer_kind in {"single", "many", "none"}
    assert any(m.memory_id == result.memory_id for m in answer.memories)

    inspected = client.memory_inspect(result.memory_id)
    assert inspected.found is True
    assert inspected.memory_id == result.memory_id

    page = client.memory_list(limit=100)
    assert any(m.memory_id == result.memory_id for m in page.items)


def test_recall_returns_the_pipeline_trace_when_asked(client: BrainHttpClient, stored) -> None:
    """``include_trace`` was TypeScript-only until recently; this is the live
    proof that the field reaches the server and the trace comes back."""
    _, text = stored
    answer = client.recall(query=text, max_results=5, include_trace=True)

    assert answer.trace is not None, "include_trace was requested but no trace came back"
    # A JSON STRING, not a parsed object: the ids inside are 128-bit and a
    # JSON number would round them.
    assert isinstance(answer.trace, str)
    json.loads(answer.trace)


def test_recall_omits_the_trace_by_default(client: BrainHttpClient, stored) -> None:
    _, text = stored
    assert client.recall(query=text, max_results=1).trace is None


def test_encoding_the_same_text_twice_deduplicates(client: BrainHttpClient) -> None:
    text = f"all-ops dedup {uuid4()}"
    first = client.encode(text=text)
    try:
        second = client.encode(text=text)
        assert second.was_deduplicated is True
        assert second.memory_id == first.memory_id
    finally:
        client.forget(first.memory_id)


def test_forget_is_idempotent(client: BrainHttpClient) -> None:
    created = client.encode(text=f"all-ops forget {uuid4()}")
    assert client.forget(created.memory_id).was_already_forgotten is False
    assert client.forget(created.memory_id).was_already_forgotten is True


# ── links ───────────────────────────────────────────────────────────────────


def test_link_and_unlink_two_memories(client: BrainHttpClient) -> None:
    a = client.encode(text=f"all-ops link source {uuid4()}")
    b = client.encode(text=f"all-ops link target {uuid4()}")
    try:
        linked = client.link(a.memory_id, b.memory_id, "caused")
        assert linked.source == a.memory_id
        unlinked = client.unlink(a.memory_id, b.memory_id, "caused")
        assert unlinked.removed is True
    finally:
        client.forget(a.memory_id)
        client.forget(b.memory_id)


# ── typed graph: reads ──────────────────────────────────────────────────────


def test_graph_fetch_returns_a_page(client: BrainHttpClient) -> None:
    page = client.graph_fetch(limit=5)
    assert isinstance(page.nodes, list)
    assert isinstance(page.edges, list)


def test_list_entities_pages_with_a_cursor(client: BrainHttpClient) -> None:
    """The cursor fields were TypeScript-only: Python and Rust callers could
    read the first page and had no way to ask for the next."""
    page = client.list_entities(type_id=PERSON_TYPE_ID, limit=1)
    assert isinstance(page.entities, list)
    # `next_cursor` is None only when the page exhausted the collection.
    if page.next_cursor is not None:
        following = client.list_entities(type_id=PERSON_TYPE_ID, limit=1, cursor=page.next_cursor)
        first_ids = {e.entity_id for e in page.entities}
        assert all(e.entity_id not in first_ids for e in following.entities)


def test_entity_read_verbs(client: BrainHttpClient) -> None:
    page = client.list_entities(type_id=PERSON_TYPE_ID, limit=1)
    if not page.entities:
        pytest.skip("no entities in this namespace to read")
    entity_id = page.entities[0].entity_id

    detail = client.get_entity(entity_id)
    assert detail.entity_id == entity_id

    traversed = client.traverse_relations(entity_id)
    assert isinstance(traversed.paths, list)

    relations = client.list_relations(entity_id, limit=5)
    assert isinstance(relations.relations, list)
    for relation in relations.relations[:1]:
        assert client.get_relation(relation.relation_id).relation_id == relation.relation_id


def test_statement_read_verbs(client: BrainHttpClient) -> None:
    page = client.list_statements(limit=5)
    assert isinstance(page.statements, list)
    for statement in page.statements[:1]:
        fetched = client.get_statement(statement.statement_id)
        assert fetched.statement_id == statement.statement_id


def test_statements_carry_the_display_names_the_server_resolved(
    client: BrainHttpClient,
) -> None:
    """The gateway resolves `subject_name` / `object_name` so a caller does
    not have to. No SDK exposed them, so every consumer re-queried each id
    just to print a name — the second call the field exists to remove."""
    page = client.list_statements(limit=5)
    if not page.statements:
        pytest.skip("no statements in this namespace")
    assert any(s.subject_name for s in page.statements), (
        "the server sends subject_name for a resolvable subject; the SDK must surface it"
    )


def test_resolve_entity_finds_an_existing_name(client: BrainHttpClient) -> None:
    page = client.list_entities(type_id=PERSON_TYPE_ID, limit=1)
    if not page.entities:
        pytest.skip("no entities in this namespace to resolve")
    name = page.entities[0].canonical_name
    resolved = client.resolve_entity(candidate_name=name)
    assert resolved.outcome in {"resolved", "ambiguous", "created", "unresolved"}


# ── typed graph: writes ─────────────────────────────────────────────────────


def test_create_entity_then_read_it_back(client: BrainHttpClient) -> None:
    name = f"AllOps {uuid4().hex[:12]}"
    created = client.create_entity(entity_type_id=PERSON_TYPE_ID, canonical_name=name)
    assert created.entity_id
    assert client.get_entity(created.entity_id).canonical_name.lower() == name.lower()


def test_a_duplicate_entity_name_is_a_conflict_not_a_server_fault(
    client: BrainHttpClient,
) -> None:
    """409, not 502. The engine reports a duplicate as an internal error and
    the gateway used to pass that through — which blamed the engine for the
    caller's mistake AND put it in the retryable class, so the SDK's retry
    policy re-sent a request that could never succeed."""
    name = f"AllOps Dup {uuid4().hex[:12]}"
    client.create_entity(entity_type_id=PERSON_TYPE_ID, canonical_name=name)
    with pytest.raises(BrainHttpError) as excinfo:
        client.create_entity(entity_type_id=PERSON_TYPE_ID, canonical_name=name)
    assert excinfo.value.status == 409


# ── reasoning ───────────────────────────────────────────────────────────────


def test_plan_and_reason(client: BrainHttpClient, stored) -> None:
    _, text = stored
    plan = client.plan(start={"text": text}, goal={"text": "editor preference"})
    assert isinstance(plan.steps, list)

    reasoned = client.reason(observation={"text": text})
    assert isinstance(reasoned.inferences, list)


# ── schema ──────────────────────────────────────────────────────────────────


def test_get_schema_is_either_a_document_or_a_clean_404(client: BrainHttpClient) -> None:
    """A namespace with no schema is a normal state, not a fault — so this
    asserts the shape of BOTH answers rather than requiring one."""
    status: int | None = None
    namespace: str | None = None
    try:
        namespace = client.get_schema().namespace
    except BrainHttpError as err:
        status = err.status

    if status is None:
        assert namespace
    else:
        assert status == 404, "a namespace with no schema is a 404, not a fault"


def test_validate_schema_rejects_a_malformed_document(client: BrainHttpClient) -> None:
    """`validate` is the one schema verb that is safe to exercise for real:
    `upload` merges and `replace` DROPS every declaration the document omits,
    so neither is run against a live namespace from a test suite."""
    # The verb takes a schema DOCUMENT as text, and reports problems in the
    # body rather than as an HTTP error — a dry run that parsed nothing is
    # still a successful validation run with findings.
    result = client.validate_schema("this is not a schema")
    assert result.validation_errors, "an unparseable document must report errors"


# ── failures ────────────────────────────────────────────────────────────────


def test_a_rejected_key_is_401() -> None:
    base_url, _ = _config()
    with pytest.raises(BrainHttpError) as excinfo:
        BrainHttpClient("brain_not_a_real_key", base_url).whoami()
    assert excinfo.value.status == 401


def test_an_empty_query_is_refused(client: BrainHttpClient) -> None:
    with pytest.raises(BrainHttpError) as excinfo:
        client.recall(query="   ")
    assert excinfo.value.status in {400, 422}


def test_listing_entities_without_a_type_is_refused(client: BrainHttpClient) -> None:
    """Brain requires the type filter; the SDK makes it optional, so the
    refusal has to be legible rather than a surprise 500."""
    with pytest.raises(BrainHttpError) as excinfo:
        client.list_entities(limit=5)
    assert excinfo.value.status == 400


def test_an_unknown_entity_is_404(client: BrainHttpClient) -> None:
    with pytest.raises(BrainHttpError) as excinfo:
        client.get_entity(ABSENT_UUID)
    assert excinfo.value.status == 404


def test_inspecting_an_unknown_memory_reports_not_found_without_raising(
    client: BrainHttpClient,
) -> None:
    """`inspect` answers 200 with `found=False` rather than 404 — it is a
    debugging view, and "no such memory" is one of its answers."""
    assert client.memory_inspect("1").found is False


def test_forgetting_an_unknown_memory_is_not_an_error(client: BrainHttpClient) -> None:
    assert client.forget("1").was_already_forgotten is True


def test_errors_carry_a_status_and_a_code(client: BrainHttpClient) -> None:
    """The caller branches on these. An exception with only a message forces
    string-matching, which is how error handling rots."""
    with pytest.raises(BrainHttpError) as excinfo:
        client.get_entity(ABSENT_UUID)
    assert isinstance(excinfo.value.status, int)
    assert isinstance(excinfo.value.code, str) and excinfo.value.code
