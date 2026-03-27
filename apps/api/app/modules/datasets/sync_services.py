from __future__ import annotations

import logging
from copy import deepcopy
import hashlib
import re
import socket
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Any, Callable

import psycopg
from psycopg import sql
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import (
    DataSource,
    Dashboard,
    DashboardWidget,
    Dataset,
    DatasetSyncRun,
    DatasetSyncSchedule,
    View,
    ViewColumn,
)
from app.modules.datasets.execution_mode import has_published_import_binding
from app.modules.datasets.preaggregation import (
    build_rollup_table_name,
    resolve_rollup_plan_for_widget,
)
from app.modules.engine.datasource import resolve_datasource_url
from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.modules.widgets.domain.config import WidgetConfig
from app.modules.widgets.domain import normalize_column_type
from app.shared.infrastructure.database import SessionLocal
from app.shared.infrastructure.settings import Settings, get_settings

logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = {"queued", "running"}
_INTERNAL_IMPORT_SOURCE_TYPE = "postgres_internal_import"
_SIMPLE_CRON_MINUTES_RE = re.compile(r"^\s*\*/(\d+)\s+\*\s+\*\s+\*\s+\*\s*$")
_SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SQL_IDENTIFIER_RE = re.compile(r"^(?!\d)\w+$", re.UNICODE)
_IMPORT_SLOT_A = "a"
_IMPORT_SLOT_B = "b"
_LEGACY_LOAD_TABLE_RE = re.compile(r"^ds_(\d+)__load_(\d+)$")
_PG_IDENTIFIER_MAX_LEN = 63
_LIKELY_ID_COLUMN_RE = re.compile(r"(^id$|_id$)", re.IGNORECASE)
_LIKELY_TIME_COLUMN_RE = re.compile(r"(created_at|updated_at|event_time|timestamp|date|_at$|_dt$)", re.IGNORECASE)

_TEMPORAL_TYPE_TOKENS = ("timestamp", "date", "time")
_NUMERIC_TYPE_TOKENS = ("int", "numeric", "decimal", "float", "double", "real", "bigserial", "serial")


@dataclass(slots=True)
class DatasetMaterializationResult:
    execution_datasource_id: int
    execution_view_id: int
    published_execution_view_id: int
    rows_read: int
    rows_written: int
    bytes_processed: int


@dataclass(slots=True)
class DatasetIndexPlanItem:
    columns: list[str]
    method: str
    reason: str


def _utcnow() -> datetime:
    return datetime.utcnow()


def _to_utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(dt_timezone.utc).replace(tzinfo=None)


def _resolve_schedule_timezone(name: str | None) -> ZoneInfo:
    timezone_name = str(name or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        logger.warning("dataset sync schedule received invalid timezone '%s'; falling back to UTC", timezone_name)
        return ZoneInfo("UTC")


def _to_psycopg_url(url: str) -> str:
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


def _parse_simple_cron_minutes(expr: str | None) -> int | None:
    if not expr:
        return None
    match = _SIMPLE_CRON_MINUTES_RE.match(expr)
    if not match:
        return None
    try:
        value = int(match.group(1))
    except Exception:
        return None
    if value <= 0:
        return None
    return value


def _normalize_identifier(raw_value: str) -> str:
    value = str(raw_value or "").strip().strip('"')
    # Postgres quoted identifiers may include unicode letters (e.g. "contribuição").
    if not value or not _SQL_IDENTIFIER_RE.match(value):
        raise ValueError(f"Invalid identifier: {raw_value!r}")
    return value


def _normalize_projection_alias(raw_value: str) -> str:
    value = str(raw_value or "").strip().strip('"')
    if not value:
        raise ValueError(f"Invalid identifier: {raw_value!r}")
    if _SAFE_IDENTIFIER_RE.match(value):
        return value

    # Preserve meaning while avoiding hard failures for aliases like "Estação".
    normalized = unicodedata.normalize("NFKD", value)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", ascii_only).strip("_")
    if not slug:
        raise ValueError(f"Invalid identifier: {raw_value!r}")
    if slug[0].isdigit():
        slug = f"_{slug}"
    return slug


def _split_resource_id(resource_id: str) -> tuple[str, str]:
    normalized = str(resource_id or "").strip()
    if not normalized:
        raise ValueError("Dataset base_query_spec primary_resource is empty")
    parts = normalized.split(".")
    if len(parts) == 1:
        return "public", _normalize_identifier(parts[0])
    if len(parts) == 2:
        return _normalize_identifier(parts[0]), _normalize_identifier(parts[1])
    raise ValueError("Dataset base_query_spec primary_resource must be schema.resource")


def _slugify_dataset_name(name: str | None) -> str:
    raw = str(name or "").strip()
    if not raw:
        return "dataset"
    normalized = unicodedata.normalize("NFKD", raw)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "_", ascii_only).strip("_").lower()
    slug = re.sub(r"_+", "_", slug)
    return slug or "dataset"


def _build_dataset_object_prefix(
    *,
    dataset_id: int,
    dataset_name: str | None,
    reserved_suffix_len: int = 0,
) -> str:
    base = f"ds_{int(dataset_id)}__"
    token = _slugify_dataset_name(dataset_name)
    max_token_len = max(1, _PG_IDENTIFIER_MAX_LEN - reserved_suffix_len - len(base))
    return f"{base}{token[:max_token_len]}"


def _build_published_view_name(*, dataset_id: int, dataset_name: str | None) -> str:
    return _build_dataset_object_prefix(
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        reserved_suffix_len=0,
    )


def _is_temporal_column_type(column_type: str) -> bool:
    normalized = str(column_type or "").strip().lower()
    return any(token in normalized for token in _TEMPORAL_TYPE_TOKENS)


def _is_numeric_column_type(column_type: str) -> bool:
    normalized = str(column_type or "").strip().lower()
    return any(token in normalized for token in _NUMERIC_TYPE_TOKENS)


def _sanitize_identifier_token(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    token = re.sub(r"[^A-Za-z0-9_]+", "_", ascii_only).strip("_").lower()
    return token or "idx"


def _build_index_name(
    *,
    table_name: str,
    columns: list[str],
    method: str,
) -> str:
    base = f"idx_{_sanitize_identifier_token(table_name)}_{_sanitize_identifier_token('_'.join(columns))}_{_sanitize_identifier_token(method)}"
    if len(base) <= _PG_IDENTIFIER_MAX_LEN:
        return base
    token = hashlib.sha1(base.encode("utf-8")).hexdigest()[:8]
    head_max_len = max(1, _PG_IDENTIFIER_MAX_LEN - len(token) - 1)
    return f"{base[:head_max_len]}_{token}"


def _month_floor(value: datetime) -> datetime:
    return datetime(value.year, value.month, 1)


def _add_months(value: datetime, months: int) -> datetime:
    total = (value.year * 12 + (value.month - 1)) + int(months)
    year = total // 12
    month = (total % 12) + 1
    return datetime(year, month, 1)


def _build_shadow_partitioned_table_name(table_name: str) -> str:
    base = f"{table_name}__part"
    if len(base) <= _PG_IDENTIFIER_MAX_LEN:
        return base
    token = hashlib.sha1(base.encode("utf-8")).hexdigest()[:8]
    head_max_len = max(1, _PG_IDENTIFIER_MAX_LEN - len(token) - 1)
    return f"{base[:head_max_len]}_{token}"


def _build_partition_child_name(parent_table_name: str, partition_start: datetime) -> str:
    suffix = partition_start.strftime("%Y%m")
    base = f"{parent_table_name}__p_{suffix}"
    if len(base) <= _PG_IDENTIFIER_MAX_LEN:
        return base
    token = hashlib.sha1(base.encode("utf-8")).hexdigest()[:8]
    head_max_len = max(1, _PG_IDENTIFIER_MAX_LEN - len(token) - 1)
    return f"{base[:head_max_len]}_{token}"


def _build_default_partition_child_name(parent_table_name: str) -> str:
    base = f"{parent_table_name}__p_default"
    if len(base) <= _PG_IDENTIFIER_MAX_LEN:
        return base
    token = hashlib.sha1(base.encode("utf-8")).hexdigest()[:8]
    head_max_len = max(1, _PG_IDENTIFIER_MAX_LEN - len(token) - 1)
    return f"{base[:head_max_len]}_{token}"


def _quote_sql_identifier(identifier: str) -> str:
    return '"' + str(identifier).replace('"', '""') + '"'


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


def _build_preprocess_filters_where_sql(
    *,
    filters: list[Any],
    field_alias_map: dict[str, str],
) -> tuple[str, list[Any]]:
    where_parts: list[str] = []
    params: list[Any] = []

    for raw in filters:
        if not isinstance(raw, dict):
            raise RuntimeError("Dataset preprocess.filters items must be objects")

        raw_field = raw.get("field") if "field" in raw else raw.get("column")
        if not isinstance(raw_field, str) or not raw_field.strip():
            raise RuntimeError("Dataset preprocess.filters field is required")
        resolved_field = field_alias_map.get(raw_field.strip(), raw_field.strip())

        op = str(raw.get("op") or "").strip().lower()
        if not op:
            raise RuntimeError("Dataset preprocess.filters op is required")
        value = raw.get("value")
        relative = _resolve_relative_date_value(value)
        if relative is not None:
            op, value = relative
        use_date_expr = _is_date_filter_value(value)

        column_sql = _quote_sql_identifier(resolved_field)
        date_param_expr = "((%s::date)::timestamp at time zone 'America/Sao_Paulo')"

        if op == "eq":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} = {rhs}")
            params.append(value)
        elif op == "neq":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} <> {rhs}")
            params.append(value)
        elif op == "gt":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} > {rhs}")
            params.append(value)
        elif op == "lt":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} < {rhs}")
            params.append(value)
        elif op == "gte":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} >= {rhs}")
            params.append(value)
        elif op == "lte":
            rhs = date_param_expr if use_date_expr else "%s"
            where_parts.append(f"{column_sql} <= {rhs}")
            params.append(_next_date_value(value) if use_date_expr else value)
        elif op == "contains":
            where_parts.append(f"{column_sql}::text ILIKE %s")
            params.append(f"%{value}%")
        elif op in {"in", "not_in"}:
            values = value if isinstance(value, list) else [value]
            if not values:
                where_parts.append("FALSE" if op == "in" else "TRUE")
                continue
            placeholder = date_param_expr if use_date_expr else "%s"
            placeholders = ", ".join([placeholder] * len(values))
            operator = "IN" if op == "in" else "NOT IN"
            where_parts.append(f"{column_sql} {operator} ({placeholders})")
            params.extend(values)
        elif op == "between":
            if not isinstance(value, list) or len(value) != 2:
                raise RuntimeError("Dataset preprocess.filters between requires [start, end]")
            if use_date_expr:
                where_parts.append(f"{column_sql} BETWEEN {date_param_expr} AND {date_param_expr}")
                params.extend([value[0], _next_date_value(value[1])])
            else:
                where_parts.append(f"{column_sql} BETWEEN %s AND %s")
                params.extend(value)
        elif op == "is_null":
            where_parts.append(f"{column_sql} IS NULL")
        elif op == "not_null":
            where_parts.append(f"{column_sql} IS NOT NULL")
        else:
            raise RuntimeError(f"Unsupported preprocess filter op '{op}'")

    where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
    return where_sql, params


