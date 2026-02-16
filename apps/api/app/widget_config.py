from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

WidgetType = Literal["kpi", "line", "bar", "column", "donut", "table", "text", "dre"]
MetricOp = Literal["count", "sum", "avg", "min", "max", "distinct_count"]
TimeGranularity = Literal["day", "week", "month", "hour"]
TemporalDimensionGranularity = Literal["month", "week", "weekday", "hour"]
DreRowType = Literal["result", "deduction", "detail"]
OrderDirection = Literal["asc", "desc"]
TextAlign = Literal["left", "center", "right"]
FilterOp = Literal[
    "eq",
    "neq",
    "gt",
    "lt",
    "gte",
    "lte",
    "in",
    "not_in",
    "contains",
    "is_null",
    "not_null",
    "between",
]

TEMPORAL_DIMENSION_PREFIXES: dict[str, TemporalDimensionGranularity] = {
    "__time_month__": "month",
    "__time_week__": "week",
    "__time_weekday__": "weekday",
    "__time_hour__": "hour",
}


def parse_temporal_dimension(value: str) -> tuple[TemporalDimensionGranularity, str] | None:
    for prefix, granularity in TEMPORAL_DIMENSION_PREFIXES.items():
        token = f"{prefix}:"
        if value.startswith(token):
            column = value[len(token) :].strip()
            if column:
                return granularity, column
    return None


def normalize_column_type(raw_type: str) -> str:
    value = (raw_type or "").lower()
    if any(token in value for token in ["int", "numeric", "decimal", "real", "double", "float", "money"]):
        return "numeric"
    if any(token in value for token in ["date", "time", "timestamp"]):
        return "temporal"
    if "bool" in value:
        return "boolean"
    return "text"


def is_numeric_type(raw_type: str) -> bool:
    return normalize_column_type(raw_type) == "numeric"


def is_temporal_type(raw_type: str) -> bool:
    return normalize_column_type(raw_type) == "temporal"


def is_categorical_type(raw_type: str) -> bool:
    return normalize_column_type(raw_type) in {"text", "boolean"}


class MetricConfig(BaseModel):
    op: MetricOp
    column: str | None = None
    line_y_axis: Literal["left", "right"] = "left"


class TimeConfig(BaseModel):
    column: str
    granularity: TimeGranularity


class FilterConfig(BaseModel):
    column: str
    op: FilterOp
    value: Any | None = None


class OrderByConfig(BaseModel):
    column: str | None = None
    metric_ref: str | None = None
    direction: OrderDirection = "desc"

    @model_validator(mode="after")
    def validate_ref(self) -> "OrderByConfig":
        if bool(self.column) == bool(self.metric_ref):
            raise ValueError("Use either 'column' or 'metric_ref' in order_by")
        return self


class WidgetSizeConfig(BaseModel):
    width: Literal[1, 2, 3, 4] = 1
    height: Literal[0.5, 1] = 1


class TextStyleConfig(BaseModel):
    content: str = ""
    font_size: int = 18
    align: TextAlign = "left"


