from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class DatasourceRegistryEntry:
    datasource_url: str
    workspace_id: int
    dataset_id: int | None
    updated_at: datetime


class DatasourceRegistry:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl_seconds = ttl_seconds
        self._lock = asyncio.Lock()
        self._items: dict[int, DatasourceRegistryEntry] = {}

    async def set(
        self,
        *,
        datasource_id: int,
        datasource_url: str,
        workspace_id: int,
        dataset_id: int | None,
    ) -> None:
        async with self._lock:
            self._items[datasource_id] = DatasourceRegistryEntry(
                datasource_url=datasource_url,
                workspace_id=workspace_id,
                dataset_id=dataset_id,
                updated_at=_utcnow(),
            )

    async def get(self, datasource_id: int) -> DatasourceRegistryEntry | None:
        async with self._lock:
            item = self._items.get(datasource_id)
            if item is None:
                return None
            if item.updated_at + timedelta(seconds=self._ttl_seconds) <= _utcnow():
                self._items.pop(datasource_id, None)
                return None
            return item
