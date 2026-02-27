from __future__ import annotations

import ast
import re
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.errors import EngineError
from app.schemas import QuerySpec

_TEMPORAL_DIMENSION_PREFIXES: dict[str, str] = {
    "__time_month__": "month",
    "__time_week__": "week",
    "__time_weekday__": "weekday",
    "__time_hour__": "hour",
}


def _quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _qualified_name(name: str) -> str:
    parts = [part for part in name.split(".") if part]
    return ".".join(_quote_ident(part) for part in parts)


def _metric_sql(metric_op: str, column: str | None) -> str:
    if metric_op == "count":
        if column and column != "*":
            return f"COUNT({_quote_ident(column)})"
        return "COUNT(*)"
    if metric_op == "distinct_count":
        if not column:
            raise EngineError(status_code=400, code="invalid_metric", message="Metric 'distinct_count' requires a column")
        return f"COUNT(DISTINCT {_quote_ident(column)})"
    if not column:
        raise EngineError(status_code=400, code="invalid_metric", message=f"Metric '{metric_op}' requires a column")
    return f"{metric_op.upper()}({_quote_ident(column)})"


def _metric_with_filters_sql(*, metric_op: str, column: str | None, metric_filters: list[Any], params: list[Any]) -> str:
    metric_expr = _metric_sql(metric_op, column)
    if not metric_filters:
        return metric_expr
    filter_parts, filter_params = _apply_filter(metric_filters)
    if not filter_parts:
        return metric_expr
    params.extend(filter_params)
    return f"{metric_expr} FILTER (WHERE {' AND '.join(filter_parts)})"


def _compile_derived_formula_sql(
    formula: str,
    *,
    ref_sql_map: dict[str, str],
    on_divide_by_zero: str,
) -> tuple[str, set[str]]:
    try:
        root = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise EngineError(status_code=400, code="invalid_formula", message="Invalid derived KPI formula syntax") from exc

    refs: set[str] = set()

    def render(node: ast.AST) -> str:
        if isinstance(node, ast.Expression):
            return render(node.body)
        if isinstance(node, ast.BinOp):
            left = render(node.left)
            right = render(node.right)
            if isinstance(node.op, ast.Add):
                return f"({left} + {right})"
            if isinstance(node.op, ast.Sub):
                return f"({left} - {right})"
            if isinstance(node.op, ast.Mult):
                return f"({left} * {right})"
            if isinstance(node.op, ast.Div):
                division = f"(({left})::double precision / NULLIF(({right})::double precision, 0))"
                if on_divide_by_zero == "zero":
                    return f"COALESCE({division}, 0)"
                return division
            raise EngineError(
                status_code=400,
                code="invalid_formula",
                message="Derived KPI formula only supports +, -, *, / and parentheses",
            )
        if isinstance(node, ast.UnaryOp):
            operand = render(node.operand)
            if isinstance(node.op, ast.UAdd):
                return f"(+{operand})"
            if isinstance(node.op, ast.USub):
                return f"(-{operand})"
            raise EngineError(status_code=400, code="invalid_formula", message="Unsupported unary operator in formula")
        if isinstance(node, ast.Name):
            if node.id not in ref_sql_map:
                raise EngineError(
                    status_code=400,
                    code="invalid_formula",
                    message=f"Derived KPI formula references unknown metric '{node.id}'",
                )
            refs.add(node.id)
            return ref_sql_map[node.id]
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return str(node.value)
        raise EngineError(status_code=400, code="invalid_formula", message="Derived KPI formula contains unsupported tokens")

    sql = render(root)
    return sql, refs


def _is_valid_sql_alias_identifier(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value))


def _parse_temporal_dimension(value: str) -> tuple[str, str] | None:
    for prefix, granularity in _TEMPORAL_DIMENSION_PREFIXES.items():
        token = f"{prefix}:"
        if value.startswith(token):
            column = value[len(token) :].strip()
            if column:
                return granularity, column
    return None


def _dimension_sql(dimension: str) -> tuple[str, str]:
    temporal_dimension = _parse_temporal_dimension(dimension)
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
    temporal_dimension = _parse_temporal_dimension(dimension)
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
        return value + timedelta(days=1)
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


