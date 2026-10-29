"""`EncodeVectorDirectRequest.from_map` must land every value on its own field.

This type is the one place where the dataclass field order diverges from the
wire order. `vector` is not in the CBOR map at all — it travels in the frame's
trailing raw section, which is why the Rust SDK marks it `#[serde(skip)]` —
but Python needs it to carry a default, and a defaulted field cannot precede
the required ones. So it sits between `deduplicate` and `act_as` here while
Rust declares it second.

`from_map` built the object positionally, so the tenth positional argument
landed in `vector` rather than `act_as`: a decoded request came back with an
`ActAs` sitting in its embedding field and `act_as` reading `None`. Every
existing test for this type constructs it with keywords and none called
`from_map`, so nothing noticed; pyright did, once a format fix let the job
reach the type-check step.
"""

from brain_db_sdk.wire.types import ActAs, EncodeVectorDirectRequest, MemoryKind


def _map(**overrides: object) -> dict:
    m: dict = {
        "text": "a memory",
        "model_fingerprint": b"\x00" * 16,
        "session_id": 0,
        "kind": MemoryKind.EPISODIC,
        "salience_hint": 0.5,
        "edges": [],
        "request_id": b"\x11" * 16,
        "txn_id": None,
        "deduplicate": False,
    }
    m.update(overrides)
    return m


def test_act_as_decodes_onto_act_as_and_not_onto_vector() -> None:
    req = EncodeVectorDirectRequest.from_map(
        _map(act_as={"namespace": "acme", "space": "support-bot:user123", "grant": 0})
    )

    assert req.act_as == ActAs(namespace="acme", space="support-bot:user123", grant=0)
    # The regression: `vector` held the ActAs and `act_as` held None.
    assert req.vector == []


def test_a_map_without_act_as_decodes_to_none() -> None:
    req = EncodeVectorDirectRequest.from_map(_map())

    assert req.act_as is None
    assert req.vector == []


def test_the_other_fields_survive_the_positional_call() -> None:
    """The fix moves one argument to a keyword; the nine before it must not shift."""
    req = EncodeVectorDirectRequest.from_map(_map(text="pinned", deduplicate=True))

    assert req.text == "pinned"
    assert req.model_fingerprint == b"\x00" * 16
    assert req.session_id == 0
    assert req.kind == MemoryKind.EPISODIC
    assert req.salience_hint == 0.5
    assert req.edges == []
    assert req.request_id == b"\x11" * 16
    assert req.txn_id is None
    assert req.deduplicate is True