def _resolve_excluded_projection_aliases(
    *,
    exclude_columns: list[Any],
    include_alias_by_resource_column: dict[tuple[str, str], str],
    default_primary_column_aliases: dict[str, str],
) -> set[str]:
    excluded: set[str] = set()
    default_columns_set = {column for column in default_primary_column_aliases}

    for item in exclude_columns:
        if isinstance(item, str):
            raw = item.strip()
            if raw:
                excluded.add(raw)
            continue
        if not isinstance(item, dict):
            continue
        alias_value = item.get("alias")
        if isinstance(alias_value, str) and alias_value.strip():
            excluded.add(alias_value.strip())
            continue
        resource_value = item.get("resource")
        column_value = item.get("column")
        if not isinstance(resource_value, str) or not isinstance(column_value, str):
            continue
        resource_key = resource_value.strip()
        column_key = column_value.strip()
        if not resource_key or not column_key:
            continue
        mapped_alias = include_alias_by_resource_column.get((resource_key, column_key))
        if mapped_alias:
            excluded.add(mapped_alias)
            continue
        if column_key in default_columns_set:
            excluded.add(default_primary_column_aliases[column_key])
    return excluded


def _compile_formula_expr_sql(
    *,
    formula: str,
    available_fields: dict[str, str],
) -> sql.SQL:
    token_re = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/]")
    raw = str(formula or "").strip()
    if not raw:
        raise RuntimeError("Computed formula cannot be empty")
    compact = re.sub(r"\s+", "", raw)
    tokens = token_re.findall(compact)
    if not tokens or "".join(tokens) != compact:
        raise RuntimeError("Computed formula contains unsupported tokens")

    sql_parts: list[sql.SQL] = []
    for token in tokens:
        if token in {"+", "-", "*", "/", "(", ")"}:
            sql_parts.append(sql.SQL(token))
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?", token):
            sql_parts.append(sql.SQL(token))
            continue
        mapped = available_fields.get(token)
        if mapped is None:
            raise RuntimeError(f"Computed formula references unknown column '{token}'")
        sql_parts.append(sql.Identifier(mapped))
    return sql.SQL("").join(sql_parts)


def _compile_computed_expr_sql(
    *,
    expr: Any,
    available_fields: dict[str, str],
    params: list[Any],
) -> sql.SQL:
    if not isinstance(expr, dict):
        raise RuntimeError("Computed expr must be an object")

    if "formula" in expr:
        formula = expr.get("formula")
        if not isinstance(formula, str):
            raise RuntimeError("Computed formula must be a string")
        return _compile_formula_expr_sql(formula=formula, available_fields=available_fields)

    if "column" in expr:
        column_name = str(expr.get("column") or "").strip()
        if not column_name:
            raise RuntimeError("Computed column reference is empty")
        mapped = available_fields.get(column_name)
        if mapped is None:
            raise RuntimeError(f"Computed expr references unknown column '{column_name}'")
        return sql.Identifier(mapped)

    if "literal" in expr:
        params.append(expr.get("literal"))
        return sql.Placeholder()

    op = str(expr.get("op") or "").strip().lower()
    args = expr.get("args")
    if not isinstance(args, list) or not args:
        raise RuntimeError("Computed expr args must be a non-empty array")
    compiled_args = [
        _compile_computed_expr_sql(expr=item, available_fields=available_fields, params=params)
        for item in args
    ]

    if op == "add":
        if len(compiled_args) != 2:
            raise RuntimeError("Computed op 'add' expects 2 args")
        return sql.SQL("({} + {})").format(compiled_args[0], compiled_args[1])
    if op == "sub":
        if len(compiled_args) != 2:
            raise RuntimeError("Computed op 'sub' expects 2 args")
        return sql.SQL("({} - {})").format(compiled_args[0], compiled_args[1])
    if op == "mul":
        if len(compiled_args) != 2:
            raise RuntimeError("Computed op 'mul' expects 2 args")
        return sql.SQL("({} * {})").format(compiled_args[0], compiled_args[1])
    if op == "div":
        if len(compiled_args) != 2:
            raise RuntimeError("Computed op 'div' expects 2 args")
        return sql.SQL("({} / NULLIF({}, 0))").format(compiled_args[0], compiled_args[1])
    if op == "concat":
        if len(compiled_args) != 2:
            raise RuntimeError("Computed op 'concat' expects 2 args")
        return sql.SQL("(COALESCE(({})::text, '') || COALESCE(({})::text, ''))").format(
            compiled_args[0],
            compiled_args[1],
        )
    if op == "coalesce":
        return sql.SQL("COALESCE({})").format(sql.SQL(", ").join(compiled_args))
    if op == "lower":
        if len(compiled_args) != 1:
            raise RuntimeError("Computed op 'lower' expects 1 arg")
        return sql.SQL("LOWER(({})::text)").format(compiled_args[0])
    if op == "upper":
        if len(compiled_args) != 1:
            raise RuntimeError("Computed op 'upper' expects 1 arg")
        return sql.SQL("UPPER(({})::text)").format(compiled_args[0])
    if op == "date_trunc":
        if len(compiled_args) != 1:
            raise RuntimeError("Computed op 'date_trunc' expects 1 arg")
        return sql.SQL("DATE_TRUNC('day', {})").format(compiled_args[0])
    raise RuntimeError(f"Unsupported computed op '{op}'")


