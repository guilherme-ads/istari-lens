from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.modules.widgets.domain.config import (
    CompositeMetricConfig,
    FilterConfig,
    MetricConfig,
    WidgetConfig,
    parse_temporal_dimension,
)


def _quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _qualified_name(name: str) -> str:
    parts = [part for part in name.split(".") if part]
    return ".".join(_quote_ident(part) for part in parts)


def _metric_sql(metric_op: str, column: str | None) -> str:
    if metric_op == "count":
        if column:
            return f"COUNT({_quote_ident(column)})"
        return "COUNT(*)"
    if metric_op == "distinct_count":
        if not column:
            raise ValueError("Metric 'distinct_count' requires a column")
        return f"COUNT(DISTINCT {_quote_ident(column)})"
    if not column:
        raise ValueError(f"Metric '{metric_op}' requires a column")
    return f"{metric_op.upper()}({_quote_ident(column)})"


def _dimension_sql(dimension: str) -> tuple[str, str]:
    temporal_dimension = parse_temporal_dimension(dimension)
    if temporal_dimension is None:
        dim_ident = _quote_ident(dimension)
        return dim_ident, dim_ident

    granularity, column = temporal_dimension
    alias = _quote_ident(dimension)
    col_ident = _quote_ident(column)

    if granularity == "month":
        expr = f"TO_CHAR(DATE_TRUNC('month', {col_ident}), 'YYYY-MM')"
    elif granularity == "week":
        expr = f"('S' || LPAD(EXTRACT(WEEK FROM {col_ident})::int::text, 2, '0'))"
    elif granularity == "weekday":
        expr = (
            f"CASE EXTRACT(ISODOW FROM {col_ident})::int "
            f"WHEN 1 THEN 'seg' WHEN 2 THEN 'ter' WHEN 3 THEN 'qua' "
            f"WHEN 4 THEN 'qui' WHEN 5 THEN 'sex' WHEN 6 THEN 'sab' WHEN 7 THEN 'dom' END"
        )
    elif granularity == "hour":
        expr = f"TO_CHAR(DATE_TRUNC('hour', {col_ident}), 'HH24:00')"
    else:
        expr = f"DATE_TRUNC('{granularity}', {col_ident})"

    return f"{expr} AS {alias}", alias


def _dimension_order_sql(dimension: str, direction: str) -> str | None:
    temporal_dimension = parse_temporal_dimension(dimension)
    if temporal_dimension is None:
        return None
    granularity, column = temporal_dimension
    col_ident = _quote_ident(column)
    if granularity == "weekday":
        return f"MIN(EXTRACT(ISODOW FROM {col_ident})) {direction}"
    if granularity == "week":
        return f"MIN(EXTRACT(WEEK FROM {col_ident})) {direction}"
    if granularity == "month":
        return f"MIN(DATE_TRUNC('month', {col_ident})) {direction}"
    if granularity == "hour":
        return f"MIN(EXTRACT(HOUR FROM {col_ident})) {direction}"
    return None


def _is_date_value(value: Any) -> bool:
    if isinstance(value, date) and not isinstance(value, datetime):
        return True
    if isinstance(value, str):
        try:
            datetime.strptime(value, "%Y-%m-%d")
            return True
        except ValueError:
            return False
    return False


def _is_date_filter_value(value: Any) -> bool:
    if isinstance(value, list):
        return len(value) > 0 and all(_is_date_value(item) for item in value)
    return _is_date_value(value)


def _date_param_expr() -> str:
    return "((%s::date)::timestamp at time zone 'America/Sao_Paulo')"


def _next_date_value(value: Any) -> Any:
    if isinstance(value, date) and not isinstance(value, datetime):
        return (value + timedelta(days=1))
    if isinstance(value, str):
        try:
            parsed = datetime.strptime(value, "%Y-%m-%d").date()
            return (parsed + timedelta(days=1)).isoformat()
        except ValueError:
            return value
    return value


def _resolve_relative_date_value(value: Any) -> tuple[str, Any] | None:
    if not isinstance(value, dict):
        return None
    preset = value.get("relative")
    if not isinstance(preset, str) or not preset:
        return None

    today = datetime.now(ZoneInfo("America/Sao_Paulo")).date()
    if preset == "today":
        day = today.isoformat()
        return "between", [day, day]
    if preset == "yesterday":
        day = (today - timedelta(days=1)).isoformat()
        return "between", [day, day]
    if preset == "last_7_days":
        return "between", [(today - timedelta(days=6)).isoformat(), today.isoformat()]
    if preset == "last_30_days":
        return "between", [(today - timedelta(days=29)).isoformat(), today.isoformat()]
    if preset == "this_month":
        first = today.replace(day=1).isoformat()
        return "between", [first, today.isoformat()]
    if preset == "this_year":
        first = today.replace(month=1, day=1).isoformat()
        return "between", [first, today.isoformat()]
    if preset == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return "between", [first_prev.isoformat(), last_prev.isoformat()]
    return None


