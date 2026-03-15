from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.modules.widgets.domain.widget_config_formula import extract_formula_metric_refs, is_valid_formula_identifier
from app.modules.widgets.domain.widget_config_types import (
    DreRowImpact,
    DreRowType,
    FilterOp,
    KpiType,
    MetricOp,
    OrderDirection,
    TableColumnAggregation,
    TextAlign,
    TimeGranularity,
    WidgetType,
)


class MetricConfig(BaseModel):
    op: MetricOp
    column: str | None = None
    alias: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    line_style: Literal["solid", "dashed", "dotted"] = "solid"
    line_y_axis: Literal["left", "right"] = "left"


class KpiDependencyRefConfig(BaseModel):
    source_type: Literal["widget", "column"] = "widget"
    widget_id: int | str | None = None
    column: str | None = None
    agg: MetricOp | None = None
    alias: str

    @model_validator(mode="after")
    def validate_source(self) -> "KpiDependencyRefConfig":
        if self.source_type == "widget":
            if self.widget_id is None:
                raise ValueError("KPI dependency widget_id is required for widget source")
            if isinstance(self.widget_id, str):
                normalized_widget_id = self.widget_id.strip()
                if not normalized_widget_id:
                    raise ValueError("KPI dependency widget_id is required for widget source")
                if normalized_widget_id.isdigit():
                    numeric_widget_id = int(normalized_widget_id)
                    if numeric_widget_id <= 0:
                        raise ValueError("KPI dependency widget_id is required for widget source")
                    self.widget_id = numeric_widget_id
                elif not normalized_widget_id.startswith("tmp-"):
                    raise ValueError("KPI dependency widget_id is invalid for widget source")
                else:
                    self.widget_id = normalized_widget_id
            elif self.widget_id <= 0:
                raise ValueError("KPI dependency widget_id is required for widget source")
            if self.column is not None or self.agg is not None:
                raise ValueError("Widget source dependency does not support column/agg")
            return self
        if not self.column:
            raise ValueError("KPI dependency column is required for column source")
        if self.agg is not None:
            raise ValueError("Column source dependency does not support agg; use formula functions")
        if self.widget_id is not None:
            raise ValueError("Column source dependency does not support widget_id")
        return self


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
    width: Literal[1, 2, 3, 4, 5, 6] = 1
    height: Literal[0.5, 1, 2] = 1


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
    impact: DreRowImpact = "add"
    metrics: list[MetricConfig] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def adapt_legacy_metric(cls, values: Any) -> Any:
        if not isinstance(values, dict):
            return values
        next_values = dict(values)
        if "metrics" not in next_values and "metric" in next_values:
            next_values["metrics"] = [next_values["metric"]]
        if "impact" not in next_values:
            next_values["impact"] = "subtract" if next_values.get("row_type") == "deduction" else "add"
        return next_values

    @model_validator(mode="after")
    def validate_metrics(self) -> "DreRowConfig":
        if len(self.metrics) < 1:
            raise ValueError("DRE row requires at least one metric")
        return self


class TableColumnInstanceConfig(BaseModel):
    id: str
    source: str
    label: str | None = None
    aggregation: TableColumnAggregation = "none"
    format: str | None = None
    prefix: str | None = None
    suffix: str | None = None


