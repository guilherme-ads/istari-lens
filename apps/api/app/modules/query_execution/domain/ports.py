from __future__ import annotations

from typing import Any, Protocol

from app.modules.query_execution.domain.models import CompiledQuery, InternalQuerySpec, QueryExecutionContext, ResultSet


class QueryCompilerPort(Protocol):
    def compile(self, spec: InternalQuerySpec) -> CompiledQuery:
        raise NotImplementedError

    def compile_kpi_batch(
        self,
        *,
        view_name: str,
        metrics: list[Any],
        filters: list[Any],
        composite_metrics: list[Any] | None = None,
    ) -> tuple[CompiledQuery, list[str]]:
        raise NotImplementedError


class QueryRunnerPort(Protocol):
    async def run(
        self,
        *,
        compiled: CompiledQuery,
        datasource: Any | None,
        context: QueryExecutionContext,
        timeout_seconds: int,
    ) -> ResultSet:
        raise NotImplementedError

