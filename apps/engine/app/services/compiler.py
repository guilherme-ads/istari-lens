from __future__ import annotations

import ast
import re
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.errors import EngineError
from app.schemas import FilterSpec, QuerySpec

_TEMPORAL_DIMENSION_PREFIXES: dict[str, str] = {
    "__time_day__": "day",
    "__time_month__": "month",
    "__time_week__": "week",
    "__time_weekday__": "weekday",
    "__time_hour__": "hour",
}
_FORBIDDEN_ROW_LEVEL_AGGREGATIONS = {"sum", "avg", "count", "min", "max"}


def _quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _qualified_name(name: str) -> str:
    parts = [part for part in name.split(".") if part]
    return ".".join(_quote_ident(part) for part in parts)


def _quote_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise EngineError(status_code=400, code="invalid_base_query", message="Unsupported literal type in computed column expression")


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
        expr = f"DATE_TRUNC('month', {col_ident})"
    elif granularity == "week":
        expr = f"DATE_TRUNC('week', {col_ident})"
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
        return f"MIN(EXTRACT(ISODOW FROM {col_ident})) {direction} NULLS LAST"
    if granularity == "week":
        return f"MIN(DATE_TRUNC('week', {col_ident})) {direction} NULLS LAST"
    if granularity == "month":
        return f"MIN(DATE_TRUNC('month', {col_ident})) {direction} NULLS LAST"
    if granularity == "hour":
        return f"MIN(EXTRACT(HOUR FROM {col_ident})) {direction} NULLS LAST"
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
        elif op == "not_contains":
            where_parts.append(f"{column}::text NOT ILIKE %s")
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