class CompositeMetricConfig(BaseModel):
    type: Literal["avg_per_time_bucket", "agg_over_time_bucket"] = "agg_over_time_bucket"
    inner_agg: MetricOp = "sum"
    outer_agg: MetricOp = "avg"
    value_column: str | None = None
    time_column: str
    granularity: TimeGranularity = "day"

    @model_validator(mode="before")
    @classmethod
    def adapt_legacy_shape(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        next_values = dict(values)
        if "inner_agg" not in next_values and "agg" in next_values:
            next_values["inner_agg"] = next_values.get("agg")
        if "outer_agg" not in next_values:
            next_values["outer_agg"] = "avg"
        if "type" not in next_values:
            next_values["type"] = "agg_over_time_bucket"
        return next_values


class DreRowConfig(BaseModel):
    title: str
    row_type: DreRowType
    metrics: list[MetricConfig] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def adapt_legacy_metric(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        next_values = dict(values)
        if "metrics" not in next_values and "metric" in next_values:
            next_values["metrics"] = [next_values["metric"]]
        return next_values

    @model_validator(mode="after")
    def validate_metrics(self) -> "DreRowConfig":
        if len(self.metrics) < 1:
            raise ValueError("DRE row requires at least one metric")
        return self


class WidgetConfig(BaseModel):
    widget_type: WidgetType
    view_name: str
    show_title: bool = True
    kpi_show_as: Literal["currency_brl", "number_2", "integer"] = "number_2"
    composite_metric: CompositeMetricConfig | None = None
    size: WidgetSizeConfig = Field(default_factory=WidgetSizeConfig)
    text_style: TextStyleConfig | None = None
    metrics: list[MetricConfig] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    time: TimeConfig | None = None
    line_data_labels_enabled: bool = False
    line_data_labels_percent: int = 60
    line_label_window: Literal[3, 5, 7] = 3
    line_label_min_gap: int = 2
    line_label_mode: Literal["peak", "valley", "both"] = "both"
    donut_show_legend: bool = True
    donut_data_labels_enabled: bool = False
    donut_data_labels_min_percent: int = 6
    donut_metric_display: Literal["value", "percent"] = "value"
    dre_rows: list[DreRowConfig] = Field(default_factory=list)
    dre_percent_base_row_index: int | None = None
    columns: list[str] | None = None
    table_column_formats: dict[str, str] = Field(default_factory=dict)
    table_page_size: int = 25
    filters: list[FilterConfig] = Field(default_factory=list)
    order_by: list[OrderByConfig] = Field(default_factory=list)
    top_n: int | None = None
    limit: int | None = None
    offset: int | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> "WidgetConfig":
        if self.widget_type == "kpi":
            if self.composite_metric is None and len(self.metrics) != 1:
                raise ValueError("KPI widget requires exactly one metric when composite_metric is not set")
            if self.composite_metric is not None and self.metrics:
                raise ValueError("KPI widget with composite_metric does not support metrics")
            if self.time is not None:
                raise ValueError("KPI widget does not support time")
            if self.columns:
                raise ValueError("KPI widget does not support columns")
            if self.order_by:
                raise ValueError("KPI widget does not support order_by")
        elif self.widget_type == "line":
            if self.time is None:
                raise ValueError("Line widget requires time configuration")
            if len(self.metrics) < 1:
                raise ValueError("Line widget requires at least one metric")
            if len(self.metrics) > 2:
                raise ValueError("Line widget supports at most two metrics")
            if self.dimensions:
                raise ValueError("Line widget does not support dimensions")
            if not 25 <= int(self.line_data_labels_percent) <= 100:
                raise ValueError("Line widget line_data_labels_percent must be between 25 and 100")
            if self.line_label_min_gap < 1:
                raise ValueError("Line widget line_label_min_gap must be at least 1")
        elif self.widget_type in {"bar", "column", "donut"}:
            if len(self.dimensions) != 1:
                raise ValueError("Categorical widget requires exactly one dimension")
            if len(self.metrics) != 1:
                raise ValueError("Categorical widget requires exactly one metric")
            if self.time is not None:
                raise ValueError("Categorical widget does not support time")
            if self.top_n is not None and self.top_n <= 0:
                raise ValueError("Categorical widget top_n must be greater than zero")
        elif self.widget_type == "table":
            if not self.columns:
                raise ValueError("Table widget requires at least one selected column")
            if self.metrics:
                raise ValueError("Table widget does not support metrics")
            if self.time is not None:
                raise ValueError("Table widget does not support time")
            if self.top_n is not None:
                raise ValueError("Table widget does not support top_n")
        elif self.widget_type == "text":
            if self.metrics:
                raise ValueError("Text widget does not support metrics")
            if self.dimensions:
                raise ValueError("Text widget does not support dimensions")
            if self.columns:
                raise ValueError("Text widget does not support columns")
            if self.time is not None:
                raise ValueError("Text widget does not support time")
            if self.filters:
                raise ValueError("Text widget does not support filters")
            if self.order_by:
                raise ValueError("Text widget does not support order_by")
            if self.text_style is None:
                raise ValueError("Text widget requires text_style")
            if self.top_n is not None:
                raise ValueError("Text widget does not support top_n")
        elif self.widget_type == "dre":
            if not self.dre_rows:
                raise ValueError("DRE widget requires at least one row")
            if not any(row.row_type == "result" for row in self.dre_rows):
                raise ValueError("DRE widget requires at least one level 1 row")
            if self.metrics:
                raise ValueError("DRE widget does not support top-level metrics")
            if self.dimensions:
                raise ValueError("DRE widget does not support dimensions")
            if self.time is not None:
                raise ValueError("DRE widget does not support time")
            if self.columns:
                raise ValueError("DRE widget does not support columns")
            if self.order_by:
                raise ValueError("DRE widget does not support order_by")
            if self.top_n is not None:
                raise ValueError("DRE widget does not support top_n")
            if self.dre_percent_base_row_index is not None:
                if self.dre_percent_base_row_index < 0 or self.dre_percent_base_row_index >= len(self.dre_rows):
                    raise ValueError("DRE widget dre_percent_base_row_index is out of bounds")
                if self.dre_rows[self.dre_percent_base_row_index].row_type != "result":
                    raise ValueError("DRE widget dre_percent_base_row_index must reference a level 1 row")
        if not 1 <= int(self.donut_data_labels_min_percent) <= 100:
            raise ValueError("donut_data_labels_min_percent must be between 1 and 100")
        return self


@dataclass
class WidgetConfigValidationError(Exception):
    field_errors: dict[str, list[str]]

    def to_detail(self) -> dict[str, Any]:
        return {
            "message": "Widget config validation failed",
            "field_errors": self.field_errors,
        }


def _add_error(errors: dict[str, list[str]], key: str, message: str) -> None:
    errors.setdefault(key, []).append(message)


def validate_widget_config_against_columns(
    config: WidgetConfig,
    column_types: dict[str, str],
) -> None:
    errors: dict[str, list[str]] = {}

    if config.widget_type == "text":
        if not config.text_style or not config.text_style.content.strip():
            _add_error(errors, "text_style.content", "Text widget content is required")
        if config.text_style and not (12 <= config.text_style.font_size <= 72):
            _add_error(errors, "text_style.font_size", "font_size must be between 12 and 72")
        if errors:
            raise WidgetConfigValidationError(errors)
        return

    if config.widget_type == "kpi" and config.composite_metric is not None:
        value_column = config.composite_metric.value_column
        if config.composite_metric.inner_agg == "count":
            if value_column:
                value_col_type = column_types.get(value_column)
                if not value_col_type:
                    _add_error(errors, "composite_metric.value_column", f"Column '{value_column}' does not exist in view")
        elif config.composite_metric.inner_agg == "distinct_count":
            if not value_column:
                _add_error(errors, "composite_metric.value_column", "Composite metric value_column is required for distinct_count agg")
            else:
                value_col_type = column_types.get(value_column)
                if not value_col_type:
                    _add_error(errors, "composite_metric.value_column", f"Column '{value_column}' does not exist in view")
        else:
            if not value_column:
                _add_error(errors, "composite_metric.value_column", "Composite metric value_column is required for non-count agg")
            else:
                value_col_type = column_types.get(value_column)
                if not value_col_type:
                    _add_error(errors, "composite_metric.value_column", f"Column '{value_column}' does not exist in view")
                elif not is_numeric_type(value_col_type):
                    _add_error(errors, "composite_metric.value_column", "Composite metric value_column must be numeric for non-count agg")

        time_col_type = column_types.get(config.composite_metric.time_column)
        if not time_col_type:
            _add_error(errors, "composite_metric.time_column", f"Column '{config.composite_metric.time_column}' does not exist in view")
        elif not is_temporal_type(time_col_type):
            _add_error(errors, "composite_metric.time_column", "Composite metric time_column must be temporal")

        if errors:
            raise WidgetConfigValidationError(errors)
        return

    def require_column_exists(column: str, field_key: str) -> str | None:
        col_type = column_types.get(column)
        if not col_type:
            _add_error(errors, field_key, f"Column '{column}' does not exist in view")
            return None
        return col_type

    for idx, metric in enumerate(config.metrics):
        key = f"metrics[{idx}]"
        if metric.op == "count":
            if metric.column:
                require_column_exists(metric.column, f"{key}.column")
            continue
        if metric.op == "distinct_count":
            if not metric.column:
                _add_error(errors, f"{key}.column", "Aggregation 'distinct_count' requires a column")
                continue
            require_column_exists(metric.column, f"{key}.column")
            continue
        if not metric.column:
            _add_error(errors, f"{key}.column", f"Aggregation '{metric.op}' requires a numeric column")
            continue
        col_type = require_column_exists(metric.column, f"{key}.column")
        if col_type and not is_numeric_type(col_type):
            _add_error(errors, f"{key}.column", f"Aggregation '{metric.op}' requires a numeric column")

    for idx, row in enumerate(config.dre_rows):
        if not row.title.strip():
            _add_error(errors, f"dre_rows[{idx}].title", "DRE row title is required")
        if not row.metrics:
            _add_error(errors, f"dre_rows[{idx}].metrics", "DRE row requires at least one metric")
            continue
        for metric_idx, metric in enumerate(row.metrics):
            key = f"dre_rows[{idx}].metrics[{metric_idx}]"
            if metric.op == "count":
                if metric.column:
                    require_column_exists(metric.column, f"{key}.column")
                continue
            if metric.op == "distinct_count":
                if not metric.column:
                    _add_error(errors, f"{key}.column", "Aggregation 'distinct_count' requires a column")
                    continue
                require_column_exists(metric.column, f"{key}.column")
                continue
            if not metric.column:
                _add_error(errors, f"{key}.column", f"Aggregation '{metric.op}' requires a numeric column")
                continue
            col_type = require_column_exists(metric.column, f"{key}.column")
            if col_type and not is_numeric_type(col_type):
                _add_error(errors, f"{key}.column", f"Aggregation '{metric.op}' requires a numeric column")

    if config.widget_type == "dre" and config.dre_percent_base_row_index is not None:
        if config.dre_percent_base_row_index < 0 or config.dre_percent_base_row_index >= len(config.dre_rows):
            _add_error(errors, "dre_percent_base_row_index", "Percent base must reference an existing DRE row")
        elif config.dre_rows[config.dre_percent_base_row_index].row_type != "result":
            _add_error(errors, "dre_percent_base_row_index", "Percent base must reference a level 1 row")
    if config.widget_type == "dre" and not any(row.row_type == "result" for row in config.dre_rows):
        _add_error(errors, "dre_rows", "DRE widget requires at least one level 1 row")

    for idx, dimension in enumerate(config.dimensions):
        temporal_dimension = parse_temporal_dimension(dimension)
        if temporal_dimension and config.widget_type in {"bar", "column"}:
            _, base_column = temporal_dimension
            col_type = require_column_exists(base_column, f"dimensions[{idx}]")
            if col_type and not is_temporal_type(col_type):
                _add_error(errors, f"dimensions[{idx}]", "Temporal derived dimension requires a temporal column")
            continue

        col_type = require_column_exists(dimension, f"dimensions[{idx}]")
        if config.widget_type in {"bar", "column", "donut"} and col_type and not is_categorical_type(col_type):
            _add_error(errors, f"dimensions[{idx}]", "Categorical dimension must be categorical")
        if config.widget_type == "line" and col_type and not is_categorical_type(col_type):
            _add_error(errors, f"dimensions[{idx}]", "Line series dimension must be categorical")

    if config.time:
        col_type = require_column_exists(config.time.column, "time.column")
        if col_type and not is_temporal_type(col_type):
            _add_error(errors, "time.column", "Time column must be temporal")

    if config.columns:
        for idx, column in enumerate(config.columns):
            require_column_exists(column, f"columns[{idx}]")

    for idx, filter_config in enumerate(config.filters):
        require_column_exists(filter_config.column, f"filters[{idx}].column")
        if filter_config.op in {"is_null", "not_null"}:
            continue
        if filter_config.value is None:
            _add_error(errors, f"filters[{idx}].value", "Filter value is required for this operator")

    metric_refs = {f"m{i}" for i in range(len(config.metrics))}
    for idx, order in enumerate(config.order_by):
        if order.column:
            if order.column not in config.dimensions:
                require_column_exists(order.column, f"order_by[{idx}].column")
        if order.metric_ref and order.metric_ref not in metric_refs:
            _add_error(errors, f"order_by[{idx}].metric_ref", f"Unknown metric_ref '{order.metric_ref}'")

    if config.widget_type == "table":
        if config.limit is not None and config.limit <= 0:
            _add_error(errors, "limit", "limit must be greater than zero")
        if config.offset is not None and config.offset < 0:
            _add_error(errors, "offset", "offset cannot be negative")
        if config.table_page_size <= 0:
            _add_error(errors, "table_page_size", "table_page_size must be greater than zero")
    if config.widget_type in {"bar", "column", "donut"} and config.top_n is not None and config.top_n <= 0:
        _add_error(errors, "top_n", "top_n must be greater than zero")

    if errors:
        raise WidgetConfigValidationError(errors)
