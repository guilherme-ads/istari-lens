from __future__ import annotations

from app.modules.query_execution.domain.models import (
    CompositeMetric,
    InternalQuerySpec,
    QueryExecutionContext,
    QueryFilter,
    QueryMetric,
    QueryOrder,
    QueryTime,
    ResultSet,
)
from app.modules.query_execution.domain.ports import QueryCompilerPort, QueryRunnerPort
from app.modules.core.legacy.schemas import QuerySpec
from app.modules.widgets.domain.config import CompositeMetricConfig, FilterConfig, MetricConfig, OrderByConfig, WidgetConfig


class QueryBuilderService:
    def __init__(self, compiler: QueryCompilerPort) -> None:
        self._compiler = compiler

    def from_widget_config(self, config: WidgetConfig) -> InternalQuerySpec:
        return InternalQuerySpec(
            widget_type=config.widget_type,
            view_name=config.view_name,
            metrics=[QueryMetric(op=item.op, column=item.column) for item in config.metrics],
            dimensions=list(config.dimensions),
            filters=[QueryFilter(column=item.column, op=item.op, value=item.value) for item in config.filters],
            order_by=[QueryOrder(direction=item.direction, column=item.column, metric_ref=item.metric_ref) for item in config.order_by],
            time=(QueryTime(column=config.time.column, granularity=config.time.granularity) if config.time else None),
            columns=list(config.columns) if config.columns else None,
            top_n=config.top_n,
            limit=config.limit,
            offset=config.offset,
            composite_metric=(
                CompositeMetric(
                    inner_agg=config.composite_metric.inner_agg,
                    outer_agg=config.composite_metric.outer_agg,
                    value_column=config.composite_metric.value_column,
                    time_column=config.composite_metric.time_column,
                    granularity=config.composite_metric.granularity,
                )
                if config.composite_metric
                else None
            ),
        )

    def from_api_query_spec(self, spec: QuerySpec, view_name: str) -> InternalQuerySpec:
        filters: list[QueryFilter] = []
        for item in spec.filters:
            value = item.value
            if isinstance(value, list) and item.op in {"eq", "neq", "contains", "gte", "lte"}:
                value = value[0] if value else None
            filters.append(QueryFilter(column=item.field, op=item.op, value=value))

        return InternalQuerySpec(
            widget_type="table",
            view_name=view_name,
            metrics=[QueryMetric(op=item.agg, column=None if (item.agg == "count" and item.field == "*") else item.field) for item in spec.metrics],
            dimensions=list(spec.dimensions),
            filters=filters,
            order_by=[QueryOrder(direction=item.dir, column=item.field) for item in spec.sort],
            limit=spec.limit,
            offset=spec.offset,
        )

    def compile_widget(self, config: WidgetConfig) -> tuple[str, list[object]]:
        compiled = self._compiler.compile(self.from_widget_config(config))
        return compiled.sql, compiled.params

    def compile_query_spec(self, spec: QuerySpec, view_name: str) -> tuple[str, list[object]]:
        compiled = self._compiler.compile(self.from_api_query_spec(spec, view_name))
        return compiled.sql, compiled.params

    def compile_kpi_batch(
        self,
        view_name: str,
        metrics: list[MetricConfig],
        filters: list[FilterConfig],
        *,
        composite_metrics: list[CompositeMetricConfig] | None = None,
    ) -> tuple[str, list[object], list[str]]:
        compiled, aliases = self._compiler.compile_kpi_batch(
            view_name=view_name,
            metrics=metrics,
            filters=filters,
            composite_metrics=composite_metrics,
        )
        return compiled.sql, compiled.params, aliases


class QueryExecutionService:
    def __init__(self, compiler: QueryCompilerPort, runner: QueryRunnerPort) -> None:
        self._compiler = compiler
        self._runner = runner
        self.builder = QueryBuilderService(compiler)

    async def execute_widget(
        self,
        *,
        config: WidgetConfig,
        datasource: object | None,
        context: QueryExecutionContext,
        timeout_seconds: int,
    ) -> ResultSet:
        compiled = self._compiler.compile(self.builder.from_widget_config(config))
        return await self._runner.run(
            compiled=compiled,
            datasource=datasource,
            context=context,
            timeout_seconds=timeout_seconds,
        )

    async def execute_compiled(
        self,
        *,
        sql: str,
        params: list[object],
        datasource: object | None,
        context: QueryExecutionContext,
        timeout_seconds: int,
        row_limit: int,
    ) -> ResultSet:
        from app.modules.query_execution.domain.models import CompiledQuery

        return await self._runner.run(
            compiled=CompiledQuery(sql=sql, params=params, row_limit=row_limit),
            datasource=datasource,
            context=context,
            timeout_seconds=timeout_seconds,
        )


