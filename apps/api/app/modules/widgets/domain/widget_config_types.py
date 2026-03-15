from __future__ import annotations

from typing import Literal

WidgetType = Literal["kpi", "line", "bar", "column", "donut", "table", "text", "dre"]
MetricOp = Literal["count", "sum", "avg", "min", "max", "distinct_count"]
TableColumnAggregation = Literal["none", "count", "sum", "avg", "min", "max", "distinct_count"]
KpiType = Literal["atomic", "derived"]
TimeGranularity = Literal["day", "week", "month", "hour", "timestamp"]
TemporalDimensionGranularity = Literal["day", "month", "week", "weekday", "hour"]
DreRowType = Literal["result", "deduction", "detail"]
DreRowImpact = Literal["add", "subtract"]
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
    "__time_day__": "day",
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
