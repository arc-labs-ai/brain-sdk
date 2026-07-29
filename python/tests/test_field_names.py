"""Field-name drift guard: the *attribute* a caller reads must be the field the
server sent.

``test_conformance.py`` proves the codec puts the right bytes on the wire. It
cannot prove the bytes land in the right attribute, because both of its checks
run through ``to_map()`` — the encoder. Invert a field pair in ``to_map`` *and*
``from_map`` together and every one of its assertions still passes:

    decode(golden).salience_min -> 1.0   (server said 0.0)
    to_map(that)                 -> {"salience_min": 0.0, ...}   matches mirror
    encode(that)                 -> identical bytes              matches .bin

That was verified by injecting exactly that swap: all 134 tests passed. The
caller silently reads the wrong number.

This module closes the hole by projecting the decoded value through
``dataclasses.asdict`` — which reads the **declared field names**, never the
encoder — and comparing that against the ``.json`` mirror, which carries the
server's own field names. A rename or a swap now shows up as a key mismatch.

Scope, stated honestly: the projection is only name-authoritative where the
value is a dataclass. Non-dataclass leaves (``RetrieverSelection`` and friends,
which are tagged-union wrappers) fall back to their ``to_cbor_value`` — for
those the encoder is still the only witness. They are few, and their variants
are unit-like, so a name swap has nothing to swap with.
"""

from __future__ import annotations

import dataclasses
import json
import struct
from pathlib import Path

import pytest

from brain_db_sdk.wire.cbor import _FloatField
from brain_db_sdk.wire.types import decode_payload


def _payload_types() -> dict:
    """The corpus-case -> payload-type table, borrowed from the conformance
    module so the two suites can never cover different case sets.

    Loaded by path: pytest runs with ``--import-mode=importlib``, which does not
    put ``tests/`` on ``sys.path``, so a plain import would not resolve.
    """
    import importlib.util

    path = Path(__file__).with_name("test_conformance.py")
    spec = importlib.util.spec_from_file_location("_corpus_case_table", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PAYLOAD_TYPES


PAYLOAD_TYPES = _payload_types()

CORPUS = Path(__file__).resolve().parents[2] / "conformance" / "corpus"

# Wire field names that are Python keywords get a trailing underscore. The
# mapping is declared rather than inferred so a genuinely misspelled field
# can't be waved through as "probably an alias".
FIELD_ALIASES = {"from_": "from"}

# Fields that are structurally absent from the CBOR map, so their absence from
# the mirror says nothing about drift. `vector` rides the trailing raw-f32
# section of the payload, never the CBOR — see the corpus README.
MIRROR_OMITS = {"vector"}


def _read_bin(name: str) -> bytes:
    return (CORPUS / f"{name}.bin").read_bytes()


def _read_json(name: str):
    return json.loads((CORPUS / f"{name}.json").read_text())


def _project(value):
    """Project a decoded payload to the mirror's shape using DECLARED names."""
    if isinstance(value, _FloatField):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    # Tagged unions first: they are dataclasses too (`variant` / `value`), but
    # their wire form is the discriminant, not those two book-keeping fields.
    to_cbor_value = getattr(value, "to_cbor_value", None)
    if callable(to_cbor_value):
        return _project(to_cbor_value())
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out = {}
        for f in dataclasses.fields(value):
            key = FIELD_ALIASES.get(f.name, f.name)
            out[key] = _project(getattr(value, f.name))
        return out
    if isinstance(value, dict):
        return {k: _project(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_project(v) for v in value]
    # Tagged-union wrappers and anything else self-describing.
    for hook in ("to_cbor_value", "to_map"):
        fn = getattr(value, hook, None)
        if callable(fn):
            return _project(fn())
    return value


def _f32(x: float) -> float:
    return struct.unpack("<f", struct.pack("<f", float(x)))[0]


def _compare(got, exp, path: str, errors: list[str]) -> None:
    """Deep-compare, collecting every mismatch rather than dying on the first."""
    if isinstance(got, dict) and isinstance(exp, dict):
        # The wire format omits a field holding its default (`act_as`/`trace`
        # when None, `wait` at Ack, `allow_duplicates` when false, empty
        # lists), so a declared field missing from the mirror is only drift if
        # it carries a real value. That is the one thing this check cannot see:
        # a field the SDK invented that happens to sit at its default. The
        # valuable half — a meaningful value the server never sent, or never
        # asked for — is caught.
        for k in got.keys() - exp.keys():
            if k in MIRROR_OMITS or not got[k]:
                continue
            errors.append(f"{path}.{k}: SDK has a field the server does not send")
        errors.extend(
            f"{path}.{k}: server sends a field the SDK does not declare"
            for k in exp.keys() - got.keys()
        )
        for k in got.keys() & exp.keys():
            _compare(got[k], exp[k], f"{path}.{k}", errors)
        return
    if isinstance(got, list) and isinstance(exp, list):
        if len(got) != len(exp):
            errors.append(f"{path}: length {len(got)} != {len(exp)}")
            return
        for i, (g, e) in enumerate(zip(got, exp)):
            _compare(g, e, f"{path}[{i}]", errors)
        return
    if isinstance(got, float) or isinstance(exp, float):
        if got is None or exp is None:
            if got is not exp:
                errors.append(f"{path}: {got!r} != {exp!r}")
            return
        if _f32(got) != _f32(exp):
            errors.append(f"{path}: {got!r} != {exp!r}")
        return
    if got != exp:
        errors.append(f"{path}: {got!r} != {exp!r}")


def _payload_cases():
    index = json.loads((CORPUS / "index.json").read_text())
    return [
        c["name"]
        for c in index
        if c["kind"] in ("request", "response") and c["name"] in PAYLOAD_TYPES
    ]


@pytest.mark.parametrize("name", _payload_cases())
def test_declared_field_names_match_the_server(name: str) -> None:
    value = decode_payload(PAYLOAD_TYPES[name], _read_bin(name))

    errors: list[str] = []
    _compare(_project(value), _read_json(name), name, errors)

    assert not errors, f"{name}: declared fields disagree with the server\n  " + "\n  ".join(errors)
