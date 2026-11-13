"""A memory id wider than 64 bits must survive the HTTP tier intact.

Brain's memory ids are 128-bit, and real ones already exceed `u64::MAX`:
`18446744078004518912` came off a live server during acceptance, and
`2**64 - 1` is `18446744073709551615`. The HTTP contract therefore carries
the id as a decimal *string*, which is also why the TypeScript SDK needs
`http-bigint` -- `JSON.parse` has no integer wider than a double and would
round it.

Python cannot round it, because `int` is arbitrary precision and the field is
a `str` either way. That is exactly why this is worth pinning: nothing here
fails today, so nothing would notice if the field were narrowed to an `int`
parsed as 64 bits, or reformatted on the way through. Both would truncate ids
that already exist.

Mirrors `typescript/test/http-bigint` and `rust/tests/http_client`.
"""

from __future__ import annotations

import pytest

from brain_db_sdk.http.types import EncodeResult

# Real and boundary values, not round numbers.
WIDE_IDS = [
    "18446744073709551615",  # u64::MAX — the last id a 64-bit parse survives
    "18446744073709551616",  # u64::MAX + 1 — the first it does not
    "18446744078004518912",  # observed on a live server
    "340282366920938463463374607431768211455",  # u128::MAX
]


@pytest.mark.parametrize("wire_id", WIDE_IDS)
def test_a_wide_memory_id_is_carried_verbatim(wire_id: str) -> None:
    r = EncodeResult.from_dict(
        {
            "memory_id": wire_id,
            "was_deduplicated": False,
            "salience": 0.5,
            "kind": 0,
            "created_at_unix_nanos": 1794490715610387801,
            "auto_edges_added": 0,
        }
    )
    # Carried as the exact decimal string the server sent: no parse, no
    # reformat, no loss.
    assert r.memory_id == wire_id
    assert isinstance(r.memory_id, str)
    # And it is still the number it claims to be, which is what a caller who
    # does convert it depends on.
    assert str(int(r.memory_id)) == wire_id


def test_a_wide_id_would_not_survive_a_64_bit_parse() -> None:
    # Pins why the field is a string. If someone narrows it, this is the
    # arithmetic that makes the ids wrong rather than the type that makes the
    # build fail.
    observed = 18446744078004518912
    assert observed > 2**64 - 1
    assert observed & (2**64 - 1) != observed, "truncation would change the id"