def _apply_filter(filters: list[FilterConfig]) -> tuple[list[str], list[Any]]:
    where_parts: list[str] = []
    params: list[Any] = []

    for item in filters:
        column = _quote_ident(item.column)
        op = item.op
        value = item.value
        relative = _resolve_relative_date_value(value)
        if relative is not None:
            op, value = relative
        use_date_expr = _is_date_filter_value(value)

        if op == "eq":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} = {rhs}")
            params.append(value)
        elif op == "neq":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} <> {rhs}")
            params.append(value)
        elif op == "gt":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} > {rhs}")
            params.append(value)
        elif op == "lt":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} < {rhs}")
            params.append(value)
        elif op == "gte":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} >= {rhs}")
            params.append(value)
        elif op == "lte":
            rhs = _date_param_expr() if use_date_expr else "%s"
            where_parts.append(f"{column} <= {rhs}")
            params.append(_next_date_value(value) if use_date_expr else value)
        elif op == "contains":
            where_parts.append(f"{column}::text ILIKE %s")
            params.append(f"%{value}%")
        elif op == "in":
            values = value if isinstance(value, list) else [value]
            placeholder = _date_param_expr() if use_date_expr else "%s"
            placeholders = ", ".join([placeholder] * len(values))
            where_parts.append(f"{column} IN ({placeholders})")
            params.extend(values)
        elif op == "not_in":
            values = value if isinstance(value, list) else [value]
            placeholder = _date_param_expr() if use_date_expr else "%s"
            placeholders = ", ".join([placeholder] * len(values))
            where_parts.append(f"{column} NOT IN ({placeholders})")
            params.extend(values)
        elif op == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise ValueError("between filter requires [start, end]")
            if use_date_expr:
                where_parts.append(f"{column} BETWEEN {_date_param_expr()} AND {_date_param_expr()}")
                params.extend([value[0], _next_date_value(value[1])])
            else:
                where_parts.append(f"{column} BETWEEN %s AND %s")
                params.extend(value)
        elif op == "is_null":
            where_parts.append(f"{column} IS NULL")
        elif op == "not_null":
            where_parts.append(f"{column} IS NOT NULL")
        else:
            raise ValueError(f"Unsupported filter operator '{op}'")

    return where_parts, params


