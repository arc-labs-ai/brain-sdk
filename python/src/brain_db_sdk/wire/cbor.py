"""CBOR payload codec + trailing raw-vector section.

A wire payload is a CBOR map carrying the structured fields, optionally
followed by a raw little-endian ``f32`` block for embedding vectors.
Vectors stay out of the CBOR so the floats keep full precision (CBOR
would otherwise risk half-precision rounding) and stay contiguous for a
bulk copy.

Determinism is field-order plus per-field float width:

  * Map key order is the server's schema order. cbor2 in its default
    (non-canonical) mode emits a map in Python dict insertion order, so
    building each ``to_map`` in schema order reproduces the byte layout.
    Canonical mode must NOT be used — it sorts keys.

  * Float width is per-field, carried by the value's *type*, because cbor2
    has no single mode that matches the server. The server (ciborium)
    emits *every* float field as the shortest IEEE-754 form that round-
    trips it (half, single, or double) — an f32 field after first rounding
    to 32-bit precision, an f64 field at full precision. cbor2 default
    keeps every float a 64-bit double; cbor2 canonical shrinks every float
    but also sorts keys, so neither global mode works. So each float field
    is wrapped in an :class:`F32` or :class:`F64` marker and a ``default``
    hook emits the shortest faithful form.
"""

from __future__ import annotations

import struct

import cbor2


class _FloatField:
    """Base marker for a typed float wire field.

    Deliberately NOT a ``float`` subclass: cbor2 already knows how to
    encode a ``float`` (always as a 64-bit double) and would never consult
    the ``default`` hook for one. Wrapping the value in an unknown type
    forces cbor2 to defer to the hook, which then emits the *shortest*
    IEEE-754 form. The wrapped value stays readable for the JSON-mirror
    comparison via ``float()``.
    """

    __slots__ = ("value",)

    def __init__(self, value: float) -> None:
        self.value = float(value)

    def __float__(self) -> float:
        return self.value

    def __eq__(self, other: object) -> bool:
        if isinstance(other, _FloatField):
            return self.value == other.value
        if isinstance(other, (int, float)):
            return self.value == other
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.value)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.value!r})"


class F32(_FloatField):
    """A 32-bit wire float. The value has been rounded through single
    precision, so its shortest faithful CBOR form is half or single."""


class F64(_FloatField):
    """A 64-bit wire float, shortest-encoded at full precision (half,
    single, or double — whichever round-trips). The server applies the
    same shortest-float rule to f64 fields, so 12.5 emits as a half."""


def _shortest_float_bytes(value: float) -> bytes:
    """Encode a float as the shortest faithful CBOR form.

    The server picks the shortest IEEE-754 form that round-trips the
    value: half (0xF9) if half preserves it, else single (0xFA) if single
    preserves it, else double (0xFB). Applied to both f32 and f64 fields —
    the only difference upstream is whether the value was first rounded to
    32-bit precision.
    """
    if value == value and value not in (float("inf"), float("-inf")):
        try:
            half = struct.pack(">e", value)
            if struct.unpack(">e", half)[0] == value:
                return b"\xf9" + half
        except (OverflowError, struct.error):
            pass
        single = struct.pack(">f", value)
        if struct.unpack(">f", single)[0] == value:
            return b"\xfa" + single
    return b"\xfb" + struct.pack(">d", value)


class CborError(Exception):
    """Failure decoding or shaping a CBOR payload."""


class TrailingBytesError(CborError):
    """A complete CBOR item decoded but unexpected bytes followed it."""


class RaggedVectorError(CborError):
    """A trailing raw-vector section was not a whole number of 4-byte floats."""


def to_cbor(value: object) -> bytes:
    """Serialize a Python value to CBOR bytes in default (schema-order) mode.

    The ``default`` hook fires for the :class:`F32` / :class:`F64` markers,
    giving each float field its shortest CBOR form; every other value
    follows cbor2's default (insertion-order maps, byte-string ``bytes``).
    """
    return cbor2.dumps(value, default=_default_hook)


def _default_hook(encoder: "cbor2.CBOREncoder", value: object) -> None:
    if isinstance(value, _FloatField):
        encoder.write(_shortest_float_bytes(float(value)))
        return
    raise TypeError(f"cannot CBOR-encode value of type {type(value).__name__}")


def from_cbor(data: bytes) -> object:
    """Decode a single CBOR item, requiring the whole buffer to be consumed.

    Trailing bytes after a complete item mean a malformed payload (a pure
    CBOR payload has no trailing section).
    """
    value, consumed = from_cbor_prefix(data)
    if consumed != len(data):
        raise TrailingBytesError(
            f"{len(data) - consumed} trailing bytes after CBOR payload"
        )
    return value


def from_cbor_prefix(data: bytes) -> tuple[object, int]:
    """Decode one CBOR item from the front of ``data``.

    Returns ``(value, consumed)`` so a caller can read a trailing raw
    section from ``data[consumed:]`` (used by vector-bearing payloads).

    Implementation note: cbor2's incremental ``CBORDecoder(fileobj)`` reader
    panics ("buffer size mismatch") on valid multi-item payloads in the 6.x
    Rust extension, so we don't use it. ``cbor2.loads`` (the one-shot
    in-memory path) is sound but silently ignores trailing bytes, giving no
    consumed count. We therefore measure the first item's byte length with a
    dependency-free scanner, then decode exactly that slice with ``loads``.
    """
    consumed = _cbor_item_end(data, 0)
    try:
        value = cbor2.loads(data[:consumed])
    except Exception as exc:  # cbor2 raises CBORDecodeError subclasses
        raise CborError(f"CBOR decode failed: {exc}") from exc
    return value, consumed


