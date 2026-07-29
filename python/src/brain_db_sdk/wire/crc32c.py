"""CRC32C (Castagnoli) — the checksum the BRN0 frame header uses.

Pure-Python so the codec has no native/network dependency for a core
function. The algorithm is the reflected Castagnoli CRC (polynomial
0x1EDC6F41, reflected to 0x82F63B78), the same variant hardware SSE4.2
``crc32`` and the server's ``crc32c`` crate compute. A 256-entry table is
built once at import.
"""

from __future__ import annotations

_POLY = 0x82F63B78  # reflected 0x1EDC6F41


def _build_table() -> list[int]:
    table = []
    for n in range(256):
        crc = n
        for _ in range(8):
            crc = (crc >> 1) ^ _POLY if crc & 1 else crc >> 1
        table.append(crc)
    return table


_TABLE = _build_table()


def crc32c(data: bytes) -> int:
    """CRC32C of ``data`` as an unsigned 32-bit integer."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc = (crc >> 8) ^ _TABLE[(crc ^ byte) & 0xFF]
    return crc ^ 0xFFFFFFFF


# Standard check vector pins the polynomial choice: CRC32C("123456789").
# Deliberately a raise, not an assert: `python -O` strips asserts, and this is
# the one line standing between a wrong table and every frame failing CRC on
# the server with no local symptom.
if crc32c(b"123456789") != 0xE3069283:  # pragma: no cover - import-time guard
    msg = "CRC32C check vector failed: the polynomial table is wrong"
    raise RuntimeError(msg)
