"""Feature: PLAN — goal-directed traversal between two memory states
(integration, real server).

PLAN is a streamed verb: the server may answer across several frames and the
client flattens them. What is asserted here is the shape the caller actually
depends on — contiguous step indices — rather than that a path exists, since
two unlinked memories may legitimately have none.

Ported from the Rust suite, which had it while the other two SDKs did not.
Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder
from brain_db_sdk.wire.types import PlanBudget, PlanRequest, PlanState, PlanStrategy

# The server caps `budget.max_steps` at its configured max_traversal_depth (10
# by default) and rejects anything larger with a validation error, so a
# realistic budget stays at or under that bound.
MAX_STEPS = 8


def _budget() -> PlanBudget:
    return PlanBudget(max_steps=MAX_STEPS, max_wall_time_ms=5_000, max_branches_explored=256)


def _assert_contiguous(steps) -> None:
    for i, step in enumerate(steps):
        assert step.step_index == i, "steps must be contiguously indexed"


def test_plan_between_two_memories_round_trips(it):
    client, _space = it.connect_fresh()
    try:
        start = client.encode(EncodeBuilder("Start: I am in Paris.").build()).memory_id
        goal = client.encode(EncodeBuilder("Goal: I want to reach Rome.").build()).memory_id

        steps = client.plan(
            PlanRequest(
                start=PlanState.by_memory_id(start),
                goal=PlanState.by_memory_id(goal),
                budget=_budget(),
                strategy_hint=PlanStrategy.AUTO,
                session_filter=None,
                request_id=None,
                txn_id=None,
                trace=False,
            )
        )
        # A path may or may not exist between two unlinked memories; either way
        # the server answers with a well-formed step list rather than erroring.
        _assert_contiguous(steps)
    finally:
        client.close()


def test_plan_to_a_text_goal_round_trips(it):
    client, _space = it.connect_fresh()
    try:
        start = client.encode(
            EncodeBuilder("The project kicked off in January.").build()
        ).memory_id

        steps = client.plan(
            PlanRequest(
                start=PlanState.by_memory_id(start),
                goal=PlanState.by_text("the project shipped"),
                budget=_budget(),
                strategy_hint=PlanStrategy.A_STAR,
                session_filter=None,
                request_id=None,
                txn_id=None,
                trace=False,
            )
        )
        _assert_contiguous(steps)
    finally:
        client.close()