class WidgetConfig(BaseModel):
    widget_type: WidgetType
    view_name: str
    show_title: bool = True
    kpi_show_as: Literal["currency_brl", "number_2", "integer", "percent"] = "number_2"
    kpi_abbreviation_mode: Literal["auto", "always"] = "always"
    kpi_decimals: int = 2
    kpi_prefix: str | None = None
    kpi_suffix: str | None = None
    kpi_show_trend: bool = False
    kpi_type: KpiType = "atomic"
    formula: str | None = None
    dependencies: list[str] = Field(default_factory=list)
    kpi_dependencies: list[KpiDependencyRefConfig] = Field(default_factory=list)
    composite_metric: CompositeMetricConfig | None = None
    size: WidgetSizeConfig = Field(default_factory=WidgetSizeConfig)
    text_style: TextStyleConfig | None = None
    visual_padding: Literal["compact", "normal", "comfortable"] = "normal"
    visual_palette: Literal["default", "warm", "cool", "mono", "vivid"] = "default"
    metrics: list[MetricConfig] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    time: TimeConfig | None = None
    line_data_labels_enabled: bool = False
    line_show_grid: bool = True
    bar_data_labels_enabled: bool = True
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
    table_column_instances: list[TableColumnInstanceConfig] = Field(default_factory=list)
    table_column_labels: dict[str, str] = Field(default_factory=dict)
    table_column_aggs: dict[str, TableColumnAggregation] = Field(default_factory=dict)
    table_column_formats: dict[str, str] = Field(default_factory=dict)
    table_column_prefixes: dict[str, str] = Field(default_factory=dict)
    table_column_suffixes: dict[str, str] = Field(default_factory=dict)
    table_page_size: int = 25
    table_density: Literal["compact", "normal", "comfortable"] = "normal"
    table_zebra_rows: bool = True
    table_sticky_header: bool = True
    table_borders: bool = True
    table_default_text_align: TextAlign = "left"
    table_default_number_align: TextAlign = "right"
    filters: list[FilterConfig] = Field(default_factory=list)
    order_by: list[OrderByConfig] = Field(default_factory=list)
    top_n: int | None = None
    limit: int | None = None
    offset: int | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> "WidgetConfig":
        if self.widget_type != "table" and self.limit is not None:
            raise ValueError("Only table widget supports limit")
        if self.widget_type == "kpi":
            if not 0 <= int(self.kpi_decimals) <= 8:
                raise ValueError("KPI widget kpi_decimals must be between 0 and 8")
            if self.kpi_type == "derived":
                if self.composite_metric is not None:
                    raise ValueError("Derived KPI does not support composite_metric in MVP")
                if self.metrics:
                    raise ValueError("Derived KPI does not support inline metrics; use kpi_dependencies")
                if len(self.kpi_dependencies) < 1:
                    raise ValueError("Derived KPI requires at least one KPI dependency")
                if not (self.formula or "").strip():
                    raise ValueError("Derived KPI requires formula")
                refs = extract_formula_metric_refs(self.formula or "")
                if not refs:
                    raise ValueError("Derived KPI formula must reference at least one KPI dependency alias")
                valid_refs = set()
                seen_aliases: set[str] = set()
                for dep in self.kpi_dependencies:
                    alias = dep.alias.strip()
                    if not alias:
                        raise ValueError("Derived KPI dependency alias is required")
                    if not is_valid_formula_identifier(alias):
                        raise ValueError(f"Derived KPI dependency alias '{alias}' is invalid")
                    if alias in seen_aliases:
                        raise ValueError(f"Derived KPI dependency alias '{alias}' is duplicated")
                    seen_aliases.add(alias)
                    valid_refs.add(alias)
                invalid_refs = sorted(ref for ref in refs if ref not in valid_refs)
                if invalid_refs:
                    raise ValueError(f"Derived KPI formula references unknown dependencies: {', '.join(invalid_refs)}")
                if self.dependencies:
                    invalid_dependencies = sorted(dep for dep in self.dependencies if dep not in valid_refs)
                    if invalid_dependencies:
                        raise ValueError(f"Derived KPI dependencies are invalid: {', '.join(invalid_dependencies)}")
                    if set(self.dependencies) != refs:
                        raise ValueError("Derived KPI dependencies must match formula references")
                self.dependencies = sorted(refs)
            else:
                if self.formula is not None and self.formula.strip():
                    raise ValueError("Atomic KPI does not support formula")
                if self.dependencies:
                    raise ValueError("Atomic KPI does not support dependencies")
                if self.kpi_dependencies:
                    raise ValueError("Atomic KPI does not support kpi_dependencies")
            if self.kpi_type != "derived" and self.composite_metric is None and len(self.metrics) != 1:
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
            if len(self.dimensions) > 1:
                raise ValueError("Line widget supports at most one series dimension")
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