# Deepest CBOR nesting this SDK will walk. Brain's own payloads nest ~8 levels
# at their worst (an encode trace's stage artifacts); 128 leaves generous
# headroom while keeping a hostile payload from exhausting the Python stack.
# Matches the order of magnitude of ciborium's built-in recursion limit, so the
# three SDKs refuse the same inputs.
_MAX_NESTING_DEPTH = 128


def _cbor_item_end(data: bytes, start: int) -> int:
    """Return the offset one past the end of the CBOR item at ``start``.

    A structural scanner only — it walks lengths without materialising
    values, so it never allocates the decoded tree. It is NOT automatically
    immune to unbounded recursion, though: it runs *before* cbor2 sees the
    bytes, so cbor2's own nesting cap never gets a chance, and a payload of
    a few thousand nested arrays used to drive this into a ``RecursionError``
    — an exception outside this module's taxonomy, escaping callers that
    catch :class:`CborError`. That is CVE-2026-26209's shape, reintroduced
    one layer up. Hence the explicit depth bound below.

    Raises :class:`CborError` on a truncated, malformed, or over-nested item.
    """
    n = len(data)

    def need(i: int, k: int) -> None:
        if i + k > n:
            raise CborError(
                f"truncated CBOR: need {k} byte(s) at offset {i}, have {n - i}"
            )

    def scan(i: int, depth: int = 0) -> int:
        if depth > _MAX_NESTING_DEPTH:
            raise CborError(
                f"CBOR nesting deeper than {_MAX_NESTING_DEPTH} at offset {i}"
            )
        need(i, 1)
        ib = data[i]
        i += 1
        major = ib >> 5
        ai = ib & 0x1F

        # Resolve the argument (length / value) for additional-info codes.
        if ai < 24:
            arg = ai
        elif ai == 24:
            need(i, 1)
            arg = data[i]
            i += 1
        elif ai == 25:
            need(i, 2)
            arg = int.from_bytes(data[i : i + 2], "big")
            i += 2
        elif ai == 26:
            need(i, 4)
            arg = int.from_bytes(data[i : i + 4], "big")
            i += 4
        elif ai == 27:
            need(i, 8)
            arg = int.from_bytes(data[i : i + 8], "big")
            i += 8
        elif ai == 31:
            arg = None  # indefinite length
        else:
            raise CborError(f"reserved additional-info {ai} at offset {i - 1}")

        if major in (0, 1):  # unsigned / negative integer
            return i
        if major == 7:  # simple value / float / break
            # ai 25/26/27 already consumed the 2/4/8 float bytes via `arg`.
            return i
        if major in (2, 3):  # byte string / text string
            if arg is None:  # indefinite: concatenated definite chunks until break
                while True:
                    need(i, 1)
                    if data[i] == 0xFF:
                        return i + 1
                    i = scan(i, depth + 1)
            need(i, arg)
            return i + arg
        if major == 4:  # array
            if arg is None:
                while True:
                    need(i, 1)
                    if data[i] == 0xFF:
                        return i + 1
                    i = scan(i, depth + 1)
            for _ in range(arg):
                i = scan(i, depth + 1)
            return i
        if major == 5:  # map
            if arg is None:
                while True:
                    need(i, 1)
                    if data[i] == 0xFF:
                        return i + 1
                    i = scan(i, depth + 1)  # key
                    i = scan(i, depth + 1)  # value
            for _ in range(arg):
                i = scan(i, depth + 1)  # key
                i = scan(i, depth + 1)  # value
            return i
        if major == 6:  # tag — one nested data item follows
            return scan(i, depth + 1)
        raise CborError(f"unreachable major type {major}")

    return scan(start)


def round_f32(x: float) -> F32:
    """Round a float through 32-bit precision and tag it as an f32 field.

    The 32-bit round makes the value exactly representable as a single,
    and the :class:`F32` tag routes it to the shortest half/single
    encoding, matching how the server serializes ``f32`` fields.
    """
    return F32(struct.unpack("<f", struct.pack("<f", x))[0])


def mark_f64(x: float) -> F64:
    """Tag a float as an f64 field for shortest full-precision encoding.

    No precision round: the value keeps full 64-bit precision and the
    :class:`F64` tag routes it to the shortest faithful CBOR form (half,
    single, or double), matching how the server serializes ``f64`` fields.
    """
    return F64(float(x))


def f32_list_to_le_bytes(values: list[float]) -> bytes:
    """Pack an ``f32`` sequence into a contiguous little-endian byte block."""
    return struct.pack(f"<{len(values)}f", *values)


def le_bytes_to_f32_list(data: bytes) -> list[float]:
    """Read a little-endian ``f32`` vector from a raw trailing section.

    The byte length must be a whole number of 4-byte floats.
    """
    if len(data) % 4 != 0:
        raise RaggedVectorError(
            f"vector section is {len(data)} bytes, not a multiple of 4"
        )
    count = len(data) // 4
    return list(struct.unpack(f"<{count}f", data))