def _apply_filter(filters: list[Any]) -> tuple[list[str], list[Any]]:
    where_parts: list[str] = []
    params: list[Any] = []

    for item in filters:
        column = _quote_ident(item.field)
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
        elif op in {"in", "not_in"}:
            values = value if isinstance(value, list) else [value]
            placeholder = _date_param_expr() if use_date_expr else "%s"
            placeholders = ", ".join([placeholder] * len(values))
            operator = "IN" if op == "in" else "NOT IN"
            where_parts.append(f"{column} {operator} ({placeholders})")
            params.extend(values)
        elif op == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise EngineError(status_code=400, code="invalid_filter", message="between filter requires [start, end]")
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
            raise EngineError(status_code=400, code="invalid_filter", message=f"Unsupported filter operator '{op}'")

    return where_parts, params


def compile_query(spec: QuerySpec, *, max_rows: int) -> tuple[str, list[Any], int]:
    if spec.widget_type == "text":
        return "SELECT 1 WHERE FALSE", [], 0

    if spec.widget_type == "dre":
        if not spec.dre_rows:
            raise EngineError(status_code=400, code="invalid_spec", message="DRE widget requires at least one row")
        select_parts: list[str] = []
        for index, row in enumerate(spec.dre_rows):
            if not row.metrics:
                raise EngineError(status_code=400, code="invalid_spec", message="DRE row requires at least one metric")
            row_expr_parts = [f"COALESCE({_metric_sql(metric.agg, metric.field)}, 0)" for metric in row.metrics]
            select_parts.append(f"({' + '.join(row_expr_parts)}) AS {_quote_ident(f'm{index}')}")
        query_parts = [f"SELECT {', '.join(select_parts)}", f"FROM {_qualified_name(spec.resource_id)}"]
        where_parts, params = _apply_filter(spec.filters)
        if where_parts:
            query_parts.append("WHERE " + " AND ".join(where_parts))
        return " ".join(query_parts), params, 1

    if spec.widget_type == "kpi" and spec.composite_metric is not None:
        where_parts, params = _apply_filter(spec.filters)
        where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
        composite = spec.composite_metric
        bucket = f"DATE_TRUNC('{composite.granularity}', {_quote_ident(composite.time_column)})"
        inner_metric = _metric_sql(composite.inner_agg, composite.value_column)
        outer_metric = _metric_sql(composite.outer_agg, "bucket_value")
        sql = (
            f"SELECT {outer_metric} AS {_quote_ident('m0')} "
            f"FROM ("
            f"SELECT {bucket} AS {_quote_ident('time_bucket')}, {inner_metric} AS {_quote_ident('bucket_value')} "
            f"FROM {_qualified_name(spec.resource_id)}"
            f"{where_sql} "
            f"GROUP BY {_quote_ident('time_bucket')}"
            f") AS {_quote_ident('kpi_bucketed')}"
        )
        return sql, params, 1

    if spec.widget_type == "kpi" and spec.derived_metric is not None:
        if not spec.metrics:
            raise EngineError(status_code=400, code="invalid_spec", message="Derived KPI requires base metrics")

        select_parts: list[str] = []
        params: list[Any] = []
        ref_sql_map: dict[str, str] = {}
        seen_aliases: set[str] = set()
        for index, metric in enumerate(spec.metrics):
            legacy_ref = f"m{index}"
            metric_alias = (metric.alias or "").strip() or legacy_ref
            if not _is_valid_sql_alias_identifier(metric_alias):
                raise EngineError(status_code=400, code="invalid_spec", message=f"Invalid derived KPI metric alias '{metric_alias}'")
            if metric_alias in seen_aliases:
                raise EngineError(status_code=400, code="invalid_spec", message=f"Duplicated derived KPI metric alias '{metric_alias}'")
            seen_aliases.add(metric_alias)
            alias = _quote_ident(metric_alias)
            metric_expr = _metric_with_filters_sql(
                metric_op=metric.agg,
                column=metric.field,
                metric_filters=metric.filters,
                params=params,
            )
            select_parts.append(f"{metric_expr} AS {alias}")
            ref_sql_map[metric_alias] = alias
            ref_sql_map[legacy_ref] = alias

        where_parts, where_params = _apply_filter(spec.filters)
        params.extend(where_params)
        where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""

        expr_sql, expr_refs = _compile_derived_formula_sql(
            spec.derived_metric.formula,
            ref_sql_map=ref_sql_map,
            on_divide_by_zero=spec.derived_metric.on_divide_by_zero,
        )
        if not expr_refs:
            raise EngineError(
                status_code=400,
                code="invalid_formula",
                message="Derived KPI formula must reference at least one base metric",
            )
        if spec.derived_metric.dependencies and set(spec.derived_metric.dependencies) != expr_refs:
            raise EngineError(
                status_code=400,
                code="invalid_formula",
                message="Derived KPI dependencies do not match formula references",
            )

        sql = (
            f"WITH {_quote_ident('kpi_base')} AS ("
            f"SELECT {', '.join(select_parts)} "
            f"FROM {_qualified_name(spec.resource_id)}"
            f"{where_sql}"
            f") "
            f"SELECT {expr_sql} AS {_quote_ident('m0')} "
            f"FROM {_quote_ident('kpi_base')}"
        )
        return sql, params, 1

    select_parts: list[str] = []
    group_by_parts: list[str] = []
    params: list[Any] = []

    use_table_columns = spec.widget_type == "table" and bool(spec.columns)
    if use_table_columns:
        for column in spec.columns or []:
            select_parts.append(_quote_ident(column))
    else:
        if spec.widget_type == "line" and spec.time:
            if spec.time.granularity == "hour":
                time_expr = (
                    f"TO_CHAR(DATE_TRUNC('hour', {_quote_ident(spec.time.column)}), 'HH24:00') "
                    f"AS {_quote_ident('time_bucket')}"
                )
            else:
                time_expr = (
                    f"DATE_TRUNC('{spec.time.granularity}', {_quote_ident(spec.time.column)}) "
                    f"AS {_quote_ident('time_bucket')}"
                )
            select_parts.append(time_expr)
            group_by_parts.append(_quote_ident("time_bucket"))

        for dimension in spec.dimensions:
            dim_select, dim_group = _dimension_sql(dimension)
            select_parts.append(dim_select)
            group_by_parts.append(dim_group)

        for index, metric in enumerate(spec.metrics):
            alias = _quote_ident(f"m{index}")
            metric_expr = _metric_with_filters_sql(
                metric_op=metric.agg,
                column=metric.field,
                metric_filters=metric.filters,
                params=params,
            )
            select_parts.append(f"{metric_expr} AS {alias}")

    if not select_parts:
        raise EngineError(status_code=400, code="invalid_spec", message="Query requires at least one selected column or metric")

    query_parts = [
        f"SELECT {', '.join(select_parts)}",
        f"FROM {_qualified_name(spec.resource_id)}",
    ]

    where_parts, where_params = _apply_filter(spec.filters)
    if where_parts:
        query_parts.append("WHERE " + " AND ".join(where_parts))
        params.extend(where_params)

    if group_by_parts:
        query_parts.append("GROUP BY " + ", ".join(group_by_parts))

    order_by = spec.order_by
    if not order_by and spec.sort:
        order_by = [
            type("OrderBy", (), {"column": item.field, "metric_ref": None, "direction": item.dir})()
            for item in spec.sort
        ]

    if order_by:
        order_parts: list[str] = []
        for item in order_by:
            direction = "ASC" if item.direction == "asc" else "DESC"
            if item.column:
                dimension_order = _dimension_order_sql(item.column, direction)
                if dimension_order:
                    order_parts.append(dimension_order)
                else:
                    order_parts.append(f"{_quote_ident(item.column)} {direction}")
            elif item.metric_ref:
                order_parts.append(f"{_quote_ident(item.metric_ref)} {direction}")
        if order_parts:
            query_parts.append("ORDER BY " + ", ".join(order_parts))
    elif spec.widget_type == "line":
        query_parts.append(f"ORDER BY {_quote_ident('time_bucket')} ASC")
    elif spec.widget_type in {"bar", "column"} and len(spec.dimensions) == 1:
        dimension_order = _dimension_order_sql(spec.dimensions[0], "ASC")
        if dimension_order:
            query_parts.append("ORDER BY " + dimension_order)

    effective_limit: int | None = None
    if spec.widget_type == "table":
        effective_limit = spec.limit
    if spec.widget_type in {"bar", "column", "donut"} and spec.top_n is not None:
        effective_limit = spec.top_n
    if effective_limit is not None:
        safe_limit = min(max_rows, max(1, int(effective_limit)))
        query_parts.append(f"LIMIT {safe_limit}")
    else:
        safe_limit = max_rows

    safe_offset = max(0, int(spec.offset))
    if safe_offset:
        query_parts.append(f"OFFSET {safe_offset}")

    return " ".join(query_parts), params, safe_limit
