"""Feature: REASON — inference over stored memory (integration, real server).

REASON is a streamed verb; the client flattens the frames. What is asserted is
the contract a caller depends on: the server accepts every parameter and honors
the ``max_inferences`` cap.

Deliberately no floor on ``step.confidence``. ``confidence_threshold`` gates
*traversal* — which premises reasoning will follow — not the *output*, so a
returned inference can legitimately carry a computed confidence below it.
Asserting otherwise would be a test that fails for a correct server.

Ported from the Rust suite, which had it while the other two SDKs did not.
Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture.
"""

from __future__ import annotations

from brain_db_sdk import EncodeBuilder
from brain_db_sdk.wire.types import ObservationInput, ReasonRequest

MAX_INFERENCES = 32


def _request(observation: ObservationInput) -> ReasonRequest:
    return ReasonRequest(
        observation=observation,
        depth=4,
        confidence_threshold=0.6,
        session_filter=None,
        max_inferences=MAX_INFERENCES,
        budget_wall_time_ms=2_000,
        request_id=None,
        txn_id=None,
        trace=False,
    )


def test_reason_from_a_text_observation_round_trips(it):
    client, _space = it.connect_fresh()
    try:
        inferences = client.reason(_request(ObservationInput.by_text("the lights are off")))
        assert len(inferences) <= MAX_INFERENCES, (
            f"server must honor the max_inferences cap: got {len(inferences)}"
        )
    finally:
        client.close()


def test_reason_from_a_memory_observation_round_trips(it):
    client, _space = it.connect_fresh()
    try:
        memory_id = client.encode(
            EncodeBuilder("The server room lost power at 3am.").build()
        ).memory_id

        inferences = client.reason(_request(ObservationInput.by_memory_id(memory_id)))
        assert len(inferences) <= MAX_INFERENCES, (
            f"server must honor the max_inferences cap: got {len(inferences)}"
        )
        for i, step in enumerate(inferences):
            assert step.step_index == i, "inferences must be contiguously indexed"
    finally:
        client.close()
