from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.modules.widgets.domain.widget_config_models import WidgetConfig
from app.modules.widgets.domain.widget_config_types import (
    is_categorical_type,
    is_numeric_type,
    is_temporal_type,
    parse_temporal_dimension,
)


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
    if config.table_column_instances:
        for idx, item in enumerate(config.table_column_instances):
            col_type = require_column_exists(item.source, f"table_column_instances[{idx}].source")
            if item.aggregation in {"sum", "avg", "min", "max"} and col_type and not is_numeric_type(col_type):
                _add_error(
                    errors,
                    f"table_column_instances[{idx}].aggregation",
                    "Aggregation requires numeric source column",
                )

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

    if config.widget_type in {"bar", "column", "donut"}:
        if len(config.order_by) > 1:
            _add_error(errors, "order_by", "Categorical widget supports at most one order_by rule")
        if config.order_by:
            selected_dimension = config.dimensions[0] if config.dimensions else None
            first_order = config.order_by[0]
            if first_order.column and selected_dimension and first_order.column != selected_dimension:
                _add_error(
                    errors,
                    "order_by[0].column",
                    "Categorical widget order_by.column must match the selected dimension",
                )

    if config.widget_type == "table":
        if config.limit is not None and config.limit <= 0:
            _add_error(errors, "limit", "limit must be greater than zero")
        if config.offset is not None and config.offset < 0:
            _add_error(errors, "offset", "offset cannot be negative")
        if config.table_page_size <= 0:
            _add_error(errors, "table_page_size", "table_page_size must be greater than zero")
        for column_name, agg in (config.table_column_aggs or {}).items():
            col_type = require_column_exists(column_name, f"table_column_aggs.{column_name}")
            if agg in {"sum", "avg", "min", "max"} and col_type and not is_numeric_type(col_type):
                _add_error(errors, f"table_column_aggs.{column_name}", "Aggregation requires numeric column")
    if config.widget_type in {"bar", "column", "donut"} and config.top_n is not None and config.top_n <= 0:
        _add_error(errors, "top_n", "top_n must be greater than zero")

    if errors:
        raise WidgetConfigValidationError(errors)
