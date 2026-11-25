"""Seeded randomness, the same algorithm as the common runtime's `SeededRng`
(docs/testbed/external-core-protocol.md §9).

The seed string (UTF-8) is hashed with sha256; its first 16 bytes, read as
four little-endian uint32 (a, b, c, d), seed sfc32. `next()` is a float in
[0, 1) (`t / 2**32`); `int(lo, hi)` is `lo + floor(next() * (hi - lo + 1))`.
"""

from __future__ import annotations

import hashlib
import math
import struct

_MASK = 0xFFFFFFFF


class SeededRng:
    """sfc32 seeded from sha256(seed): the same sequence as Bun for the same seed."""

    def __init__(self, seed: str) -> None:
        self.seed = seed
        digest = hashlib.sha256(seed.encode("utf-8")).digest()
        self._a, self._b, self._c, self._d = struct.unpack("<4I", digest[:16])

    def next(self) -> float:
        """A float in [0, 1)."""
        a, b, c, d = self._a, self._b, self._c, self._d
        t = (((a + b) & _MASK) + d) & _MASK
        d = (d + 1) & _MASK
        a = b ^ (b >> 9)
        b = (c + (c << 3)) & _MASK
        c = ((c << 21) | (c >> 11)) & _MASK
        c = (c + t) & _MASK
        self._a, self._b, self._c, self._d = a, b, c, d
        return t / 4_294_967_296

    def int(self, lo: int, hi: int) -> int:
        """An integer in [lo, hi], both inclusive."""
        return lo + math.floor(self.next() * (hi - lo + 1))