def build_widget_query(config: WidgetConfig) -> tuple[str, list[Any]]:
    if config.widget_type == "text":
        raise ValueError("Text widget does not generate SQL queries")
    if config.widget_type == "dre":
        if not config.dre_rows:
            raise ValueError("DRE widget requires at least one row")
        select_parts = []
        for index, row in enumerate(config.dre_rows):
            if not row.metrics:
                raise ValueError("DRE row requires at least one metric")
            row_expr_parts = [f"COALESCE({_metric_sql(metric.op, metric.column)}, 0)" for metric in row.metrics]
            row_expr = " + ".join(row_expr_parts)
            select_parts.append(f"({row_expr}) AS {_quote_ident(f'm{index}')}")
        query_parts = [
            f"SELECT {', '.join(select_parts)}",
            f"FROM {_qualified_name(config.view_name)}",
        ]
        where_parts, params = _apply_filter(config.filters)
        if where_parts:
            query_parts.append("WHERE " + " AND ".join(where_parts))
        query_parts.append("LIMIT 1")
        return " ".join(query_parts), params
    if config.widget_type == "kpi" and config.composite_metric is not None:
        where_parts, params = _apply_filter(config.filters)
        where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
        bucket = f"DATE_TRUNC('{config.composite_metric.granularity}', {_quote_ident(config.composite_metric.time_column)})"
        inner_metric = _metric_sql(config.composite_metric.inner_agg, config.composite_metric.value_column)
        outer_metric = _metric_sql(config.composite_metric.outer_agg, "bucket_value")
        sql = (
            f"SELECT {outer_metric} AS {_quote_ident('m0')} "
            f"FROM ("
            f"SELECT {bucket} AS {_quote_ident('time_bucket')}, {inner_metric} AS {_quote_ident('bucket_value')} "
            f"FROM {_qualified_name(config.view_name)}"
            f"{where_sql} "
            f"GROUP BY {_quote_ident('time_bucket')}"
            f") AS {_quote_ident('kpi_bucketed')}"
        )
        return sql, params

    select_parts: list[str] = []
    group_by_parts: list[str] = []
    params: list[Any] = []

    if config.widget_type == "table":
        for column in config.columns or []:
            select_parts.append(_quote_ident(column))
    else:
        if config.widget_type == "line" and config.time:
            if config.time.granularity == "hour":
                time_expr = (
                    f"TO_CHAR(DATE_TRUNC('hour', {_quote_ident(config.time.column)}), 'HH24:00') "
                    f"AS {_quote_ident('time_bucket')}"
                )
            else:
                time_expr = (
                    f"DATE_TRUNC('{config.time.granularity}', {_quote_ident(config.time.column)}) "
                    f"AS {_quote_ident('time_bucket')}"
                )
            select_parts.append(time_expr)
            group_by_parts.append(_quote_ident("time_bucket"))

        for dimension in config.dimensions:
            dim_select, dim_group = _dimension_sql(dimension)
            select_parts.append(dim_select)
            group_by_parts.append(dim_group)

        for index, metric in enumerate(config.metrics):
            alias = _quote_ident(f"m{index}")
            select_parts.append(f"{_metric_sql(metric.op, metric.column)} AS {alias}")

    query_parts = [
        f"SELECT {', '.join(select_parts)}",
        f"FROM {_qualified_name(config.view_name)}",
    ]

    where_parts, where_params = _apply_filter(config.filters)
    if where_parts:
        query_parts.append("WHERE " + " AND ".join(where_parts))
        params.extend(where_params)

    if group_by_parts:
        query_parts.append("GROUP BY " + ", ".join(group_by_parts))

    if config.order_by:
        order_parts: list[str] = []
        for item in config.order_by:
            direction = "ASC" if item.direction == "asc" else "DESC"
            if item.column:
                dimension_order = _dimension_order_sql(item.column, direction)
                if dimension_order:
                    order_parts.append(dimension_order)
                else:
                    order_parts.append(f"{_quote_ident(item.column)} {direction}")
            elif item.metric_ref:
                order_parts.append(f"{_quote_ident(item.metric_ref)} {direction}")
        query_parts.append("ORDER BY " + ", ".join(order_parts))
    elif config.widget_type == "line":
        query_parts.append(f"ORDER BY {_quote_ident('time_bucket')} ASC")
    elif config.widget_type in {"bar", "column"} and len(config.dimensions) == 1:
        dimension_order = _dimension_order_sql(config.dimensions[0], "ASC")
        if dimension_order:
            query_parts.append("ORDER BY " + dimension_order)

    effective_limit = config.limit
    if config.widget_type in {"bar", "column", "donut"} and config.top_n is not None:
        effective_limit = config.top_n
    if effective_limit is not None:
        safe_limit = max(1, effective_limit)
        query_parts.append(f"LIMIT {safe_limit}")

    if config.offset is not None:
        safe_offset = max(0, config.offset)
        query_parts.append(f"OFFSET {safe_offset}")

    return " ".join(query_parts), params


def build_kpi_batch_query(
    view_name: str,
    metrics: list[MetricConfig],
    filters: list[FilterConfig],
    *,
    composite_metrics: list[CompositeMetricConfig] | None = None,
) -> tuple[str, list[Any], list[str]]:
    if composite_metrics:
        select_parts: list[str] = []
        inner_select_parts: list[str] = []
        aliases: list[str] = []

        first = composite_metrics[0]
        bucket_expr = f"DATE_TRUNC('{first.granularity}', {_quote_ident(first.time_column)})"
        inner_select_parts.append(f"{bucket_expr} AS {_quote_ident('time_bucket')}")

        for index, composite_metric in enumerate(composite_metrics):
            alias = f"m{index}"
            aliases.append(alias)
            bucket_alias = f"bucket_{index}"
            inner_select_parts.append(
                f"{_metric_sql(composite_metric.inner_agg, composite_metric.value_column)} AS {_quote_ident(bucket_alias)}"
            )
            select_parts.append(f"{_metric_sql(composite_metric.outer_agg, bucket_alias)} AS {_quote_ident(alias)}")

        query_parts = [f"SELECT {', '.join(select_parts)}", "FROM (", f"SELECT {', '.join(inner_select_parts)}"]
        query_parts.append(f"FROM {_qualified_name(view_name)}")

        where_parts, params = _apply_filter(filters)
        if where_parts:
            query_parts.append("WHERE " + " AND ".join(where_parts))

        query_parts.append(f"GROUP BY {_quote_ident('time_bucket')}")
        query_parts.append(f") AS {_quote_ident('kpi_bucketed')}")
        return " ".join(query_parts), params, aliases

    if not metrics:
        raise ValueError("KPI batch query requires at least one metric")

    select_parts: list[str] = []
    aliases: list[str] = []
    for index, metric in enumerate(metrics):
        alias = f"m{index}"
        aliases.append(alias)
        select_parts.append(f"{_metric_sql(metric.op, metric.column)} AS {_quote_ident(alias)}")

    query_parts = [
        f"SELECT {', '.join(select_parts)}",
        f"FROM {_qualified_name(view_name)}",
    ]

    where_parts, params = _apply_filter(filters)
    if where_parts:
        query_parts.append("WHERE " + " AND ".join(where_parts))

    return " ".join(query_parts), params, aliases


