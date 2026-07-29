"""Feature: ENCODE_VECTOR_DIRECT — write a pre-computed embedding, bypassing the
server's owned embedding model (integration, real server).

This is the only verb whose payload is not pure CBOR: the vector rides a
trailing raw little-endian f32 section after the CBOR map, so the frame carries
two differently-encoded regions. Nothing else in the protocol works that way,
which makes it the easiest framing to get subtly wrong and the least likely to
be noticed — a dropped or truncated trailer still produces a well-formed frame.

What actually proves the framing is the *accepting* case, not the rejecting
ones. Verified by dropping the trailer from the encoder: the wrong-length tests
still passed, because zero floats is also a wrong count. Only
``test_encode_vector_direct_round_trips`` failed. A successful 384-float write
is therefore the load-bearing assertion — it can only succeed if the trailer
arrived, carried exactly 384 f32s, and was little-endian, since the server
checks all three (see the byte-order case below, which is rejected for having
the wrong magnitude once misread).

The rejection cases earn their place differently: they prove the server
*validates* rather than accepts anything, without which the accepting case
would prove nothing.

Gated on ``BRAIN_SDK_IT_DATA`` via the ``it`` fixture.
"""

from __future__ import annotations

import math
import struct
import uuid

import pytest

from brain_db_sdk import EncodeBuilder, new_id
from brain_db_sdk.errors import ServerError
from brain_db_sdk.wire.types import EncodeVectorDirectRequest, MemoryKind

# BGE-small-en-v1.5, the model the integration server loads.
DIM = 384


def _unit_vector(dim: int = DIM) -> list[float]:
    """A normalized constant vector — a valid unit embedding of `dim` floats."""
    return [1.0 / math.sqrt(dim)] * dim


def _request(fingerprint: bytes, *, vector: list[float], label: str) -> EncodeVectorDirectRequest:
    return EncodeVectorDirectRequest(
        text=f"{label} {uuid.uuid4()}",
        model_fingerprint=fingerprint,
        session_id=0,
        kind=MemoryKind.EPISODIC,
        salience_hint=0.5,
        edges=[],
        request_id=new_id(),
        txn_id=None,
        deduplicate=False,
        vector=vector,
    )


@pytest.fixture
def fingerprint(it):
    """The server's embedding-model fingerprint.

    A direct-vector write must carry it, so the server knows the pre-computed
    vector came from the same model it would have used. A normal ENCODE response
    reports it, so learn it rather than hard-coding a value that changes with the
    model.
    """
    client, _space = it.connect_fresh()
    try:
        return client.encode(EncodeBuilder("fingerprint probe").build()).embedding_model_fp
    finally:
        client.close()


def test_encode_vector_direct_round_trips(it, fingerprint) -> None:
    client, _space = it.connect_fresh()
    try:
        resp = client.encode_vector_direct(
            _request(fingerprint, vector=_unit_vector(), label="client-supplied vector")
        )
        # Same durability contract as ENCODE: a returned response is WAL-durable.
        assert resp.lsn > 0, "a direct-vector encode assigns a durable LSN"
        assert resp.memory_id, "the write must come back with a memory id"
    finally:
        client.close()


@pytest.mark.parametrize("dim", [DIM - 1, DIM + 1, 8], ids=["one-short", "one-long", "way-off"])
def test_a_wrong_length_vector_is_rejected(it, fingerprint, dim) -> None:
    """The server counts the f32s in the raw section and objects to a wrong one.

    On its own this does not prove the trailer is well-framed — a dropped
    trailer is zero floats, which is also wrong, so these pass either way
    (confirmed by injecting exactly that fault). What it establishes is that the
    server is checking, which is what makes the accepting case meaningful.
    """
    client, _space = it.connect_fresh()
    try:
        with pytest.raises(ServerError) as excinfo:
            client.encode_vector_direct(
                _request(fingerprint, vector=_unit_vector(dim), label=f"dim {dim}")
            )
        assert "dimension" in str(excinfo.value), (
            f"expected a dimension complaint for {dim} floats, got: {excinfo.value}"
        )
    finally:
        client.close()


def test_a_byte_swapped_vector_is_rejected(it, fingerprint) -> None:
    """Pins little-endian byte order for the trailer.

    Three independent implementations write these bytes; endianness is the
    classic thing to get quietly wrong, and a byte-swapped trailer still has the
    right element count, so the dimension check sails past it. The server also
    requires a roughly unit-magnitude vector, and a unit vector read in the
    wrong byte order is nowhere near unit — so magnitude is what catches it.
    """
    client, _space = it.connect_fresh()
    try:
        swapped = [
            struct.unpack("<f", struct.pack(">f", x))[0] for x in _unit_vector()
        ]
        with pytest.raises(ServerError) as excinfo:
            client.encode_vector_direct(
                _request(fingerprint, vector=swapped, label="byte-swapped")
            )
        assert "vector" in str(excinfo.value), (
            f"expected the server to reject a mis-ordered vector, got: {excinfo.value}"
        )
    finally:
        client.close()


def test_a_wrong_model_fingerprint_is_rejected(it) -> None:
    """The companion proof, for the CBOR half of the payload.

    A vector from a different model is meaningless next to the server's own
    embeddings, so the fingerprint is checked. That the check fires also
    confirms the CBOR map is being read alongside the raw trailer, rather than
    the payload being treated as one undivided blob.
    """
    client, _space = it.connect_fresh()
    try:
        with pytest.raises(ServerError) as excinfo:
            client.encode_vector_direct(
                _request(b"\x00" * 16, vector=_unit_vector(), label="wrong fingerprint")
            )
        assert "fingerprint" in str(excinfo.value), (
            f"expected a fingerprint complaint, got: {excinfo.value}"
        )
    finally:
        client.close()