def _compile_base_expr(node: Any) -> str:
    if not isinstance(node, dict):
        raise EngineError(status_code=400, code="invalid_base_query", message="Computed column expression node must be an object")
    if "column" in node:
        value = node.get("column")
        if not isinstance(value, str) or not value.strip():
            raise EngineError(status_code=400, code="invalid_base_query", message="Computed column reference requires a non-empty column")
        return _quote_ident(value)
    if "literal" in node:
        return _quote_literal(node.get("literal"))

    op = node.get("op")
    args = node.get("args")
    if not isinstance(op, str):
        raise EngineError(status_code=400, code="invalid_base_query", message="Computed column expression operator is required")
    if op.lower() in _FORBIDDEN_ROW_LEVEL_AGGREGATIONS:
        raise EngineError(
            status_code=400,
            code="invalid_base_query",
            message="Agregacoes nao sao permitidas em colunas calculadas. Use metricas para isso.",
        )
    if not isinstance(args, list) or not args:
        raise EngineError(status_code=400, code="invalid_base_query", message="Computed column expression args are required")
    rendered_args = [_compile_base_expr(item) for item in args]
    normalized_op = op.lower()

    if normalized_op == "add":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="add expects 2 args")
        return f"({rendered_args[0]} + {rendered_args[1]})"
    if normalized_op == "sub":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="sub expects 2 args")
        return f"({rendered_args[0]} - {rendered_args[1]})"
    if normalized_op == "mul":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="mul expects 2 args")
        return f"({rendered_args[0]} * {rendered_args[1]})"
    if normalized_op == "div":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="div expects 2 args")
        return f"(({rendered_args[0]})::double precision / NULLIF(({rendered_args[1]})::double precision, 0))"
    if normalized_op == "mod":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="mod expects 2 args")
        return f"MOD({rendered_args[0]}, {rendered_args[1]})"
    if normalized_op == "concat":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="concat expects 2 args")
        return f"({rendered_args[0]}::text || {rendered_args[1]}::text)"
    if normalized_op == "coalesce":
        return f"COALESCE({', '.join(rendered_args)})"
    if normalized_op == "nullif":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="nullif expects 2 args")
        return f"NULLIF({rendered_args[0]}, {rendered_args[1]})"
    if normalized_op == "lower":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="lower expects 1 arg")
        return f"LOWER({rendered_args[0]}::text)"
    if normalized_op == "upper":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="upper expects 1 arg")
        return f"UPPER({rendered_args[0]}::text)"
    if normalized_op == "substring":
        if len(rendered_args) not in {2, 3}:
            raise EngineError(status_code=400, code="invalid_base_query", message="substring expects 2 or 3 args")
        if len(rendered_args) == 2:
            return f"SUBSTRING({rendered_args[0]}::text FROM {rendered_args[1]})"
        return f"SUBSTRING({rendered_args[0]}::text FROM {rendered_args[1]} FOR {rendered_args[2]})"
    if normalized_op == "trim":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="trim expects 1 arg")
        return f"TRIM({rendered_args[0]}::text)"
    if normalized_op == "extract":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="extract expects 2 args")
        return f"EXTRACT({rendered_args[0]} FROM {rendered_args[1]})"
    if normalized_op == "abs":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="abs expects 1 arg")
        return f"ABS({rendered_args[0]})"
    if normalized_op == "round":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="round expects 1 arg")
        return f"ROUND({rendered_args[0]})"
    if normalized_op == "ceil":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="ceil expects 1 arg")
        return f"CEIL({rendered_args[0]})"
    if normalized_op == "floor":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="floor expects 1 arg")
        return f"FLOOR({rendered_args[0]})"
    if normalized_op == "date_trunc":
        if len(rendered_args) == 1:
            return f"DATE_TRUNC('day', {rendered_args[0]})"
        if len(rendered_args) == 2:
            return f"DATE_TRUNC({rendered_args[0]}::text, {rendered_args[1]})"
        raise EngineError(status_code=400, code="invalid_base_query", message="date_trunc expects 1 or 2 args")
    if normalized_op == "eq":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="eq expects 2 args")
        return f"({rendered_args[0]} = {rendered_args[1]})"
    if normalized_op == "neq":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="neq expects 2 args")
        return f"({rendered_args[0]} <> {rendered_args[1]})"
    if normalized_op == "gt":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="gt expects 2 args")
        return f"({rendered_args[0]} > {rendered_args[1]})"
    if normalized_op == "gte":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="gte expects 2 args")
        return f"({rendered_args[0]} >= {rendered_args[1]})"
    if normalized_op == "lt":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="lt expects 2 args")
        return f"({rendered_args[0]} < {rendered_args[1]})"
    if normalized_op == "lte":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="lte expects 2 args")
        return f"({rendered_args[0]} <= {rendered_args[1]})"
    if normalized_op == "and":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="and expects 2 args")
        return f"(({rendered_args[0]}) AND ({rendered_args[1]}))"
    if normalized_op == "or":
        if len(rendered_args) != 2:
            raise EngineError(status_code=400, code="invalid_base_query", message="or expects 2 args")
        return f"(({rendered_args[0]}) OR ({rendered_args[1]}))"
    if normalized_op == "not":
        if len(rendered_args) != 1:
            raise EngineError(status_code=400, code="invalid_base_query", message="not expects 1 arg")
        return f"(NOT ({rendered_args[0]}))"
    if normalized_op == "case_when":
        if len(rendered_args) != 3:
            raise EngineError(status_code=400, code="invalid_base_query", message="case_when expects 3 args")
        return f"(CASE WHEN {rendered_args[0]} THEN {rendered_args[1]} ELSE {rendered_args[2]} END)"
    raise EngineError(status_code=400, code="invalid_base_query", message=f"Unsupported computed column operator '{op}'")


