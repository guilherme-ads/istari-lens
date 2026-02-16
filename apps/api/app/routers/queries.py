import asyncio
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, View, Dataset
from app.modules.query_execution import PostgresQueryCompilerAdapter, PostgresQueryRunnerAdapter, QueryExecutionService
from app.modules.query_execution.domain.models import QueryExecutionContext
from app.schemas import (
    QuerySpec,
    QueryPreviewResponse,
    QueryPreviewBatchRequest,
    QueryPreviewBatchResponse,
    QueryPreviewBatchItemResponse,
)
from app.dependencies import get_current_user
from app.settings import get_settings

router = APIRouter(prefix="/query", tags=["query"])
settings = get_settings()
CACHE_TTL_SECONDS = int(getattr(settings, "query_preview_cache_ttl_seconds", 60))
MAX_CACHE_ENTRIES = int(getattr(settings, "query_preview_cache_max_entries", 500))
_query_execution = QueryExecutionService(PostgresQueryCompilerAdapter(), PostgresQueryRunnerAdapter())


@dataclass
class CachedQueryResult:
    columns: list[str]
    rows: list[dict]
    row_count: int
    expires_at: datetime


_query_cache: dict[str, CachedQueryResult] = {}
_query_cache_lock = asyncio.Lock()


async def validate_query_spec(spec: QuerySpec, view: View, db: Session) -> None:
    """Validate that query spec is compatible with view metadata"""
    
    # Get view columns
    columns = {col.column_name: col for col in view.columns}
    
    # Validate metrics
    for metric in spec.metrics:
        if metric.agg == "count" and metric.field == "*":
            continue
        if metric.field not in columns:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{metric.field}' not found in view"
            )
        col = columns[metric.field]
        if not col.is_aggregatable and metric.agg != "count":
            raise HTTPException(
                status_code=400,
                detail=f"Column '{metric.field}' cannot be aggregated with {metric.agg}"
            )
    
    # Validate dimensions
    for dimension in spec.dimensions:
        if dimension not in columns:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{dimension}' not found in view"
            )
        col = columns[dimension]
        if not col.is_groupable:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{dimension}' cannot be used as dimension"
            )
    
    # Validate filters
    for filter_spec in spec.filters:
        if filter_spec.field not in columns:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{filter_spec.field}' not found in view"
            )
        if not columns[filter_spec.field].is_filterable:
            raise HTTPException(
                status_code=400,
                detail=f"Column '{filter_spec.field}' cannot be filtered"
            )


def build_query_sql(spec: QuerySpec, view: View) -> tuple:
    """Build parameterized SQL from query spec."""

    select_parts = []
    params = []

    for dimension in spec.dimensions:
        select_parts.append(dimension)

    for metric in spec.metrics:
        agg_func = metric.agg.upper()
        if agg_func == "DISTINCT_COUNT":
            select_parts.append(f"COUNT(DISTINCT {metric.field})")
        elif agg_func == "COUNT" and metric.field == "*":
            select_parts.append("COUNT(*)")
        else:
            select_parts.append(f"{agg_func}({metric.field})")

    select_clause = ", ".join(select_parts)
    from_clause = f"{view.schema_name}.{view.view_name}"

    where_parts = []
    for filter_spec in spec.filters:
        if filter_spec.op == "eq":
            where_parts.append(f"{filter_spec.field} = %s")
            params.append(filter_spec.value[0] if isinstance(filter_spec.value, list) else filter_spec.value)
        elif filter_spec.op == "neq":
            where_parts.append(f"{filter_spec.field} != %s")
            params.append(filter_spec.value[0] if isinstance(filter_spec.value, list) else filter_spec.value)
        elif filter_spec.op == "in":
            placeholders = ", ".join(["%s"] * len(filter_spec.value))
            where_parts.append(f"{filter_spec.field} IN ({placeholders})")
            params.extend(filter_spec.value)
        elif filter_spec.op == "not_in":
            placeholders = ", ".join(["%s"] * len(filter_spec.value))
            where_parts.append(f"{filter_spec.field} NOT IN ({placeholders})")
            params.extend(filter_spec.value)
        elif filter_spec.op == "contains":
            where_parts.append(f"{filter_spec.field}::text ILIKE %s")
            value = filter_spec.value[0] if isinstance(filter_spec.value, list) else filter_spec.value
            params.append(f"%{value}%")
        elif filter_spec.op == "gte":
            where_parts.append(f"{filter_spec.field} >= %s")
            params.append(filter_spec.value[0] if isinstance(filter_spec.value, list) else filter_spec.value)
        elif filter_spec.op == "lte":
            where_parts.append(f"{filter_spec.field} <= %s")
            params.append(filter_spec.value[0] if isinstance(filter_spec.value, list) else filter_spec.value)
        elif filter_spec.op == "is_null":
            where_parts.append(f"{filter_spec.field} IS NULL")
        elif filter_spec.op == "not_null":
            where_parts.append(f"{filter_spec.field} IS NOT NULL")

    query_parts = [f"SELECT {select_clause}", f"FROM {from_clause}"]

    if where_parts:
        query_parts.append("WHERE " + " AND ".join(where_parts))

    if spec.dimensions:
        group_by = ", ".join(spec.dimensions)
        query_parts.append(f"GROUP BY {group_by}")

    if spec.sort:
        order_parts = []
        for sort_spec in spec.sort:
            direction = "ASC" if sort_spec.dir.lower() == "asc" else "DESC"
            order_parts.append(f"{sort_spec.field} {direction}")
        query_parts.append("ORDER BY " + ", ".join(order_parts))

    limit = min(spec.limit, 5000)
    query_parts.append(f"LIMIT {limit}")

    if spec.offset and spec.offset > 0:
        query_parts.append(f"OFFSET {spec.offset}")

    query_sql = " ".join(query_parts)

    return query_sql, params


