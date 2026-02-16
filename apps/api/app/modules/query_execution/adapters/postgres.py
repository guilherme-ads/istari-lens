from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import date, datetime, timedelta
from time import perf_counter
from typing import Any, Callable
from zoneinfo import ZoneInfo

from cryptography.fernet import InvalidToken
from fastapi import HTTPException
from psycopg import AsyncConnection

from app.database import get_analytics_connection
from app.external_query_logging import log_external_query
from app.modules.query_execution.domain.models import CompiledQuery, InternalQuerySpec, QueryExecutionContext, ResultSet
from app.modules.security.adapters.fernet_vault import FernetSecretsVaultAdapter
from app.settings import get_settings

logger = logging.getLogger("uvicorn.error")
settings = get_settings()


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


def _normalized_sql_hash(sql: str) -> str:
    normalized = " ".join(sql.split()).strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class PostgresQueryCompilerAdapter:
    def __init__(self, *, max_result_rows: int | None = None) -> None:
        self._max_result_rows = max_result_rows or int(getattr(settings, "query_result_rows_max", 1000))

    def compile(self, spec: InternalQuerySpec) -> CompiledQuery:
        if spec.widget_type == "text":
            raise ValueError("Text widget does not generate SQL queries")
        if spec.widget_type == "kpi" and spec.composite_metric is not None:
            where_parts, params = _apply_filter(spec.filters)
            where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
            bucket = f"DATE_TRUNC('{spec.composite_metric.granularity}', {_quote_ident(spec.composite_metric.time_column)})"
            inner_metric = _metric_sql(spec.composite_metric.inner_agg, spec.composite_metric.value_column)
            outer_metric = _metric_sql(spec.composite_metric.outer_agg, "bucket_value")
            sql = (
                f"SELECT {outer_metric} AS {_quote_ident('m0')} "
                f"FROM ("
                f"SELECT {bucket} AS {_quote_ident('time_bucket')}, {inner_metric} AS {_quote_ident('bucket_value')} "
                f"FROM {_qualified_name(spec.view_name)}"
                f"{where_sql} "
                f"GROUP BY {_quote_ident('time_bucket')}"
                f") AS {_quote_ident('kpi_bucketed')}"
            )
            return CompiledQuery(sql=sql, params=params, row_limit=1)

        # Supports legacy table widgets and QuerySpec API aggregation flow in one compiler.
        use_tabular_columns = spec.widget_type == "table" and bool(spec.columns)
        select_parts: list[str] = []
        group_by_parts: list[str] = []
        params: list[Any] = []

        if use_tabular_columns:
            for column in spec.columns or []:
                select_parts.append(_quote_ident(column))
        else:
            if spec.widget_type == "line" and spec.time:
                time_expr = (
                    f"DATE_TRUNC('{spec.time.granularity}', {_quote_ident(spec.time.column)}) "
                    f"AS {_quote_ident('time_bucket')}"
                )
                select_parts.append(time_expr)
                group_by_parts.append(_quote_ident("time_bucket"))

            for dimension in spec.dimensions:
                dim_ident = _quote_ident(dimension)
                select_parts.append(dim_ident)
                group_by_parts.append(dim_ident)

            for index, metric in enumerate(spec.metrics):
                alias = _quote_ident(f"m{index}")
                select_parts.append(f"{_metric_sql(metric.op, metric.column)} AS {alias}")

        if not select_parts:
            raise ValueError("Query requires at least one selected column or metric")

        query_parts = [
            f"SELECT {', '.join(select_parts)}",
            f"FROM {_qualified_name(spec.view_name)}",
        ]

        where_parts, where_params = _apply_filter(spec.filters)
        if where_parts:
            query_parts.append("WHERE " + " AND ".join(where_parts))
            params.extend(where_params)

        if group_by_parts:
            query_parts.append("GROUP BY " + ", ".join(group_by_parts))

        if spec.order_by:
            order_parts: list[str] = []
            for item in spec.order_by:
                direction = "ASC" if item.direction == "asc" else "DESC"
                if item.column:
                    order_parts.append(f"{_quote_ident(item.column)} {direction}")
                elif item.metric_ref:
                    order_parts.append(f"{_quote_ident(item.metric_ref)} {direction}")
            if order_parts:
                query_parts.append("ORDER BY " + ", ".join(order_parts))
        elif spec.widget_type == "line":
            query_parts.append(f"ORDER BY {_quote_ident('time_bucket')} ASC")

        effective_limit = spec.limit
        if spec.widget_type == "bar" and spec.top_n is not None:
            effective_limit = spec.top_n
        if effective_limit is None:
            effective_limit = self._max_result_rows
        safe_limit = min(self._max_result_rows, max(1, int(effective_limit)))
        query_parts.append(f"LIMIT {safe_limit}")

        if spec.offset is not None:
            safe_offset = max(0, spec.offset)
            query_parts.append(f"OFFSET {safe_offset}")

        return CompiledQuery(sql=" ".join(query_parts), params=params, row_limit=safe_limit)

    def compile_kpi_batch(
        self,
        *,
        view_name: str,
        metrics: list[Any],
        filters: list[Any],
        composite_metrics: list[Any] | None = None,
    ) -> tuple[CompiledQuery, list[str]]:
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
            sql = " ".join(query_parts)
            return CompiledQuery(sql=sql, params=params, row_limit=1), aliases

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

        sql = " ".join(query_parts)
        return CompiledQuery(sql=sql, params=params, row_limit=1), aliases