def _compile_base_query_ctes(spec: QuerySpec) -> tuple[list[str], list[Any], str]:
    base_query = spec.base_query
    if not isinstance(base_query, dict):
        return [], [], _qualified_name(spec.resource_id)

    base = base_query.get("base")
    preprocess = base_query.get("preprocess")
    if not isinstance(base, dict) or not isinstance(preprocess, dict):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query requires base and preprocess objects")

    resources_payload = base.get("resources")
    if not isinstance(resources_payload, list) or not resources_payload:
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.resources must be a non-empty array")
    primary_resource = base.get("primary_resource")
    if not isinstance(primary_resource, str) or not primary_resource.strip():
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.primary_resource is required")

    resources_by_id: dict[str, str] = {}
    resources_by_resource_id: dict[str, str] = {}
    for item in resources_payload:
        if not isinstance(item, dict):
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.resources items must be objects")
        resource_alias = item.get("id")
        resource_id = item.get("resource_id")
        if not isinstance(resource_alias, str) or not resource_alias.strip():
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.resources.id is required")
        if not isinstance(resource_id, str) or not resource_id.strip():
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.resources.resource_id is required")
        resources_by_id[resource_alias] = resource_id
        resources_by_resource_id[resource_id] = resource_alias

    if primary_resource not in resources_by_resource_id:
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.primary_resource must exist in resources")

    primary_alias = resources_by_resource_id[primary_resource]
    from_parts = [f"FROM {_qualified_name(primary_resource)} AS {_quote_ident(primary_alias)}"]
    joins_payload = base.get("joins") or []
    if not isinstance(joins_payload, list):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.joins must be an array")
    for join in joins_payload:
        if not isinstance(join, dict):
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query.base.joins items must be objects")
        join_type = str(join.get("type") or "").strip().lower()
        if join_type not in {"inner", "left"}:
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query join type must be inner or left")
        left_resource = join.get("left_resource")
        right_resource = join.get("right_resource")
        if not isinstance(left_resource, str) or left_resource not in resources_by_id:
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query join left_resource is invalid")
        if not isinstance(right_resource, str) or right_resource not in resources_by_id:
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query join right_resource is invalid")
        right_resource_id = resources_by_id[right_resource]
        on_payload = join.get("on") or []
        if not isinstance(on_payload, list) or not on_payload:
            raise EngineError(status_code=400, code="invalid_base_query", message="base_query join requires on conditions")
        on_parts: list[str] = []
        for clause in on_payload:
            if not isinstance(clause, dict):
                raise EngineError(status_code=400, code="invalid_base_query", message="base_query join on clauses must be objects")
            left_column = clause.get("left_column")
            right_column = clause.get("right_column")
            if not isinstance(left_column, str) or not left_column.strip():
                raise EngineError(status_code=400, code="invalid_base_query", message="base_query join left_column is required")
            if not isinstance(right_column, str) or not right_column.strip():
                raise EngineError(status_code=400, code="invalid_base_query", message="base_query join right_column is required")
            on_parts.append(
                f"{_quote_ident(left_resource)}.{_quote_ident(left_column)} = {_quote_ident(right_resource)}.{_quote_ident(right_column)}"
            )
        join_sql = "INNER JOIN" if join_type == "inner" else "LEFT JOIN"
        from_parts.append(
            f"{join_sql} {_qualified_name(right_resource_id)} AS {_quote_ident(right_resource)} ON {' AND '.join(on_parts)}"
        )

    columns_block = preprocess.get("columns")
    if not isinstance(columns_block, dict):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.preprocess.columns must be an object")
    include_payload = columns_block.get("include") or []
    exclude_payload = columns_block.get("exclude") or []
    if not isinstance(include_payload, list):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.preprocess.columns.include must be an array")
    if not isinstance(exclude_payload, list):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.preprocess.columns.exclude must be an array")

    projected_select_parts: list[str] = []
    if include_payload:
        for item in include_payload:
            if not isinstance(item, dict):
                raise EngineError(status_code=400, code="invalid_base_query", message="include items must be objects")
            resource_key = item.get("resource")
            column_name = item.get("column")
            alias = item.get("alias")
            if not isinstance(resource_key, str) or resource_key not in resources_by_id:
                raise EngineError(status_code=400, code="invalid_base_query", message="include.resource is invalid")
            if not isinstance(column_name, str) or not column_name.strip():
                raise EngineError(status_code=400, code="invalid_base_query", message="include.column is required")
            if not isinstance(alias, str) or not alias.strip():
                raise EngineError(status_code=400, code="invalid_base_query", message="include.alias is required")
            projected_select_parts.append(
                f"{_quote_ident(resource_key)}.{_quote_ident(column_name)} AS {_quote_ident(alias)}"
            )
    else:
        projected_select_parts.append(f"{_quote_ident(primary_alias)}.*")

    if exclude_payload:
        if not include_payload:
            raise EngineError(
                status_code=400,
                code="invalid_base_query",
                message="exclude is only supported when include is explicitly defined",
            )
        excluded_aliases: set[str] = set()
        for item in exclude_payload:
            if isinstance(item, str):
                excluded_aliases.add(item)
                continue
            if isinstance(item, dict) and isinstance(item.get("alias"), str):
                excluded_aliases.add(str(item.get("alias")))
        if excluded_aliases:
            filtered_parts: list[str] = []
            for part in projected_select_parts:
                split_alias = part.split(" AS ")
                if len(split_alias) != 2:
                    filtered_parts.append(part)
                    continue
                alias_ident = split_alias[1].strip()
                alias_name = alias_ident.strip('"')
                if alias_name in excluded_aliases:
                    continue
                filtered_parts.append(part)
            projected_select_parts = filtered_parts
            if not projected_select_parts:
                raise EngineError(status_code=400, code="invalid_base_query", message="No columns left after exclude")

    projected_cte = (
        f"{_quote_ident('__dataset_projected')} AS ("
        f"SELECT {', '.join(projected_select_parts)} "
        f"{' '.join(from_parts)}"
        f")"
    )

    computed_payload = preprocess.get("computed_columns") or []
    if not isinstance(computed_payload, list):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.preprocess.computed_columns must be an array")
    computed_select_parts: list[str] = [f"{_quote_ident('__dataset_projected')}.*"]
    for item in computed_payload:
        if not isinstance(item, dict):
            raise EngineError(status_code=400, code="invalid_base_query", message="computed_columns items must be objects")
        alias = item.get("alias")
        expr = item.get("expr")
        if not isinstance(alias, str) or not alias.strip():
            raise EngineError(status_code=400, code="invalid_base_query", message="computed_columns.alias is required")
        if expr is None:
            raise EngineError(status_code=400, code="invalid_base_query", message="computed_columns.expr is required")
        computed_expr_sql = _compile_base_expr(expr)
        computed_select_parts.append(f"{computed_expr_sql} AS {_quote_ident(alias)}")

    base_filters_payload = preprocess.get("filters") or []
    if not isinstance(base_filters_payload, list):
        raise EngineError(status_code=400, code="invalid_base_query", message="base_query.preprocess.filters must be an array")
    filter_specs: list[FilterSpec] = []
    for item in base_filters_payload:
        normalized_item = item
        if isinstance(item, dict) and "field" not in item and "column" in item:
            normalized_item = {**item, "field": item.get("column")}
        try:
            filter_specs.append(FilterSpec.model_validate(normalized_item))
        except Exception as exc:
            raise EngineError(status_code=400, code="invalid_base_query", message=f"Invalid preprocess filter: {exc}") from exc
    where_parts, params = _apply_filter(filter_specs)
    where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""

    base_cte = (
        f"{_quote_ident('__dataset_base')} AS ("
        f"SELECT {', '.join(computed_select_parts)} "
        f"FROM {_quote_ident('__dataset_projected')}"
        f"{where_sql}"
        f")"
    )
    return [projected_cte, base_cte], params, _quote_ident("__dataset_base")