def _cache_key_for_spec(spec: QuerySpec) -> str:
    raw_spec = spec.model_dump(mode="json", exclude={"visualization"})
    canonical = json.dumps(raw_spec, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _cache_get(cache_key: str) -> CachedQueryResult | None:
    now = datetime.now(timezone.utc)
    async with _query_cache_lock:
        entry = _query_cache.get(cache_key)
        if not entry:
            return None
        if entry.expires_at <= now:
            _query_cache.pop(cache_key, None)
            return None
        return entry


async def _cache_set(cache_key: str, payload: QueryPreviewResponse) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=CACHE_TTL_SECONDS)
    entry = CachedQueryResult(
        columns=payload.columns,
        rows=payload.rows,
        row_count=payload.row_count,
        expires_at=expires_at,
    )

    async with _query_cache_lock:
        now = datetime.now(timezone.utc)
        expired_keys = [key for key, value in _query_cache.items() if value.expires_at <= now]
        for key in expired_keys:
            _query_cache.pop(key, None)

        if len(_query_cache) >= MAX_CACHE_ENTRIES:
            oldest_key = min(_query_cache, key=lambda key: _query_cache[key].expires_at)
            _query_cache.pop(oldest_key, None)

        _query_cache[cache_key] = entry


def _validate_dataset_and_view(spec: QuerySpec, db: Session) -> View:
    dataset = db.query(Dataset).filter(Dataset.id == spec.datasetId).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    if not dataset.is_active:
        raise HTTPException(status_code=400, detail="Dataset is inactive")

    view = dataset.view
    if not view or not view.is_active:
        raise HTTPException(status_code=400, detail="Dataset view is inactive")

    return view


async def execute_preview_query(spec: QuerySpec, db: Session, current_user: User) -> QueryPreviewResponse:
    view = _validate_dataset_and_view(spec, db)
    await validate_query_spec(spec, view, db)
    dataset = db.query(Dataset).filter(Dataset.id == spec.datasetId).first()
    try:
        query_sql, params = build_query_sql(spec, view)
        result_set = await _query_execution.execute_compiled(
            sql=query_sql,
            params=params,
            datasource=dataset.datasource if dataset else None,
            context=QueryExecutionContext(
                operation=f"query_preview:dataset:{spec.datasetId}",
                user_id=current_user.id,
                tenant_id=getattr(current_user, "tenant_id", None),
                dataset_id=spec.datasetId,
                datasource_id=dataset.datasource_id if dataset else None,
            ),
            timeout_seconds=int(getattr(settings, "query_timeout_seconds", 20)),
            row_limit=min(spec.limit, 5000),
        )
        return QueryPreviewResponse(
            columns=result_set.columns,
            rows=result_set.rows,
            row_count=result_set.row_count,
        )
    except HTTPException:
        raise


async def _get_or_execute_preview(spec: QuerySpec, db: Session, current_user: User) -> tuple[QueryPreviewResponse, bool]:
    cache_key = _cache_key_for_spec(spec)
    cached = await _cache_get(cache_key)
    if cached:
        return (
            QueryPreviewResponse(
                columns=cached.columns,
                rows=cached.rows,
                row_count=cached.row_count,
            ),
            True,
        )

    payload = await execute_preview_query(spec, db, current_user)
    await _cache_set(cache_key, payload)
    return payload, False


@router.post("/preview", response_model=QueryPreviewResponse)
async def preview_query(
    spec: QuerySpec,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Execute query and return preview data"""
    try:
        payload, _cache_hit = await _get_or_execute_preview(spec, db, current_user)
        return payload
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query execution failed: {str(e)}")


@router.post("/preview/batch", response_model=QueryPreviewBatchResponse)
async def preview_query_batch(
    request: QueryPreviewBatchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute a batch of query previews with deduplication and shared cache."""

    if not request.queries:
        return QueryPreviewBatchResponse(results=[])

    try:
        dedup_payloads: dict[str, tuple[QueryPreviewResponse, bool]] = {}
        dedup_errors: dict[str, HTTPException] = {}
        item_keys: list[tuple[str, str]] = []

        for item in request.queries:
            cache_key = _cache_key_for_spec(item.spec)
            item_keys.append((item.widget_id, cache_key))

            if cache_key in dedup_payloads or cache_key in dedup_errors:
                continue

            try:
                payload, cache_hit = await _get_or_execute_preview(item.spec, db, current_user)
                dedup_payloads[cache_key] = (payload, cache_hit)
            except HTTPException as exc:
                dedup_errors[cache_key] = exc

        results: list[QueryPreviewBatchItemResponse] = []
        for widget_id, cache_key in item_keys:
            if cache_key in dedup_errors:
                raise dedup_errors[cache_key]
            payload, cache_hit = dedup_payloads[cache_key]
            results.append(
                QueryPreviewBatchItemResponse(
                    widget_id=widget_id,
                    columns=payload.columns,
                    rows=payload.rows,
                    row_count=payload.row_count,
                    cache_hit=cache_hit,
                )
            )

        return QueryPreviewBatchResponse(results=results)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch query execution failed: {str(e)}")
