from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any


class BoundedTTLCache:
    """Small async-safe LRU cache with TTL metadata.

    The existing OpenWeather ``TTLCache`` is left untouched; map grids have
    different TTLs per data family and need a bounded entry count.
    """

    def __init__(self, max_entries: int = 128):
        self.max_entries = max_entries
        self._values: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get_entry(self, key: str) -> tuple[Any, float] | None:
        async with self._lock:
            item = self._values.get(key)
            if item is None:
                return None
            self._values.move_to_end(key)
            return item[1], max(0.0, time.monotonic() - item[0])

    async def set(self, key: str, value: Any) -> None:
        async with self._lock:
            self._values[key] = (time.monotonic(), value)
            self._values.move_to_end(key)
            while len(self._values) > self.max_entries:
                self._values.popitem(last=False)

    async def clear(self) -> None:
        async with self._lock:
            self._values.clear()