class PostgresQueryRunnerAdapter:
    _DANGEROUS_PATTERN = re.compile(
        r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|execute|copy|vacuum|analyze|refresh|reindex)\b",
        re.IGNORECASE,
    )

    def __init__(
        self,
        *,
        analytics_connection_factory: Callable[[], Any] | None = None,
        datasource_connection_factory: Callable[[str], Any] | None = None,
        secrets_vault: Any | None = None,
    ) -> None:
        self._analytics_connection_factory = analytics_connection_factory or get_analytics_connection
        self._datasource_connection_factory = datasource_connection_factory or AsyncConnection.connect
        self._max_result_rows = int(getattr(settings, "query_result_rows_max", 1000))
        self._secrets_vault = secrets_vault or FernetSecretsVaultAdapter()

    def _assert_safe_read_only(self, sql: str) -> None:
        normalized = " ".join(sql.strip().split())
        lowered = normalized.lower().strip("; ").strip()
        if not lowered:
            raise HTTPException(status_code=400, detail="Empty query")
        if ";" in lowered:
            raise HTTPException(status_code=400, detail="Multiple statements are not allowed")
        if not (lowered.startswith("select ") or lowered.startswith("with ") or lowered.startswith("explain ")):
            raise HTTPException(status_code=400, detail="Only read-only SELECT statements are allowed")
        if self._DANGEROUS_PATTERN.search(lowered):
            raise HTTPException(status_code=400, detail="Dangerous SQL operation blocked")

    async def run(
        self,
        *,
        compiled: CompiledQuery,
        datasource: Any | None,
        context: QueryExecutionContext,
        timeout_seconds: int,
    ) -> ResultSet:
        self._assert_safe_read_only(compiled.sql)
        started = perf_counter()
        conn: AsyncConnection[Any] | None = None
        try:
            if datasource and getattr(datasource, "database_url", None):
                try:
                    decrypted_url = self._secrets_vault.decrypt(datasource.database_url)
                except InvalidToken as exc:
                    raise HTTPException(
                        status_code=400,
                        detail="Datasource credentials are invalid for current encryption key. Recreate datasource.",
                    ) from exc
                conn = await self._datasource_connection_factory(decrypted_url)
            else:
                conn = await self._analytics_connection_factory()

            log_external_query(
                sql=compiled.sql,
                params=compiled.params,
                context=context.operation,
                datasource_id=context.datasource_id,
            )
            result = await asyncio.wait_for(conn.execute(compiled.sql, compiled.params), timeout=timeout_seconds)
            rows = await result.fetchall()
            columns = [desc[0] for desc in result.description]
            clipped_rows = rows[: min(max(1, compiled.row_limit), self._max_result_rows)]
            row_dicts: list[dict[str, Any]] = []
            for row in clipped_rows:
                row_dicts.append({column: row[idx] for idx, column in enumerate(columns)})
            elapsed_ms = int((perf_counter() - started) * 1000)
            sql_hash = _normalized_sql_hash(compiled.sql)
            logger.info(
                "query_execution | request_id=%s user_id=%s tenant_id=%s dataset_id=%s datasource_id=%s op=%s sql_hash=%s duration_ms=%s rows=%s",
                context.request_id,
                context.user_id,
                context.tenant_id,
                context.dataset_id,
                context.datasource_id,
                context.operation,
                sql_hash,
                elapsed_ms,
                len(row_dicts),
            )
            return ResultSet(
                columns=columns,
                rows=row_dicts,
                row_count=len(row_dicts),
                execution_time_ms=elapsed_ms,
                sql_hash=sql_hash,
                metadata={"timeout_seconds": timeout_seconds},
            )
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="Query execution timed out") from exc
        finally:
            if conn:
                await conn.close()