def cleanup_imported_dataset_assets(
    *,
    db: Session,
    dataset: Dataset,
) -> None:
    datasource = dataset.datasource
    workspace_id = int(datasource.created_by_id) if datasource is not None else None
    if workspace_id is None:
        return

    internal_datasource: DataSource | None = None
    if dataset.execution_datasource_id is not None:
        internal_datasource = (
            db.query(DataSource)
            .filter(DataSource.id == int(dataset.execution_datasource_id))
            .first()
        )
    if internal_datasource is None:
        internal_datasource = (
            db.query(DataSource)
            .filter(
                DataSource.created_by_id == workspace_id,
                DataSource.source_type == _INTERNAL_IMPORT_SOURCE_TYPE,
            )
            .order_by(DataSource.id.asc())
            .first()
        )
    if internal_datasource is None:
        return

    internal_url = resolve_datasource_url(internal_datasource)
    if not internal_url:
        return

    target_schema = f"lens_imp_t{workspace_id}"
    dataset_id = int(dataset.id)
    published_view_name = _build_published_view_name(dataset_id=dataset_id, dataset_name=dataset.name)
    legacy_published_view_name = f"ds_{dataset_id}"
    safe_internal_url = _to_psycopg_url(internal_url)
    relation_candidates: list[tuple[str, str]] = []

    try:
        with psycopg.connect(safe_internal_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT c.relname, c.relkind
                    FROM pg_catalog.pg_class c
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = %s
                      AND (
                        c.relname = %s
                        OR c.relname = %s
                        OR c.relname LIKE %s
                        OR c.relname LIKE %s
                      )
                      AND c.relkind IN ('v', 'm', 'r', 'p')
                    ORDER BY
                      CASE
                        WHEN c.relname = %s THEN 0
                        WHEN c.relname = %s THEN 1
                        WHEN c.relname LIKE %s THEN 2
                        WHEN c.relname LIKE %s THEN 3
                        ELSE 4
                      END,
                      c.relname ASC
                    """,
                    (
                        target_schema,
                        published_view_name,
                        legacy_published_view_name,
                        f"ds_{dataset_id}__%",
                        f"ds_{dataset_id}__load_%",
                        published_view_name,
                        legacy_published_view_name,
                        f"ds_{dataset_id}__%",
                        f"ds_{dataset_id}__load_%",
                    ),
                )
                relation_candidates = [(str(item[0]), str(item[1])) for item in cur.fetchall()]

                for rel_name, rel_kind in relation_candidates:
                    if rel_kind == "m":
                        cur.execute(
                            sql.SQL("DROP MATERIALIZED VIEW IF EXISTS {}.{} CASCADE").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(rel_name),
                            )
                        )
                    elif rel_kind == "v":
                        cur.execute(
                            sql.SQL("DROP VIEW IF EXISTS {}.{} CASCADE").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(rel_name),
                            )
                        )
                    else:
                        cur.execute(
                            sql.SQL("DROP TABLE IF EXISTS {}.{} CASCADE").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(rel_name),
                            )
                        )
            conn.commit()
    except Exception:
        logger.exception(
            "failed to cleanup imported dataset physical assets | dataset_id=%s schema=%s relations=%s",
            dataset_id,
            target_schema,
            ",".join(name for name, _kind in relation_candidates),
        )
        raise

    db.query(View).filter(
        View.datasource_id == int(internal_datasource.id),
        View.schema_name == target_schema,
        View.view_name.in_([published_view_name, legacy_published_view_name]),
    ).delete(synchronize_session=False)
    db.query(View).filter(
        View.datasource_id == int(internal_datasource.id),
        View.schema_name == target_schema,
        View.view_name.like(f"ds_{dataset_id}__%"),
    ).delete(synchronize_session=False)


class DatasetSyncSchedulerService:
    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._session_factory = session_factory or SessionLocal
        self._settings = settings or get_settings()

    @staticmethod
    def compute_next_run_at(
        *,
        schedule_kind: str,
        interval_minutes: int | None,
        cron_expr: str | None,
        base_time: datetime,
        timezone_name: str = "UTC",
    ) -> datetime:
        base_utc_naive = _to_utc_naive(base_time)
        tzinfo = _resolve_schedule_timezone(timezone_name)
        base_local = base_utc_naive.replace(tzinfo=dt_timezone.utc).astimezone(tzinfo)
        normalized_kind = str(schedule_kind or "interval").strip().lower()
        if normalized_kind == "interval":
            minutes = int(interval_minutes or 60)
            if minutes <= 0:
                minutes = 60
            next_local = base_local + timedelta(minutes=minutes)
            return next_local.astimezone(dt_timezone.utc).replace(tzinfo=None)

        cron_minutes = _parse_simple_cron_minutes(cron_expr)
        if cron_minutes is not None:
            next_local = base_local + timedelta(minutes=cron_minutes)
            return next_local.astimezone(dt_timezone.utc).replace(tzinfo=None)
        next_local = base_local + timedelta(minutes=60)
        return next_local.astimezone(dt_timezone.utc).replace(tzinfo=None)

    def enqueue_due_runs(self, *, now: datetime | None = None) -> int:
        base_time = now or _utcnow()
        db = self._session_factory()
        try:
            due_schedules = (
                db.query(DatasetSyncSchedule)
                .join(Dataset, Dataset.id == DatasetSyncSchedule.dataset_id)
                .filter(
                    DatasetSyncSchedule.enabled.is_(True),
                    DatasetSyncSchedule.next_run_at.isnot(None),
                    DatasetSyncSchedule.next_run_at <= base_time,
                    Dataset.is_active.is_(True),
                )
                .order_by(DatasetSyncSchedule.next_run_at.asc(), DatasetSyncSchedule.id.asc())
                .all()
            )

            enqueued = 0
            for schedule in due_schedules:
                dataset = schedule.dataset
                if dataset is None:
                    continue

                schedule.last_run_at = base_time
                schedule.next_run_at = self.compute_next_run_at(
                    schedule_kind=str(schedule.schedule_kind or "interval"),
                    interval_minutes=schedule.interval_minutes,
                    cron_expr=schedule.cron_expr,
                    base_time=base_time,
                    timezone_name=schedule.timezone,
                )

                if str(dataset.access_mode or "direct").strip().lower() != "imported":
                    continue
                if dataset.import_config is not None and not bool(dataset.import_config.enabled):
                    continue

                active_run = (
                    db.query(DatasetSyncRun)
                    .filter(
                        DatasetSyncRun.dataset_id == dataset.id,
                        DatasetSyncRun.status.in_(list(_ACTIVE_RUN_STATUSES)),
                    )
                    .first()
                )
                if active_run is not None:
                    continue

                run = DatasetSyncRun(
                    dataset_id=int(dataset.id),
                    trigger_type="scheduled",
                    status="queued",
                    attempt=1,
                    queued_at=base_time,
                    input_snapshot={"scheduled_at": base_time.isoformat()},
                    stats={},
                )
                db.add(run)
                db.flush()
                dataset.last_sync_run_id = int(run.id)
                if has_published_import_binding(dataset):
                    dataset.data_status = "syncing"
                else:
                    dataset.data_status = "initializing"
                enqueued += 1

            db.commit()
            return enqueued
        except Exception:
            db.rollback()
            logger.exception("dataset sync scheduler failed")
            return 0
        finally:
            db.close()


class DatasetSyncWorkerService:
    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] | None = None,
        settings: Settings | None = None,
        worker_id: str | None = None,
    ) -> None:
        self._session_factory = session_factory or SessionLocal
        self._settings = settings or get_settings()
        self._worker_id = worker_id or f"{socket.gethostname()}:{id(self)}"
        self._lease_seconds = max(30, int(getattr(self._settings, "dataset_sync_worker_lease_seconds", 300)))
        self._copy_batch_size = max(100, int(getattr(self._settings, "dataset_sync_copy_batch_size", 1000)))

    def _build_imported_index_plan(
        self,
        *,
        source_columns: list[tuple[str, str]],
        row_count: int,
    ) -> list[DatasetIndexPlanItem]:
        max_indexes = max(0, int(getattr(self._settings, "dataset_sync_optimize_max_indexes", 4)))
        if max_indexes <= 0:
            return []

        temporal_candidates: list[str] = []
        id_candidates: list[str] = []
        metric_candidates: list[str] = []
        for column_name, column_type in source_columns:
            normalized_name = str(column_name or "").strip()
            if not normalized_name:
                continue
            if _is_temporal_column_type(column_type) or _LIKELY_TIME_COLUMN_RE.search(normalized_name):
                temporal_candidates.append(normalized_name)
                continue
            if _LIKELY_ID_COLUMN_RE.search(normalized_name):
                id_candidates.append(normalized_name)
                continue
            if _is_numeric_column_type(column_type):
                metric_candidates.append(normalized_name)

        planned: list[DatasetIndexPlanItem] = []
        used_columns: set[str] = set()

        if temporal_candidates:
            preferred_temporal = sorted(
                temporal_candidates,
                key=lambda item: (0 if _LIKELY_TIME_COLUMN_RE.search(item) else 1, item.lower()),
            )[0]
            method = (
                "brin"
                if row_count >= int(getattr(self._settings, "dataset_sync_optimize_brin_threshold_rows", 500_000))
                else "btree"
            )
            planned.append(DatasetIndexPlanItem(columns=[preferred_temporal], method=method, reason="temporal_filter"))
            used_columns.add(preferred_temporal.lower())

        for column_name in id_candidates:
            if len(planned) >= max_indexes:
                break
            if column_name.lower() in used_columns:
                continue
            planned.append(DatasetIndexPlanItem(columns=[column_name], method="btree", reason="id_filter"))
            used_columns.add(column_name.lower())

        for column_name in metric_candidates:
            if len(planned) >= max_indexes:
                break
            if column_name.lower() in used_columns:
                continue
            planned.append(DatasetIndexPlanItem(columns=[column_name], method="btree", reason="metric_sort"))
            used_columns.add(column_name.lower())

        return planned[:max_indexes]

    def _select_partition_column(
        self,
        *,
        source_columns: list[tuple[str, str]],
    ) -> str | None:
        candidates: list[str] = []
        for column_name, column_type in source_columns:
            normalized_name = str(column_name or "").strip()
            if not normalized_name:
                continue
            if _is_temporal_column_type(column_type) or _LIKELY_TIME_COLUMN_RE.search(normalized_name):
                candidates.append(normalized_name)
        if not candidates:
            return None
        return sorted(
            candidates,
            key=lambda item: (0 if _LIKELY_TIME_COLUMN_RE.search(item) else 1, item.lower()),
        )[0]

    def _maybe_partition_imported_table(
        self,
        *,
        internal_url: str,
        target_schema: str,
        table_name: str,
        source_columns: list[tuple[str, str]],
        row_count: int,
    ) -> str:
        if not bool(getattr(self._settings, "dataset_sync_partition_enabled", True)):
            return table_name
        if int(row_count or 0) < int(getattr(self._settings, "dataset_sync_partition_min_rows", 1_000_000)):
            return table_name

        partition_column = self._select_partition_column(source_columns=source_columns)
        if not partition_column:
            return table_name

        shadow_table_name = _build_shadow_partitioned_table_name(table_name)
        safe_internal_url = _to_psycopg_url(internal_url)

        def _to_datetime(value: Any) -> datetime | None:
            if value is None:
                return None
            if isinstance(value, datetime):
                return value.replace(tzinfo=None)
            if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
                return datetime(int(value.year), int(value.month), int(value.day))
            return None

        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql.SQL("DROP TABLE IF EXISTS {}.{} CASCADE").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(shadow_table_name),
                        )
                    )

                    column_defs = [
                        sql.SQL("{} {}").format(sql.Identifier(column_name), sql.SQL(column_type))
                        for column_name, column_type in source_columns
                    ]
                    cur.execute(
                        sql.SQL("CREATE TABLE {}.{} ({}) PARTITION BY RANGE ({})").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(shadow_table_name),
                            sql.SQL(", ").join(column_defs),
                            sql.Identifier(partition_column),
                        )
                    )

                    cur.execute(
                        sql.SQL("SELECT MIN({}), MAX({}) FROM {}.{}").format(
                            sql.Identifier(partition_column),
                            sql.Identifier(partition_column),
                            sql.Identifier(target_schema),
                            sql.Identifier(table_name),
                        )
                    )
                    bounds_row = cur.fetchone()
                    min_value = _to_datetime(bounds_row[0] if bounds_row else None)
                    max_value = _to_datetime(bounds_row[1] if bounds_row else None)

                    if min_value is not None and max_value is not None:
                        month_cursor = _month_floor(min_value)
                        month_end = _add_months(_month_floor(max_value), 1)
                        while month_cursor < month_end:
                            next_month = _add_months(month_cursor, 1)
                            child_name = _build_partition_child_name(shadow_table_name, month_cursor)
                            cur.execute(
                                sql.SQL("CREATE TABLE {}.{} PARTITION OF {}.{} FOR VALUES FROM (%s) TO (%s)").format(
                                    sql.Identifier(target_schema),
                                    sql.Identifier(child_name),
                                    sql.Identifier(target_schema),
                                    sql.Identifier(shadow_table_name),
                                ),
                                (month_cursor, next_month),
                            )
                            month_cursor = next_month

                    default_child_name = _build_default_partition_child_name(shadow_table_name)
                    cur.execute(
                        sql.SQL("CREATE TABLE {}.{} PARTITION OF {}.{} DEFAULT").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(default_child_name),
                            sql.Identifier(target_schema),
                            sql.Identifier(shadow_table_name),
                        )
                    )

                    cur.execute(
                        sql.SQL("INSERT INTO {}.{} SELECT * FROM {}.{}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(shadow_table_name),
                            sql.Identifier(target_schema),
                            sql.Identifier(table_name),
                        )
                    )
                    cur.execute(
                        sql.SQL("DROP TABLE IF EXISTS {}.{} CASCADE").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(table_name),
                        )
                    )
                    cur.execute(
                        sql.SQL("ALTER TABLE {}.{} RENAME TO {}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(shadow_table_name),
                            sql.Identifier(table_name),
                        )
                    )
                conn.commit()
            return table_name
        except Exception:
            logger.exception(
                "failed to partition imported table; keeping non-partitioned table | schema=%s table=%s partition_column=%s",
                target_schema,
                table_name,
                partition_column,
            )
            return table_name

    def _materialize_rollup_table(
        self,
        *,
        internal_url: str,
        target_schema: str,
        base_table_name: str,
        rollup_table_name: str,
        plan: Any,
    ) -> None:
        safe_internal_url = _to_psycopg_url(internal_url)
        select_items: list[sql.SQL] = []
        group_items: list[sql.SQL] = []

        for column in plan.group_columns:
            if plan.time_column and column == plan.time_column:
                time_expr = sql.SQL("date_trunc('day', {})::timestamp").format(sql.Identifier(column))
                select_items.append(
                    sql.SQL("{} AS {}").format(
                        time_expr,
                        sql.Identifier(column),
                    )
                )
                group_items.append(time_expr)
            else:
                identifier = sql.Identifier(column)
                select_items.append(sql.SQL("{} AS {}").format(identifier, identifier))
                group_items.append(identifier)

        for mapping in plan.metric_mappings:
            if mapping.source_op == "count":
                if mapping.source_column:
                    expr = sql.SQL("count({})").format(sql.Identifier(mapping.source_column))
                else:
                    expr = sql.SQL("count(*)")
            elif mapping.source_op == "sum":
                if not mapping.source_column:
                    continue
                expr = sql.SQL("sum({})").format(sql.Identifier(mapping.source_column))
            elif mapping.source_op == "min":
                if not mapping.source_column:
                    continue
                expr = sql.SQL("min({})").format(sql.Identifier(mapping.source_column))
            elif mapping.source_op == "max":
                if not mapping.source_column:
                    continue
                expr = sql.SQL("max({})").format(sql.Identifier(mapping.source_column))
            else:
                continue
            select_items.append(
                sql.SQL("{} AS {}").format(
                    expr,
                    sql.Identifier(mapping.rollup_column),
                )
            )

        if not select_items:
            return

        create_sql = (
            sql.SQL("CREATE TABLE {}.{} AS SELECT {} FROM {}.{}").format(
                sql.Identifier(target_schema),
                sql.Identifier(rollup_table_name),
                sql.SQL(", ").join(select_items),
                sql.Identifier(target_schema),
                sql.Identifier(base_table_name),
            )
            + (sql.SQL(" GROUP BY {}").format(sql.SQL(", ").join(group_items)) if group_items else sql.SQL(""))
        )

        with psycopg.connect(safe_internal_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql.SQL("DROP TABLE IF EXISTS {}.{} CASCADE").format(
                        sql.Identifier(target_schema),
                        sql.Identifier(rollup_table_name),
                    )
                )
                cur.execute(create_sql)
                cur.execute(
                    sql.SQL("ANALYZE {}.{}").format(
                        sql.Identifier(target_schema),
                        sql.Identifier(rollup_table_name),
                    )
                )
            conn.commit()

    def _refresh_dataset_rollups(
        self,
        *,
        db: Session,
        dataset: Dataset,
        internal_url: str,
        target_schema: str,
        base_table_name: str,
        row_count: int,
    ) -> None:
        if not bool(getattr(self._settings, "dataset_sync_rollup_enabled", True)):
            return
        if int(row_count or 0) < int(getattr(self._settings, "dataset_sync_rollup_min_rows", 200_000)):
            return

        widget_rows = (
            db.query(DashboardWidget)
            .join(Dashboard, Dashboard.id == DashboardWidget.dashboard_id)
            .filter(
                Dashboard.dataset_id == int(dataset.id),
                Dashboard.is_active.is_(True),
            )
            .all()
        )

        max_plans = max(0, int(getattr(self._settings, "dataset_sync_rollup_max_plans", 24)))
        if max_plans == 0:
            return

        required_tables: dict[str, Any] = {}
        for widget in widget_rows:
            raw_config = widget.query_config if isinstance(widget.query_config, dict) else None
            if not isinstance(raw_config, dict):
                continue
            try:
                config = WidgetConfig.model_validate(raw_config)
            except Exception:
                continue
            plan = resolve_rollup_plan_for_widget(config)
            if plan is None:
                continue
            rollup_table_name = build_rollup_table_name(
                dataset_id=int(dataset.id),
                dataset_name=dataset.name,
                signature=plan.signature,
            )
            required_tables[rollup_table_name] = plan
            if len(required_tables) >= max_plans:
                break

        if required_tables:
            for table_name, plan in required_tables.items():
                try:
                    self._materialize_rollup_table(
                        internal_url=internal_url,
                        target_schema=target_schema,
                        base_table_name=base_table_name,
                        rollup_table_name=table_name,
                        plan=plan,
                    )
                except Exception:
                    logger.exception(
                        "failed to materialize dataset rollup table | dataset_id=%s table=%s",
                        dataset.id,
                        table_name,
                    )

        safe_internal_url = _to_psycopg_url(internal_url)
        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT tablename
                        FROM pg_catalog.pg_tables
                        WHERE schemaname = %s
                          AND tablename LIKE %s
                        """,
                        (target_schema, f"ds_{int(dataset.id)}__%__rollup_%"),
                    )
                    rows = cur.fetchall()
                    for row in rows:
                        table_name = str(row[0] or "").strip()
                        if not table_name or table_name in required_tables:
                            continue
                        cur.execute(
                            sql.SQL("DROP TABLE IF EXISTS {}.{} CASCADE").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(table_name),
                            )
                        )
                conn.commit()
        except Exception:
            logger.exception(
                "failed to cleanup stale dataset rollups | dataset_id=%s schema=%s",
                dataset.id,
                target_schema,
            )

    def _optimize_imported_table(
        self,
        *,
        internal_url: str,
        target_schema: str,
        table_name: str,
        source_columns: list[tuple[str, str]],
        row_count: int,
    ) -> None:
        if not bool(getattr(self._settings, "dataset_sync_optimize_table_enabled", True)):
            return

        index_plan = self._build_imported_index_plan(source_columns=source_columns, row_count=max(0, int(row_count or 0)))

        safe_internal_url = _to_psycopg_url(internal_url)
        created_indexes: list[str] = []
        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    for item in index_plan:
                        index_name = _build_index_name(table_name=table_name, columns=item.columns, method=item.method)
                        method_sql = sql.SQL("USING BRIN") if item.method == "brin" else sql.SQL("")
                        columns_sql = sql.SQL(", ").join([sql.Identifier(column) for column in item.columns])
                        cur.execute(
                            sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {}.{} {} ({})").format(
                                sql.Identifier(index_name),
                                sql.Identifier(target_schema),
                                sql.Identifier(table_name),
                                method_sql,
                                columns_sql,
                            )
                        )
                        created_indexes.append(index_name)

                    if bool(getattr(self._settings, "dataset_sync_optimize_cluster_enabled", False)) and created_indexes:
                        cur.execute(
                            sql.SQL("CLUSTER {}.{} USING {}").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(table_name),
                                sql.Identifier(created_indexes[0]),
                            )
                        )
                    cur.execute(
                        sql.SQL("ANALYZE {}.{}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(table_name),
                        )
                    )
                conn.commit()
        except Exception:
            logger.exception(
                "failed to optimize imported table | schema=%s table=%s indexes=%s",
                target_schema,
                table_name,
                ",".join(created_indexes),
            )

    def process_next_queued_run(self) -> bool:
        db = self._session_factory()
        try:
            run = self._claim_next_run(db=db)
            if run is None:
                return False
            self._process_claimed_run(db=db, run_id=int(run.id))
            return True
        finally:
            db.close()

    def _claim_next_run(self, *, db: Session) -> DatasetSyncRun | None:
        query = (
            db.query(DatasetSyncRun)
            .filter(DatasetSyncRun.status == "queued")
            .order_by(DatasetSyncRun.queued_at.asc(), DatasetSyncRun.id.asc())
        )
        bind = db.get_bind()
        if bind is not None and bind.dialect.name == "postgresql":
            query = query.with_for_update(skip_locked=True)
        run = query.first()
        if run is None:
            return None

        now = _utcnow()
        run.status = "running"
        run.started_at = now
        run.lock_expires_at = now + timedelta(seconds=self._lease_seconds)
        run.worker_id = self._worker_id

        dataset = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        if dataset is not None:
            if has_published_import_binding(dataset):
                dataset.data_status = "syncing"
            else:
                dataset.data_status = "initializing"
        db.commit()
        db.refresh(run)
        return run

    def _process_claimed_run(self, *, db: Session, run_id: int) -> None:
        run = db.query(DatasetSyncRun).filter(DatasetSyncRun.id == run_id).first()
        if run is None:
            return

        dataset = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        if dataset is None:
            run.status = "canceled"
            run.finished_at = _utcnow()
            run.error_code = "dataset_not_found"
            run.error_message = "Dataset no longer exists"
            run.lock_expires_at = None
            db.commit()
            return

        if run.status == "canceled":
            run.finished_at = run.finished_at or _utcnow()
            run.lock_expires_at = None
            if dataset.import_config is not None and not bool(dataset.import_config.enabled):
                dataset.data_status = "paused"
            elif has_published_import_binding(dataset):
                dataset.data_status = "ready"
            else:
                dataset.data_status = "initializing"
            db.commit()
            return

        if str(dataset.access_mode or "direct").strip().lower() != "imported":
            run.status = "skipped"
            run.finished_at = _utcnow()
            run.error_code = "dataset_not_imported"
            run.error_message = "Dataset access_mode is not imported"
            run.lock_expires_at = None
            dataset.data_status = "ready"
            db.commit()
            return

        if dataset.import_config is not None and not bool(dataset.import_config.enabled):
            run.status = "skipped"
            run.finished_at = _utcnow()
            run.error_code = "import_disabled"
            run.error_message = "Dataset import config is disabled"
            run.lock_expires_at = None
            dataset.data_status = "paused"
            db.commit()
            return

        try:
            result = self._materialize_imported_dataset(db=db, dataset=dataset, run=run)
            db.refresh(run)
            if run.status == "canceled":
                run.finished_at = run.finished_at or _utcnow()
                run.lock_expires_at = None
                if dataset.import_config is not None and not bool(dataset.import_config.enabled):
                    dataset.data_status = "paused"
                elif has_published_import_binding(dataset):
                    dataset.data_status = "ready"
                else:
                    dataset.data_status = "initializing"
                db.commit()
                return
            now = _utcnow()
            run.status = "success"
            run.finished_at = now
            run.lock_expires_at = None
            run.published_execution_view_id = result.published_execution_view_id
            run.stats = {
                "rows_read": result.rows_read,
                "rows_written": result.rows_written,
                "bytes_processed": result.bytes_processed,
            }
            run.error_code = None
            run.error_message = None
            run.error_details = None
            dataset.execution_datasource_id = result.execution_datasource_id
            dataset.execution_view_id = result.execution_view_id
            dataset.last_successful_sync_at = now
            dataset.last_sync_run_id = int(run.id)
            dataset.data_status = "ready"
            db.commit()
        except Exception as exc:
            logger.exception("dataset sync run failed | run_id=%s dataset_id=%s", run_id, dataset.id)
            db.rollback()
            self._mark_run_failed(run_id=run_id, error=exc)

    def _mark_run_failed(self, *, run_id: int, error: Exception) -> None:
        db = self._session_factory()
        try:
            run = db.query(DatasetSyncRun).filter(DatasetSyncRun.id == run_id).first()
            if run is None:
                return
            dataset = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
            run.status = "failed"
            run.finished_at = _utcnow()
            run.lock_expires_at = None
            run.error_code = "sync_failed"
            run.error_message = str(error)[:1000] or "Dataset sync failed"
            run.error_details = {"exception_type": type(error).__name__}
            if dataset is not None:
                dataset.data_status = "error"
            db.commit()
        finally:
            db.close()

    def _materialize_imported_dataset(
        self,
        *,
        db: Session,
        dataset: Dataset,
        run: DatasetSyncRun,
    ) -> DatasetMaterializationResult:
        internal_datasource = self._resolve_or_create_internal_datasource(db=db, dataset=dataset)
        source_url = resolve_datasource_url(dataset.datasource)
        internal_url = resolve_datasource_url(internal_datasource)
        if not internal_url:
            raise RuntimeError("Internal datasource URL is unavailable")

        workspace_id = int(dataset.datasource.created_by_id if dataset.datasource is not None else internal_datasource.created_by_id)
        target_schema = f"lens_imp_t{workspace_id}"
        published_view_name = _build_published_view_name(
            dataset_id=int(dataset.id),
            dataset_name=dataset.name,
        )
        load_table_name = self._resolve_next_slot_table_name(
            internal_url=internal_url,
            target_schema=target_schema,
            published_view_name=published_view_name,
            dataset_id=int(dataset.id),
            dataset_name=dataset.name,
        )
        if isinstance(dataset.base_query_spec, dict):
            rows_read, rows_written, bytes_processed = self._materialize_base_query_spec_to_internal(
                dataset=dataset,
                source_url=source_url,
                internal_url=internal_url,
                target_schema=target_schema,
                load_table_name=load_table_name,
            )
        else:
            source_schema, source_relation = self._resolve_source_resource(dataset=dataset)
            if not source_url:
                raise RuntimeError("Source datasource URL is unavailable")
            rows_read, rows_written, bytes_processed = self._copy_relation_to_internal(
                source_url=source_url,
                internal_url=internal_url,
                source_schema=source_schema,
                source_relation=source_relation,
                target_schema=target_schema,
                target_table_name=load_table_name,
            )
        source_columns = self._fetch_source_columns(
            source_url=internal_url,
            source_schema=target_schema,
            source_relation=load_table_name,
        )
        load_table_name = self._maybe_partition_imported_table(
            internal_url=internal_url,
            target_schema=target_schema,
            table_name=load_table_name,
            source_columns=source_columns,
            row_count=rows_written,
        )
        source_columns = self._fetch_source_columns(
            source_url=internal_url,
            source_schema=target_schema,
            source_relation=load_table_name,
        )
        self._optimize_imported_table(
            internal_url=internal_url,
            target_schema=target_schema,
            table_name=load_table_name,
            source_columns=source_columns,
            row_count=rows_written,
        )
        self._refresh_dataset_rollups(
            db=db,
            dataset=dataset,
            internal_url=internal_url,
            target_schema=target_schema,
            base_table_name=load_table_name,
            row_count=rows_written,
        )
        self._publish_stable_view(
            internal_url=internal_url,
            target_schema=target_schema,
            load_table_name=load_table_name,
            published_view_name=published_view_name,
        )
        self._cleanup_legacy_load_tables(
            internal_url=internal_url,
            target_schema=target_schema,
            dataset_id=int(dataset.id),
        )
        execution_view_id = self._upsert_internal_view_metadata(
            db=db,
            internal_datasource_id=int(internal_datasource.id),
            target_schema=target_schema,
            published_view_name=published_view_name,
            source_columns=source_columns,
        )
        return DatasetMaterializationResult(
            execution_datasource_id=int(internal_datasource.id),
            execution_view_id=execution_view_id,
            published_execution_view_id=execution_view_id,
            rows_read=rows_read,
            rows_written=rows_written,
            bytes_processed=bytes_processed,
        )

    def _resolve_next_slot_table_name(
        self,
        *,
        internal_url: str,
        target_schema: str,
        published_view_name: str,
        dataset_id: int,
        dataset_name: str | None,
    ) -> str:
        safe_internal_url = _to_psycopg_url(internal_url)
        current_slot: str | None = None
        with psycopg.connect(safe_internal_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT view_definition
                    FROM information_schema.views
                    WHERE table_schema = %s
                      AND table_name = %s
                    """,
                    (target_schema, published_view_name),
                )
                row = cur.fetchone()
                if row and row[0]:
                    current_slot = self._extract_slot_from_view_definition(
                        view_definition=str(row[0]),
                        dataset_id=dataset_id,
                    )

        if current_slot == _IMPORT_SLOT_A:
            next_slot = _IMPORT_SLOT_B
        elif current_slot == _IMPORT_SLOT_B:
            next_slot = _IMPORT_SLOT_A
        else:
            next_slot = _IMPORT_SLOT_A
        return self._build_slot_table_name(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            slot=next_slot,
        )

    @staticmethod
    def _build_slot_table_name(*, dataset_id: int, dataset_name: str | None, slot: str) -> str:
        normalized_slot = str(slot or "").strip().lower()
        if normalized_slot not in {_IMPORT_SLOT_A, _IMPORT_SLOT_B}:
            raise ValueError(f"Invalid imported dataset slot: {slot!r}")
        prefix = _build_dataset_object_prefix(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            reserved_suffix_len=len("__slot_a"),
        )
        return f"{prefix}__slot_{normalized_slot}"

    @staticmethod
    def _extract_slot_from_view_definition(*, view_definition: str, dataset_id: int) -> str | None:
        pattern = re.compile(rf"ds_{int(dataset_id)}__(?:[a-z0-9_]+__)?slot_([ab])", re.IGNORECASE)
        match = pattern.search(view_definition or "")
        if match is None:
            return None
        slot = str(match.group(1) or "").strip().lower()
        if slot in {_IMPORT_SLOT_A, _IMPORT_SLOT_B}:
            return slot
        return None

    def _cleanup_legacy_load_tables(
        self,
        *,
        internal_url: str,
        target_schema: str,
        dataset_id: int,
    ) -> None:
        safe_internal_url = _to_psycopg_url(internal_url)
        pattern = f"ds_{int(dataset_id)}__load_%"
        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT tablename
                        FROM pg_catalog.pg_tables
                        WHERE schemaname = %s
                          AND tablename LIKE %s
                        """,
                        (target_schema, pattern),
                    )
                    rows = cur.fetchall()
                    for row in rows:
                        table_name = str(row[0] or "")
                        if not _LEGACY_LOAD_TABLE_RE.match(table_name):
                            continue
                        cur.execute(
                            sql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(table_name),
                            )
                        )
                conn.commit()
        except Exception:
            logger.exception(
                "failed to cleanup legacy imported load tables | dataset_id=%s schema=%s",
                dataset_id,
                target_schema,
            )

    def _resolve_source_resource(self, *, dataset: Dataset) -> tuple[str, str]:
        if dataset.view is not None:
            return (
                _normalize_identifier(str(dataset.view.schema_name or "public")),
                _normalize_identifier(str(dataset.view.view_name)),
            )

        spec = dataset.base_query_spec if isinstance(dataset.base_query_spec, dict) else None
        if not spec:
            raise RuntimeError("Dataset has no view and no base_query_spec for imported sync")

        base = spec.get("base") if isinstance(spec.get("base"), dict) else {}
        joins = base.get("joins") if isinstance(base.get("joins"), list) else []
        if joins:
            raise RuntimeError("Dataset imported sync does not support joins in base_query_spec yet")

        preprocess = spec.get("preprocess") if isinstance(spec.get("preprocess"), dict) else {}
        computed = preprocess.get("computed_columns") if isinstance(preprocess.get("computed_columns"), list) else []
        filters = preprocess.get("filters") if isinstance(preprocess.get("filters"), list) else []
        columns_cfg = preprocess.get("columns") if isinstance(preprocess.get("columns"), dict) else {}
        include_columns = columns_cfg.get("include") if isinstance(columns_cfg.get("include"), list) else []
        exclude_columns = columns_cfg.get("exclude") if isinstance(columns_cfg.get("exclude"), list) else []
        if computed or filters or include_columns or exclude_columns:
            raise RuntimeError("Dataset imported sync does not support preprocess transformations yet")

        primary_resource = base.get("primary_resource")
        if not isinstance(primary_resource, str) or not primary_resource.strip():
            raise RuntimeError("Dataset base_query_spec has no primary_resource")
        return _split_resource_id(primary_resource)

    def _resolve_or_create_internal_datasource(self, *, db: Session, dataset: Dataset) -> DataSource:
        workspace_id = int(dataset.datasource.created_by_id) if dataset.datasource is not None else None
        if workspace_id is None:
            raise RuntimeError("Dataset logical datasource is unavailable")

        existing = (
            db.query(DataSource)
            .filter(
                DataSource.created_by_id == workspace_id,
                DataSource.source_type == _INTERNAL_IMPORT_SOURCE_TYPE,
                DataSource.is_active.is_(True),
            )
            .order_by(DataSource.id.asc())
            .first()
        )
        if existing is not None:
            return existing

        internal_db_url = (
            self._settings.analytics_db_url
            or self._settings.app_db_url
            or self._settings.database_url
        )
        if not internal_db_url:
            raise RuntimeError("Internal analytics datasource URL is not configured")

        created = DataSource(
            name=f"Lens Internal Imported ({workspace_id})",
            description="Internal datasource for imported dataset materialization",
            database_url=credential_encryptor.encrypt(internal_db_url),
            source_type=_INTERNAL_IMPORT_SOURCE_TYPE,
            tenant_id=getattr(dataset.datasource, "tenant_id", None),
            status="active",
            copy_policy="allowed",
            default_dataset_access_mode="direct",
            is_active=True,
            created_by_id=workspace_id,
        )
        db.add(created)
        db.flush()
        return created

    def _fetch_source_columns(
        self,
        *,
        source_url: str,
        source_schema: str,
        source_relation: str,
    ) -> list[tuple[str, str]]:
        safe_source_url = _to_psycopg_url(source_url)
        query = """
            SELECT
              a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s
              AND c.relname = %s
              AND a.attnum > 0
              AND NOT a.attisdropped
            ORDER BY a.attnum
        """
        with psycopg.connect(safe_source_url) as conn:
            with conn.cursor() as cur:
                cur.execute(query, (source_schema, source_relation))
                rows = cur.fetchall()
        source_columns = [(str(item[0]), str(item[1] or "text")) for item in rows]
        if not source_columns:
            raise RuntimeError(f"No columns found for source resource {source_schema}.{source_relation}")
        return source_columns

    def _copy_relation_to_internal(
        self,
        *,
        source_url: str,
        internal_url: str,
        source_schema: str,
        source_relation: str,
        target_schema: str,
        target_table_name: str,
    ) -> tuple[int, int, int]:
        source_columns = self._fetch_source_columns(
            source_url=source_url,
            source_schema=source_schema,
            source_relation=source_relation,
        )
        return self._copy_source_to_internal(
            source_url=source_url,
            internal_url=internal_url,
            source_schema=source_schema,
            source_relation=source_relation,
            target_schema=target_schema,
            load_table_name=target_table_name,
            source_columns=source_columns,
        )

    @staticmethod
    def _build_staging_table_name(*, dataset_id: int, dataset_name: str | None, resource_key: str, resource_id: str) -> str:
        token = hashlib.sha1(f"{dataset_id}:{resource_key}:{resource_id}".encode("utf-8")).hexdigest()[:10]
        prefix = _build_dataset_object_prefix(
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            reserved_suffix_len=len("__src_") + len(token),
        )
        return f"{prefix}__src_{token}"

    def _update_join_cardinality_actual(
        self,
        *,
        conn: psycopg.Connection,
        spec: dict[str, Any],
        joins: list[Any],
        resolved_resources: dict[str, tuple[str, str]],
    ) -> bool:
        changed = False
        computed_at = _utcnow().isoformat()
        for join in joins:
            if not isinstance(join, dict):
                continue
            cardinality_payload = join.get("cardinality") if isinstance(join.get("cardinality"), dict) else {}
            if isinstance(cardinality_payload.get("actual"), dict):
                continue

            left_resource = _normalize_identifier(str(join.get("left_resource") or ""))
            right_resource = _normalize_identifier(str(join.get("right_resource") or ""))
            left_ref = resolved_resources.get(left_resource)
            right_ref = resolved_resources.get(right_resource)
            if not left_ref or not right_ref:
                continue

            on_items = join.get("on") if isinstance(join.get("on"), list) else []
            left_columns: list[str] = []
            right_columns: list[str] = []
            for item in on_items:
                if not isinstance(item, dict):
                    continue
                left_column = str(item.get("left_column") or "").strip()
                right_column = str(item.get("right_column") or "").strip()
                if not left_column or not right_column:
                    continue
                left_columns.append(_normalize_identifier(left_column))
                right_columns.append(_normalize_identifier(right_column))
            if not left_columns or not right_columns:
                continue

            def _relation_row_count(schema_name: str, relation_name: str) -> int:
                with conn.cursor() as cur:
                    cur.execute(
                        sql.SQL("SELECT COUNT(*) FROM {}.{}").format(
                            sql.Identifier(schema_name),
                            sql.Identifier(relation_name),
                        )
                    )
                    row = cur.fetchone()
                    return int(row[0] or 0) if row else 0

            def _is_unique(schema_name: str, relation_name: str, columns: list[str]) -> bool | None:
                if not columns:
                    return None
                grouped_identifiers = [sql.Identifier(column) for column in columns]
                not_null_checks = [sql.SQL("{} IS NOT NULL").format(sql.Identifier(column)) for column in columns]
                with conn.cursor() as cur:
                    query = sql.SQL(
                        "SELECT EXISTS ("
                        "SELECT 1 FROM {}.{} WHERE {} GROUP BY {} HAVING COUNT(*) > 1 LIMIT 1"
                        ")"
                    ).format(
                        sql.Identifier(schema_name),
                        sql.Identifier(relation_name),
                        sql.SQL(" AND ").join(not_null_checks),
                        sql.SQL(", ").join(grouped_identifiers),
                    )
                    cur.execute(query)
                    result = cur.fetchone()
                    has_duplicates = bool(result[0]) if result else False
                    return not has_duplicates

            left_schema, left_relation = left_ref
            right_schema, right_relation = right_ref
            left_unique = _is_unique(left_schema, left_relation, left_columns)
            right_unique = _is_unique(right_schema, right_relation, right_columns)
            if left_unique is None or right_unique is None:
                value = "indefinida"
            elif left_unique and right_unique:
                value = "1-1"
            elif left_unique and not right_unique:
                value = "1-N"
            elif not left_unique and right_unique:
                value = "N-1"
            else:
                value = "N-N"

            next_payload: dict[str, Any] = {}
            estimated_payload = cardinality_payload.get("estimated")
            if isinstance(estimated_payload, dict):
                next_payload["estimated"] = estimated_payload
            next_payload["actual"] = {
                "value": value,
                "method": "full_scan",
                "computed_at": computed_at,
                "left_rows": _relation_row_count(left_schema, left_relation),
                "right_rows": _relation_row_count(right_schema, right_relation),
            }
            join["cardinality"] = next_payload
            changed = True

        if changed:
            spec_base = spec.get("base")
            if isinstance(spec_base, dict):
                spec_base["joins"] = joins
            spec["base"] = spec_base
        return changed

    def _materialize_base_query_spec_to_internal(
        self,
        *,
        dataset: Dataset,
        source_url: str | None,
        internal_url: str,
        target_schema: str,
        load_table_name: str,
    ) -> tuple[int, int, int]:
        spec = deepcopy(dataset.base_query_spec) if isinstance(dataset.base_query_spec, dict) else None
        if spec is None:
            raise RuntimeError("Dataset has no base_query_spec for imported materialization")

        base = spec.get("base") if isinstance(spec.get("base"), dict) else {}
        preprocess = spec.get("preprocess") if isinstance(spec.get("preprocess"), dict) else {}
        joins = base.get("joins") if isinstance(base.get("joins"), list) else []
        columns_cfg = preprocess.get("columns") if isinstance(preprocess.get("columns"), dict) else {}
        include_columns = columns_cfg.get("include") if isinstance(columns_cfg.get("include"), list) else []
        exclude_columns = columns_cfg.get("exclude") if isinstance(columns_cfg.get("exclude"), list) else []
        computed = preprocess.get("computed_columns") if isinstance(preprocess.get("computed_columns"), list) else []
        filters = preprocess.get("filters") if isinstance(preprocess.get("filters"), list) else []

        primary_resource = base.get("primary_resource")
        if not isinstance(primary_resource, str) or not primary_resource.strip():
            raise RuntimeError("Dataset base_query_spec has no primary_resource")

        resources_cfg = base.get("resources") if isinstance(base.get("resources"), list) else []
        resource_map: dict[str, str] = {}
        for item in resources_cfg:
            if not isinstance(item, dict):
                continue
            resource_key = str(item.get("id") or "").strip()
            resource_id = str(item.get("resource_id") or "").strip()
            if not resource_key or not resource_id:
                continue
            resource_map[_normalize_identifier(resource_key)] = resource_id

        primary_key = next((key for key, rid in resource_map.items() if rid == primary_resource), None)
        if primary_key is None:
            primary_key = "r0"
            resource_map[primary_key] = primary_resource

        if not resource_map:
            raise RuntimeError("Dataset base_query_spec has no resources")

        staged_tables: list[str] = []
        rows_read_total = 0
        bytes_processed_total = 0
        resolved_resources: dict[str, tuple[str, str]] = {}
        for resource_key, resource_id in resource_map.items():
            source_schema, source_relation = _split_resource_id(resource_id)
            if source_schema == target_schema:
                resolved_resources[resource_key] = (target_schema, source_relation)
                continue
            if not source_url:
                raise RuntimeError("Source datasource URL is unavailable for external resources")
            stage_table_name = self._build_staging_table_name(
                dataset_id=int(dataset.id),
                dataset_name=dataset.name,
                resource_key=resource_key,
                resource_id=resource_id,
            )
            staged_tables.append(stage_table_name)
            copied_read, _copied_written, copied_bytes = self._copy_relation_to_internal(
                source_url=source_url,
                internal_url=internal_url,
                source_schema=source_schema,
                source_relation=source_relation,
                target_schema=target_schema,
                target_table_name=stage_table_name,
            )
            rows_read_total += copied_read
            bytes_processed_total += copied_bytes
            resolved_resources[resource_key] = (target_schema, stage_table_name)

        select_parts: list[sql.SQL] = []
        base_projection_aliases: list[str] = []
        include_alias_by_resource_column: dict[tuple[str, str], str] = {}
        projected_field_alias_map: dict[str, str] = {}
        if include_columns:
            for item in include_columns:
                if not isinstance(item, dict):
                    continue
                resource_key = _normalize_identifier(str(item.get("resource") or ""))
                column_name = _normalize_identifier(str(item.get("column") or ""))
                raw_alias_name = str(item.get("alias") or column_name)
                alias_name = _normalize_projection_alias(raw_alias_name)
                if resource_key not in resolved_resources:
                    raise RuntimeError(f"Unknown include resource '{resource_key}'")
                if alias_name in base_projection_aliases:
                    raise RuntimeError(f"Duplicated projected alias '{alias_name}'")
                projected_field_alias_map[raw_alias_name] = alias_name
                projected_field_alias_map[alias_name] = alias_name
                include_alias_by_resource_column[(resource_key, column_name)] = alias_name
                base_projection_aliases.append(alias_name)
                select_parts.append(
                    sql.SQL("{}.{} AS {}").format(
                        sql.Identifier(resource_key),
                        sql.Identifier(column_name),
                        sql.Identifier(alias_name),
                    )
                )

        if primary_key not in resolved_resources:
            raise RuntimeError(f"Primary resource '{primary_key}' is unresolved")
        primary_schema, primary_relation = resolved_resources[primary_key]
        primary_resource_alias = _normalize_identifier(primary_key)
        from_clause = sql.SQL(" FROM {}.{} AS {}").format(
            sql.Identifier(primary_schema),
            sql.Identifier(primary_relation),
            sql.Identifier(primary_resource_alias),
        )

        join_clauses: list[sql.SQL] = []
        for join in joins:
            if not isinstance(join, dict):
                continue
            join_type = str(join.get("type") or "left").strip().lower()
            join_sql = sql.SQL("INNER JOIN") if join_type == "inner" else sql.SQL("LEFT JOIN")
            left_resource = _normalize_identifier(str(join.get("left_resource") or ""))
            right_resource = _normalize_identifier(str(join.get("right_resource") or ""))
            if left_resource not in resolved_resources or right_resource not in resolved_resources:
                raise RuntimeError("Join references unresolved resources")
            right_schema, right_relation = resolved_resources[right_resource]
            on_items = join.get("on") if isinstance(join.get("on"), list) else []
            if not on_items:
                raise RuntimeError("Join has no ON conditions")
            on_parts: list[sql.SQL] = []
            for item in on_items:
                if not isinstance(item, dict):
                    continue
                left_column = _normalize_identifier(str(item.get("left_column") or ""))
                right_column = _normalize_identifier(str(item.get("right_column") or ""))
                on_parts.append(
                    sql.SQL("{}.{} = {}.{}").format(
                        sql.Identifier(left_resource),
                        sql.Identifier(left_column),
                        sql.Identifier(right_resource),
                        sql.Identifier(right_column),
                    )
                )
            if not on_parts:
                raise RuntimeError("Join has invalid ON conditions")
            join_clauses.append(
                sql.SQL(" {} {}.{} AS {} ON {}").format(
                    join_sql,
                    sql.Identifier(right_schema),
                    sql.Identifier(right_relation),
                    sql.Identifier(right_resource),
                    sql.SQL(" AND ").join(on_parts),
                )
            )

        safe_internal_url = _to_psycopg_url(internal_url)
        rows_written = 0
        cardinality_updated = False
        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(target_schema)))
                    cur.execute(
                        sql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(load_table_name),
                        )
                    )
                    default_primary_column_aliases: dict[str, str] = {}
                    if not select_parts:
                        primary_columns = self._fetch_source_columns(
                            source_url=internal_url,
                            source_schema=primary_schema,
                            source_relation=primary_relation,
                        )
                        for column_name, _column_type in primary_columns:
                            alias_name = _normalize_projection_alias(column_name)
                            if alias_name in base_projection_aliases:
                                raise RuntimeError(f"Duplicated projected alias '{alias_name}'")
                            default_primary_column_aliases[column_name] = alias_name
                            base_projection_aliases.append(alias_name)
                            projected_field_alias_map[column_name] = alias_name
                            projected_field_alias_map[alias_name] = alias_name
                            select_parts.append(
                                sql.SQL("{}.{} AS {}").format(
                                    sql.Identifier(primary_resource_alias),
                                    sql.Identifier(column_name),
                                    sql.Identifier(alias_name),
                                )
                            )

                    excluded_aliases = _resolve_excluded_projection_aliases(
                        exclude_columns=exclude_columns,
                        include_alias_by_resource_column=include_alias_by_resource_column,
                        default_primary_column_aliases=default_primary_column_aliases,
                    )
                    selected_base_aliases = [
                        alias_name for alias_name in base_projection_aliases if alias_name not in excluded_aliases
                    ]
                    if not selected_base_aliases:
                        raise RuntimeError("Dataset preprocess excludes all projected columns")

                    projected_sql = (
                        sql.SQL("SELECT {}").format(sql.SQL(", ").join(select_parts))
                        + from_clause
                        + sql.SQL("").join(join_clauses)
                    )
                    stage_sql = (
                        sql.SQL("SELECT {} FROM (").format(
                            sql.SQL(", ").join([sql.Identifier(alias_name) for alias_name in selected_base_aliases])
                        )
                        + projected_sql
                        + sql.SQL(") AS {}").format(sql.Identifier("__dataset_projected_base"))
                    )
                    computed_params: list[Any] = []
                    current_field_alias_map = {alias_name: alias_name for alias_name in selected_base_aliases}
                    for item in computed:
                        if not isinstance(item, dict):
                            continue
                        raw_alias_name = str(item.get("alias") or "").strip()
                        if not raw_alias_name:
                            raise RuntimeError("Computed column alias is required")
                        alias_name = _normalize_projection_alias(raw_alias_name)
                        if alias_name in current_field_alias_map:
                            raise RuntimeError(f"Computed alias '{alias_name}' already exists in projected columns")
                        expr_sql = _compile_computed_expr_sql(
                            expr=item.get("expr"),
                            available_fields=current_field_alias_map,
                            params=computed_params,
                        )
                        stage_sql = (
                            sql.SQL("SELECT {}.*, {} AS {} FROM (").format(
                                sql.Identifier("__dataset_stage_prev"),
                                expr_sql,
                                sql.Identifier(alias_name),
                            )
                            + stage_sql
                            + sql.SQL(") AS {}").format(sql.Identifier("__dataset_stage_prev"))
                        )
                        current_field_alias_map[raw_alias_name] = alias_name
                        current_field_alias_map[alias_name] = alias_name

                    where_sql, where_params = _build_preprocess_filters_where_sql(
                        filters=filters,
                        field_alias_map=current_field_alias_map,
                    )
                    select_sql = (
                        sql.SQL("SELECT * FROM (")
                        + stage_sql
                        + sql.SQL(") AS {}").format(sql.Identifier("__dataset_projected_final"))
                        + sql.SQL(where_sql)
                    )
                    create_sql = sql.SQL("CREATE TABLE {}.{} AS ").format(
                        sql.Identifier(target_schema),
                        sql.Identifier(load_table_name),
                    ) + select_sql
                    all_params = computed_params + where_params
                    if all_params:
                        cur.execute(create_sql, all_params)
                    else:
                        cur.execute(create_sql)
                    cur.execute(
                        sql.SQL("SELECT COUNT(*) FROM {}.{}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(load_table_name),
                        )
                    )
                    count_row = cur.fetchone()
                    rows_written = int(count_row[0] or 0) if count_row else 0
                cardinality_updated = self._update_join_cardinality_actual(
                    conn=conn,
                    spec=spec,
                    joins=joins,
                    resolved_resources=resolved_resources,
                )
                conn.commit()
        finally:
            if staged_tables:
                self._drop_internal_tables(
                    internal_url=internal_url,
                    target_schema=target_schema,
                    table_names=staged_tables,
                )

        if rows_read_total == 0:
            rows_read_total = rows_written
        if cardinality_updated:
            dataset.base_query_spec = spec
        return rows_read_total, rows_written, bytes_processed_total

    def _drop_internal_tables(
        self,
        *,
        internal_url: str,
        target_schema: str,
        table_names: list[str],
    ) -> None:
        safe_internal_url = _to_psycopg_url(internal_url)
        try:
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    for table_name in table_names:
                        cur.execute(
                            sql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(table_name),
                            )
                        )
                conn.commit()
        except Exception:
            logger.exception(
                "failed to cleanup internal staging tables | schema=%s tables=%s",
                target_schema,
                ",".join(table_names),
            )

    def _copy_source_to_internal(
        self,
        *,
        source_url: str,
        internal_url: str,
        source_schema: str,
        source_relation: str,
        target_schema: str,
        load_table_name: str,
        source_columns: list[tuple[str, str]],
    ) -> tuple[int, int, int]:
        safe_source_url = _to_psycopg_url(source_url)
        safe_internal_url = _to_psycopg_url(internal_url)
        rows_read = 0
        rows_written = 0
        bytes_processed = 0

        column_identifiers = [sql.Identifier(column_name) for column_name, _ in source_columns]
        column_defs = [
            sql.SQL("{} {}").format(sql.Identifier(column_name), sql.SQL(column_type))
            for column_name, column_type in source_columns
        ]
        select_sql = sql.SQL("SELECT * FROM {}.{}").format(
            sql.Identifier(source_schema),
            sql.Identifier(source_relation),
        )
        insert_sql = sql.SQL("INSERT INTO {}.{} ({}) VALUES ({})").format(
            sql.Identifier(target_schema),
            sql.Identifier(load_table_name),
            sql.SQL(", ").join(column_identifiers),
            sql.SQL(", ").join([sql.Placeholder()] * len(source_columns)),
        )
        create_table_sql = sql.SQL("CREATE TABLE {}.{} ({})").format(
            sql.Identifier(target_schema),
            sql.Identifier(load_table_name),
            sql.SQL(", ").join(column_defs),
        )

        with psycopg.connect(safe_source_url) as source_conn:
            with psycopg.connect(safe_internal_url) as internal_conn:
                with source_conn.cursor() as source_cursor:
                    with internal_conn.cursor() as internal_cursor:
                        internal_cursor.execute(
                            sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(target_schema))
                        )
                        internal_cursor.execute(
                            sql.SQL("DROP TABLE IF EXISTS {}.{}").format(
                                sql.Identifier(target_schema),
                                sql.Identifier(load_table_name),
                            )
                        )
                        internal_cursor.execute(create_table_sql)
                        source_cursor.execute(select_sql)
                        while True:
                            batch = source_cursor.fetchmany(self._copy_batch_size)
                            if not batch:
                                break
                            rows_read += len(batch)
                            rows_written += len(batch)
                            for row in batch:
                                bytes_processed += sum(len(str(item)) for item in row if item is not None)
                            internal_cursor.executemany(insert_sql, batch)
                internal_conn.commit()

        return rows_read, rows_written, bytes_processed

    def _publish_stable_view(
        self,
        *,
        internal_url: str,
        target_schema: str,
        load_table_name: str,
        published_view_name: str,
    ) -> None:
        safe_internal_url = _to_psycopg_url(internal_url)
        drop_sql = sql.SQL("DROP VIEW IF EXISTS {}.{}").format(
            sql.Identifier(target_schema),
            sql.Identifier(published_view_name),
        )
        publish_sql = sql.SQL("CREATE VIEW {}.{} AS SELECT * FROM {}.{}").format(
            sql.Identifier(target_schema),
            sql.Identifier(published_view_name),
            sql.Identifier(target_schema),
            sql.Identifier(load_table_name),
        )
        with psycopg.connect(safe_internal_url) as conn:
            with conn.cursor() as cur:
                # Recreate to tolerate schema drift (renamed/reordered columns).
                cur.execute(drop_sql)
                cur.execute(publish_sql)
            conn.commit()

    def _upsert_internal_view_metadata(
        self,
        *,
        db: Session,
        internal_datasource_id: int,
        target_schema: str,
        published_view_name: str,
        source_columns: list[tuple[str, str]],
    ) -> int:
        view = (
            db.query(View)
            .filter(
                View.datasource_id == internal_datasource_id,
                View.schema_name == target_schema,
                View.view_name == published_view_name,
            )
            .first()
        )
        if view is None:
            view = View(
                datasource_id=internal_datasource_id,
                schema_name=target_schema,
                view_name=published_view_name,
                is_active=True,
            )
            db.add(view)
            db.flush()
        else:
            view.is_active = True

        db.query(ViewColumn).filter(ViewColumn.view_id == view.id).delete()
        for column_name, column_type in source_columns:
            normalized_type = normalize_column_type(column_type)
            is_numeric = normalized_type == "numeric"
            is_temporal = normalized_type == "temporal"
            db.add(
                ViewColumn(
                    view_id=int(view.id),
                    column_name=column_name,
                    column_type=column_type,
                    is_aggregatable=is_numeric,
                    is_filterable=True,
                    is_groupable=is_temporal or not is_numeric,
                )
            )
        db.flush()
        return int(view.id)
