from __future__ import annotations

from typing import Protocol


class DatasourceAdapter(Protocol):
    async def execute(self, *, sql: str, params: list[object], timeout_seconds: int) -> tuple[list[str], list[dict[str, object]]]: ...

    async def list_resources(self) -> list[dict[str, str]]: ...

    async def get_schema(self, *, schema_name: str, resource_name: str) -> list[dict[str, object]]: ...
