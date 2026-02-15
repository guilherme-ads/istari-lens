from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

WidgetType = Literal["kpi", "line", "bar", "table", "text"]
MetricOp = Literal["count", "sum", "avg", "min", "max", "distinct_count"]
FilterOp = Literal["eq", "neq", "gt", "lt", "gte", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]
OrderDirection = Literal["asc", "desc"]
TimeGranularity = Literal["day", "week", "month"]


@dataclass(slots=True)
class QueryMetric:
    op: MetricOp
    column: str | None = None


@dataclass(slots=True)
class QueryTime:
    column: str
    granularity: TimeGranularity


@dataclass(slots=True)
class QueryFilter:
    column: str
    op: FilterOp
    value: Any | None = None


@dataclass(slots=True)
class QueryOrder:
    direction: OrderDirection = "desc"
    column: str | None = None
    metric_ref: str | None = None


@dataclass(slots=True)
class CompositeMetric:
    inner_agg: MetricOp
    outer_agg: MetricOp
    time_column: str
    value_column: str | None = None
    granularity: TimeGranularity = "day"


@dataclass(slots=True)
class InternalQuerySpec:
    widget_type: WidgetType
    view_name: str
    metrics: list[QueryMetric] = field(default_factory=list)
    dimensions: list[str] = field(default_factory=list)
    filters: list[QueryFilter] = field(default_factory=list)
    order_by: list[QueryOrder] = field(default_factory=list)
    time: QueryTime | None = None
    columns: list[str] | None = None
    top_n: int | None = None
    limit: int | None = None
    offset: int | None = None
    composite_metric: CompositeMetric | None = None


@dataclass(slots=True)
class CompiledQuery:
    sql: str
    params: list[Any]
    row_limit: int


@dataclass(slots=True)
class ResultSet:
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    execution_time_ms: int
    sql_hash: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class QueryExecutionContext:
    operation: str
    request_id: str | None = None
    user_id: int | None = None
    tenant_id: str | int | None = None
    dataset_id: int | None = None
    datasource_id: int | None = None

