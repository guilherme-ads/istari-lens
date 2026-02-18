from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from time import monotonic

from app.errors import EngineError


class SlidingWindowRateLimiter:
    def __init__(self, max_requests_per_minute: int) -> None:
        self._limit = max_requests_per_minute
        self._buckets: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> None:
        now = monotonic()
        window_start = now - 60.0
        async with self._lock:
            bucket = self._buckets[key]
            while bucket and bucket[0] < window_start:
                bucket.popleft()
            if len(bucket) >= self._limit:
                raise EngineError(status_code=429, code="rate_limit_exceeded", message="Rate limit exceeded")
            bucket.append(now)