def _prepend_ctes(sql: str, ctes: list[str]) -> str:
    if not ctes:
        return sql
    stripped = sql.lstrip()
    if stripped.upper().startswith("WITH "):
        with_body = stripped[5:]
        return f"WITH {', '.join(ctes)}, {with_body}"
    return f"WITH {', '.join(ctes)} {sql}"


def compile_query(spec: QuerySpec, *, max_rows: int) -> tuple[str, list[Any], int]:
    if spec.widget_type == "text":
        return "SELECT 1 WHERE FALSE", [], 0

    base_ctes, base_params, source_relation = _compile_base_query_ctes(spec)

    if spec.widget_type == "dre":
        if not spec.dre_rows:
            raise EngineError(status_code=400, code="invalid_spec", message="DRE widget requires at least one row")
        select_parts: list[str] = []
        for index, row in enumerate(spec.dre_rows):
            if not row.metrics:
                raise EngineError(status_code=400, code="invalid_spec", message="DRE row requires at least one metric")
            row_expr_parts = [f"COALESCE({_metric_sql(metric.agg, metric.field)}, 0)" for metric in row.metrics]
            select_parts.append(f"({' + '.join(row_expr_parts)}) AS {_quote_ident(f'm{index}')}")
        query_parts = [f"SELECT {', '.join(select_parts)}", f"FROM {source_relation}"]
        where_parts, params = _apply_filter(spec.filters)
        if where_parts:
            query_parts.append("WHERE " + " AND ".join(where_parts))
        sql = _prepend_ctes(" ".join(query_parts), base_ctes)
        return sql, [*base_params, *params], 1

    if spec.widget_type == "kpi" and spec.composite_metric is not None:
        where_parts, params = _apply_filter(spec.filters)
        where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
        composite = spec.composite_metric
        if composite.granularity == "timestamp":
            bucket = _quote_ident(composite.time_column)
        else:
            bucket = f"DATE_TRUNC('{composite.granularity}', {_quote_ident(composite.time_column)})"
        inner_metric = _metric_sql(composite.inner_agg, composite.value_column)
        outer_metric = _metric_sql(composite.outer_agg, "bucket_value")
        sql = (
            f"SELECT {outer_metric} AS {_quote_ident('m0')} "
            f"FROM ("
            f"SELECT {bucket} AS {_quote_ident('time_bucket')}, {inner_metric} AS {_quote_ident('bucket_value')} "
            f"FROM {source_relation}"
            f"{where_sql} "
            f"GROUP BY {_quote_ident('time_bucket')}"
            f") AS {_quote_ident('kpi_bucketed')}"
        )
        return _prepend_ctes(sql, base_ctes), [*base_params, *params], 1

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
            f"FROM {source_relation}"
            f"{where_sql}"
            f") "
            f"SELECT {expr_sql} AS {_quote_ident('m0')} "
            f"FROM {_quote_ident('kpi_base')}"
        )
        return _prepend_ctes(sql, base_ctes), [*base_params, *params], 1

    select_parts: list[str] = []
    group_by_parts: list[str] = []
    params: list[Any] = []

    use_table_columns = spec.widget_type == "table" and bool(spec.columns)
    if use_table_columns:
        for column in spec.columns or []:
            select_parts.append(_quote_ident(column))
    else:
        if spec.widget_type == "line" and spec.time:
            if spec.time.granularity == "timestamp":
                time_expr = f"{_quote_ident(spec.time.column)} AS {_quote_ident('time_bucket')}"
            elif spec.time.granularity == "hour":
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
        f"FROM {source_relation}",
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
                    order_parts.append(f"{_quote_ident(item.column)} {direction} NULLS LAST")
            elif item.metric_ref:
                order_parts.append(f"{_quote_ident(item.metric_ref)} {direction} NULLS LAST")
        if order_parts:
            query_parts.append("ORDER BY " + ", ".join(order_parts))
    elif spec.widget_type == "line":
        query_parts.append(f"ORDER BY {_quote_ident('time_bucket')} ASC NULLS LAST")
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

    return _prepend_ctes(" ".join(query_parts), base_ctes), [*base_params, *params], safe_limit
