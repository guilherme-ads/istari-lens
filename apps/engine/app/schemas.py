from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

MetricAgg = Literal["count", "sum", "avg", "min", "max", "distinct_count"]
FilterOp = Literal["eq", "neq", "gt", "lt", "gte", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"]
SortDirection = Literal["asc", "desc"]
WidgetType = Literal["kpi", "line", "bar", "column", "donut", "table", "text", "dre"]
TimeGranularity = Literal["day", "week", "month", "hour"]


class FilterSpec(BaseModel):
    field: str
    op: FilterOp
    value: Any | None = None


class MetricSpec(BaseModel):
    field: str | None = None
    agg: MetricAgg
    filters: list[FilterSpec] = Field(default_factory=list)


class SortSpec(BaseModel):
    field: str
    dir: SortDirection


class OrderBySpec(BaseModel):
    column: str | None = None
    metric_ref: str | None = None
    direction: SortDirection = "desc"


class TimeSpec(BaseModel):
    column: str
    granularity: TimeGranularity


class TimeRangeSpec(BaseModel):
    start: Any | None = None
    end: Any | None = None


class CompositeMetricSpec(BaseModel):
    inner_agg: MetricAgg
    outer_agg: MetricAgg
    value_column: str | None = None
    time_column: str
    granularity: TimeGranularity = "day"


class DreRowSpec(BaseModel):
    title: str
    row_type: str
    metrics: list[MetricSpec] = Field(default_factory=list)


class QuerySpec(BaseModel):
    resource_id: str
    widget_type: WidgetType = "table"
    metrics: list[MetricSpec] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[FilterSpec] = Field(default_factory=list)
    sort: list[SortSpec] = Field(default_factory=list)
    order_by: list[OrderBySpec] = Field(default_factory=list)
    columns: list[str] | None = None
    top_n: int | None = None
    limit: int = 500
    offset: int = 0
    time: TimeSpec | None = None
    time_range: TimeRangeSpec | None = None
    timezone: str | None = None
    composite_metric: CompositeMetricSpec | None = None
    dre_rows: list[DreRowSpec] = Field(default_factory=list)


class QueryExecuteRequest(BaseModel):
    datasource_id: int
    dataset_id: int | None = None
    workspace_id: int
    actor_user_id: int | None = None
    spec: QuerySpec


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    execution_time_ms: int
    sql_hash: str
    cache_hit: bool = False
    deduped: bool = False


class BatchQueryItem(BaseModel):
    request_id: str | None = None
    spec: QuerySpec


class BatchQueryRequest(BaseModel):
    datasource_id: int
    dataset_id: int | None = None
    workspace_id: int
    actor_user_id: int | None = None
    queries: list[BatchQueryItem] = Field(default_factory=list)


class BatchQueryResultItem(BaseModel):
    request_id: str | None = None
    result: QueryResult


class BatchQueryResponse(BaseModel):
    results: list[BatchQueryResultItem] = Field(default_factory=list)
    batch_size: int = 0
    deduped_count: int = 0
    executed_count: int = 0
    cache_hit_count: int = 0


class ResourceItem(BaseModel):
    id: str
    schema_name: str
    resource_name: str
    resource_type: str


class ResourceList(BaseModel):
    items: list[ResourceItem] = Field(default_factory=list)


class SchemaField(BaseModel):
    name: str
    data_type: str
    nullable: bool


class SchemaDefinition(BaseModel):
    resource_id: str
    fields: list[SchemaField] = Field(default_factory=list)
