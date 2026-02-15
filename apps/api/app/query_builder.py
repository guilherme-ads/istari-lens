from __future__ import annotations

from typing import Any

from app.modules.query_execution import PostgresQueryCompilerAdapter, QueryBuilderService
from app.widget_config import CompositeMetricConfig, FilterConfig, MetricConfig, WidgetConfig

_builder = QueryBuilderService(PostgresQueryCompilerAdapter())


def build_widget_query(config: WidgetConfig) -> tuple[str, list[Any]]:
    return _builder.compile_widget(config)


def build_kpi_batch_query(
    view_name: str,
    metrics: list[MetricConfig],
    filters: list[FilterConfig],
    *,
    composite_metrics: list[CompositeMetricConfig] | None = None,
) -> tuple[str, list[Any], list[str]]:
    return _builder.compile_kpi_batch(
        view_name=view_name,
        metrics=metrics,
        filters=filters,
        composite_metrics=composite_metrics,
    )

