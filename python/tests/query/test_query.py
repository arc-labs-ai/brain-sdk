"""Feature: QUERY introspection — explain (plan) and trace (execution).

Carries the regression test for the bug this suite's absence allowed. The
server's ``RetrieverWire`` encodes as the **variant-name string**, not its
discriminant, and Python was sending integers — so every QUERY_EXPLAIN and
QUERY_TRACE from this SDK was rejected. Nothing caught it because QUERY has no
conformance vector, Python had no query integration suite at all, and the one
Rust test that existed used ``Auto`` — a bare string in either encoding, so it
exercised nothing.

Every case here therefore uses ``Explicit``. A real server is the only oracle
that will reject a wrong encoding outright.

Integration only; gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder, new_id
from brain_db_sdk.wire.types import (
    QueryExplainRequest,
    QueryRequest,
    QueryTraceRequest,
    Retriever,
    RetrieverSelection,
)


def _query(text: str, *, retrievers: RetrieverSelection) -> QueryRequest:
    return QueryRequest(
        text=text,
        entity_anchor=None,
        kind_filter=[],
        predicate_filter=[],
        session_filter=None,
        time_filter=None,
        as_of_record_time_unix_nanos=None,
        confidence_min=None,
        include_tombstoned=False,
        include_superseded=False,
        limit=10,
        retrievers=retrievers,
        fusion_config=None,
        request_id=new_id(),
    )


def test_explain_returns_a_plan_with_explicit_retrievers(it):
    client, _space = it.connect_fresh()
    try:
        resp = client.query_explain(
            QueryExplainRequest(
                _query(
                    "coffee",
                    retrievers=RetrieverSelection.explicit(
                        [Retriever.SEMANTIC, Retriever.GRAPH]
                    ),
                )
            )
        )
        assert resp.plan_text, "explain returns a non-empty plan"
        assert resp.estimated_cost_ms >= 0.0
    finally:
        client.close()


def test_trace_returns_an_execution_trace_with_explicit_retrievers(it):
    client, _space = it.connect_fresh()
    try:
        client.encode(EncodeBuilder("Espresso is a concentrated coffee.").build())

        resp = client.query_trace(
            QueryTraceRequest(
                _query(
                    "coffee",
                    retrievers=RetrieverSelection.explicit([Retriever.LEXICAL]),
                )
            )
        )
        assert resp.trace_text, "trace returns a non-empty execution trace"
        assert resp.total_latency_ms >= 0.0
    finally:
        client.close()


def test_every_retriever_name_is_accepted_by_the_server(it):
    """Each variant individually — a wrong name fails only for that one.

    A single combined request would let one bad name hide behind a good one in
    whatever order the server validates.
    """
    client, _space = it.connect_fresh()
    try:
        for name in (Retriever.SEMANTIC, Retriever.LEXICAL, Retriever.GRAPH):
            resp = client.query_explain(
                QueryExplainRequest(
                    _query("anything", retrievers=RetrieverSelection.explicit([name]))
                )
            )
            assert resp.plan_text, f"server rejected retriever {name!r}"
    finally:
        client.close()
