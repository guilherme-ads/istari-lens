import asyncio

import pytest
from fastapi import HTTPException

from app.modules.query_execution.adapters.postgres import PostgresQueryRunnerAdapter
from app.modules.query_execution.domain.models import CompiledQuery, QueryExecutionContext


class _FakeResult:
    def __init__(self, rows: list[tuple], columns: list[str]) -> None:
        self._rows = rows
        self.description = [(column,) for column in columns]

    async def fetchall(self) -> list[tuple]:
        return self._rows


class _FakeConn:
    async def execute(self, _sql: str, _params: list[object]) -> _FakeResult:
        return _FakeResult(rows=[(42,)], columns=["m0"])

    async def close(self) -> None:
        return None


def test_runner_executes_read_only_query() -> None:
    async def _run() -> None:
        async def _fake_conn_factory() -> _FakeConn:
            return _FakeConn()

        adapter = PostgresQueryRunnerAdapter(analytics_connection_factory=_fake_conn_factory)
        result = await adapter.run(
            compiled=CompiledQuery(sql="SELECT 42 AS m0 LIMIT 1", params=[], row_limit=1),
            datasource=None,
            context=QueryExecutionContext(operation="test"),
            timeout_seconds=3,
        )
        assert result.columns == ["m0"]
        assert result.rows == [{"m0": 42}]
        assert result.row_count == 1

    asyncio.run(_run())


def test_runner_blocks_non_select_query() -> None:
    async def _run() -> None:
        async def _fake_conn_factory() -> _FakeConn:
            return _FakeConn()

        adapter = PostgresQueryRunnerAdapter(analytics_connection_factory=_fake_conn_factory)
        with pytest.raises(HTTPException) as exc_info:
            await adapter.run(
                compiled=CompiledQuery(sql="DELETE FROM users", params=[], row_limit=1),
                datasource=None,
                context=QueryExecutionContext(operation="test"),
                timeout_seconds=3,
            )
        assert exc_info.value.status_code == 400

    asyncio.run(_run())
