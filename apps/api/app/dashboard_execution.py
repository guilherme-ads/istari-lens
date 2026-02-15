from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from time import perf_counter
from typing import Any

from fastapi import HTTPException
from psycopg.errors import UndefinedTable

from app.database import get_analytics_connection
from app.models import DashboardWidget, DataSource, User
from app.modules.query_execution.adapters.postgres import PostgresQueryRunnerAdapter
from app.modules.query_execution.domain.models import CompiledQuery, QueryExecutionContext
from app.query_builder import build_kpi_batch_query, build_widget_query
from app.schemas import DashboardWidgetDataResponse
from app.settings import get_settings
from app.widget_config import CompositeMetricConfig, FilterConfig, MetricConfig, WidgetConfig

logger = logging.getLogger("uvicorn.error")
settings = get_settings()


@dataclass(slots=True)
class WidgetExecutionMetadata:
    cache_hit: bool = False
    stale: bool = False
    deduped: bool = False
    batched: bool = False
    degraded: bool = False
    execution_time_ms: int = 0
    sql_hash: str | None = None
    source: str = "db"


@dataclass(slots=True)
class WidgetExecutionResult:
    widget_id: int
    payload: DashboardWidgetDataResponse
    metadata: WidgetExecutionMetadata


@dataclass(slots=True)
class DebugExecutionUnit:
    execution_kind: str
    widget_ids: list[int]
    sql: str
    params: list[Any]
    sql_hash: str
    fingerprint_key: str


@dataclass(slots=True)
class _WidgetPlan:
    widget: DashboardWidget
    config: WidgetConfig
    query_sql: str
    params: list[Any]
    cache_key: str
    sql_hash: str
    widget_type: str
    timeout_seconds: int


@dataclass(slots=True)
class _KpiBatchPlan:
    widgets: list[DashboardWidget]
    configs: list[WidgetConfig]
    metrics: list[MetricConfig]
    composite_metrics: list[CompositeMetricConfig]
    cache_keys: list[str]
    widget_types: list[str]
    timeout_seconds: int
    group_key: str
    view_name: str
    filters: list[FilterConfig]
    batch_kind: str


@dataclass(slots=True)
class _CacheEntry:
    payload: DashboardWidgetDataResponse
    created_at: datetime
    expires_at: datetime
    grace_expires_at: datetime
    failover_expires_at: datetime
    execution_time_ms: int
    sql_hash: str
    source: str


@dataclass(slots=True)
class _InflightCall:
    future: asyncio.Future[Any]
    expires_at: datetime


class DashboardExecutionMetrics:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._request_count: dict[str, int] = defaultdict(int)
        self._cache_hits: dict[str, int] = defaultdict(int)
        self._dedupe_avoided: int = 0
        self._kpi_batched: int = 0
        self._kpi_total: int = 0
        self._latencies: dict[str, list[int]] = defaultdict(list)

    async def record_widget(
        self,
        *,
        widget_type: str,
        cache_hit: bool,
        deduped: bool,
        execution_time_ms: int,
    ) -> None:
        async with self._lock:
            self._request_count[widget_type] += 1
            if cache_hit:
                self._cache_hits[widget_type] += 1
            if deduped:
                self._dedupe_avoided += 1
            values = self._latencies[widget_type]
            values.append(max(0, execution_time_ms))
            if len(values) > 2000:
                del values[0 : len(values) - 2000]

    async def record_kpi_batch(self, fused_count: int, total_count: int) -> None:
        async with self._lock:
            self._kpi_batched += max(0, fused_count)
            self._kpi_total += max(0, total_count)

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            cache_hit_rate: dict[str, float] = {}
            latency: dict[str, dict[str, int]] = {}
            for widget_type, total in self._request_count.items():
                hits = self._cache_hits[widget_type]
                cache_hit_rate[widget_type] = round((hits / total) if total else 0.0, 4)
                latency[widget_type] = _latency_summary(self._latencies[widget_type])

            return {
                "cache_hit_rate_by_widget_type": cache_hit_rate,
                "queries_avoided_by_dedupe": self._dedupe_avoided,
                "kpis_fused": self._kpi_batched,
                "kpis_total": self._kpi_total,
                "latency_ms_by_widget_type": latency,
            }


def _latency_summary(values: list[int]) -> dict[str, int]:
    if not values:
        return {"p50": 0, "p95": 0}
    ordered = sorted(values)
    return {
        "p50": ordered[max(0, int(len(ordered) * 0.50) - 1)],
        "p95": ordered[max(0, int(len(ordered) * 0.95) - 1)],
    }


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _normalize_filters_for_key(filters: list[FilterConfig]) -> list[dict[str, Any]]:
    normalized = [item.model_dump(mode="json") for item in filters]
    normalized.sort(key=_canonical_json)
    return normalized


def _normalize_sql_for_fingerprint(sql: str) -> str:
    collapsed = " ".join(sql.strip().split())
    lowered = collapsed.lower()
    lowered = re.sub(r'\bas\s+"[^"]+"', ' as "__alias__"', lowered)

    match = re.search(r"\\bwhere\\b (.+?)(?=\\bgroup by\\b|\\border by\\b|\\blimit\\b|\\boffset\\b|$)", lowered)
    if not match:
        return lowered

    where_clause = match.group(1)
    terms = [term.strip() for term in where_clause.split(" and ") if term.strip()]
    terms.sort()
    start, end = match.span(1)
    return lowered[:start] + " and ".join(terms) + lowered[end:]


def _sql_hash(sql: str) -> str:
    return hashlib.sha256(_normalize_sql_for_fingerprint(sql).encode("utf-8")).hexdigest()


def _extract_sql_limit(sql: str, default_limit: int = 1000) -> int:
    match = re.search(r"\blimit\s+(\d+)\b", sql, re.IGNORECASE)
    if not match:
        return default_limit
    try:
        return max(1, int(match.group(1)))
    except (TypeError, ValueError):
        return default_limit


def _fingerprint_key(
    *,
    datasource_id: int | None,
    dataset_id: int,
    widget_type: str,
    query_sql: str,
    params: list[Any],
    security_scope: dict[str, Any],
    runtime_filters: list[FilterConfig],
) -> str:
    payload = {
        "datasource_id": datasource_id,
        "dataset_id": dataset_id,
        "widget_type": widget_type,
        "sql_fingerprint": _sql_hash(query_sql),
        "params": json.loads(_canonical_json(params)),
        "security_scope": security_scope,
        "runtime_filters": _normalize_filters_for_key(runtime_filters),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _security_scope_for_user(user: User) -> dict[str, Any]:
    return {
        "tenant_id": getattr(user, "tenant_id", None),
        "user_id": user.id,
        "roles": ["ADMIN" if bool(getattr(user, "is_admin", False)) else "USER"],
        "row_level_scope": getattr(user, "row_level_scope", None),
    }


def _widget_ttl_seconds(widget_type: str, config: WidgetConfig) -> int:
    override_raw = None
    viz = getattr(config, "model_extra", None)
    if isinstance(viz, dict):
        override_raw = viz.get("cache_ttl_seconds")
    if override_raw is None:
        override_raw = getattr(config, "cache_ttl_seconds", None)
    if override_raw is not None:
        try:
            return max(1, int(override_raw))
        except (TypeError, ValueError):
            pass

    if widget_type == "kpi":
        return int(getattr(settings, "dashboard_widget_cache_ttl_kpi_seconds", 60))
    if widget_type in {"line", "bar"}:
        return int(getattr(settings, "dashboard_widget_cache_ttl_chart_seconds", 120))
    if widget_type == "table":
        return int(getattr(settings, "dashboard_widget_cache_ttl_table_seconds", 30))
    return int(getattr(settings, "dashboard_widget_cache_ttl_kpi_seconds", 60))


def _timeout_seconds(widget_type: str) -> int:
    if widget_type == "kpi":
        return int(getattr(settings, "dashboard_widget_timeout_kpi_seconds", 8))
    if widget_type in {"line", "bar"}:
        return int(getattr(settings, "dashboard_widget_timeout_chart_seconds", 15))
    if widget_type == "table":
        return int(getattr(settings, "dashboard_widget_timeout_table_seconds", 20))
    return int(getattr(settings, "dashboard_widget_timeout_kpi_seconds", 8))


def _is_batchable_kpi(config: WidgetConfig) -> bool:
    if config.widget_type != "kpi":
        return False
    if config.composite_metric is None and len(config.metrics) != 1:
        return False
    if config.dimensions or config.time is not None or config.order_by:
        return False
    if config.limit is not None or config.offset is not None:
        return False
    if config.columns:
        return False
    return True


class DashboardWidgetExecutionCoordinator:
    """
    Process-local execution coordinator for dashboard widgets.
    Cache is in-memory and isolated per app instance/process.
    """

    def __init__(self) -> None:
        self._cache_lock = asyncio.Lock()
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._cache_max_entries = int(getattr(settings, "dashboard_widget_cache_max_entries", 2000))
        self._cache_grace = int(getattr(settings, "dashboard_widget_cache_grace_seconds", 15))
        self._cache_failover = int(getattr(settings, "dashboard_widget_cache_failover_seconds", 300))

        self._inflight_lock = asyncio.Lock()
        self._inflight: dict[str, _InflightCall] = {}
        self._singleflight_ttl = int(getattr(settings, "dashboard_widget_singleflight_ttl_seconds", 30))

        self._metrics = DashboardExecutionMetrics()
        self._background_tasks: set[asyncio.Task[Any]] = set()

    async def reset_state_for_tests(self) -> None:
        async with self._cache_lock:
            self._cache.clear()
        async with self._inflight_lock:
            self._inflight.clear()
        for task in list(self._background_tasks):
            task.cancel()
        self._background_tasks.clear()

    async def execute_widgets(
        self,
        *,
        dashboard_id: int,
        dataset_id: int,
        datasource: DataSource | None,
        widgets: list[DashboardWidget],
        configs_by_widget_id: dict[int, WidgetConfig],
        user: User,
        runtime_filters: list[FilterConfig],
    ) -> dict[int, WidgetExecutionResult]:
        security_scope = _security_scope_for_user(user)
        semaphore = asyncio.Semaphore(int(getattr(settings, "dashboard_widget_render_concurrency_limit", 6)))
        results: dict[int, WidgetExecutionResult] = {}

        executable_plans: list[_WidgetPlan] = []
        stale_fallbacks: dict[int, _CacheEntry] = {}

        for widget in widgets:
            config = configs_by_widget_id[widget.id]
            if config.widget_type == "text":
                results[widget.id] = WidgetExecutionResult(
                    widget_id=widget.id,
                    payload=DashboardWidgetDataResponse(columns=[], rows=[], row_count=0),
                    metadata=WidgetExecutionMetadata(source="text"),
                )
                continue

            query_sql, params = build_widget_query(config)
            sql_hash = _sql_hash(query_sql)
            key = _fingerprint_key(
                datasource_id=datasource.id if datasource else None,
                dataset_id=dataset_id,
                widget_type=config.widget_type,
                query_sql=query_sql,
                params=params,
                security_scope=security_scope,
                runtime_filters=runtime_filters,
            )

            plan = _WidgetPlan(
                widget=widget,
                config=config,
                query_sql=query_sql,
                params=params,
                cache_key=key,
                sql_hash=sql_hash,
                widget_type=config.widget_type,
                timeout_seconds=_timeout_seconds(config.widget_type),
            )

            cache_status, cache_entry = await self._cache_get(plan.cache_key)
            if cache_status == "hit" and cache_entry:
                results[widget.id] = self._result_from_cache(widget.id, cache_entry, stale=False)
                continue
            if cache_status == "stale" and cache_entry:
                results[widget.id] = self._result_from_cache(widget.id, cache_entry, stale=True)
                await self._schedule_async_refresh(
                    plan=plan,
                    datasource=datasource,
                    dashboard_id=dashboard_id,
                    dataset_id=dataset_id,
                    user=user,
                )
                continue
            if cache_entry:
                stale_fallbacks[widget.id] = cache_entry

            executable_plans.append(plan)

        if executable_plans:
            batch_groups, single_plans = self._build_kpi_batch_groups(
                plans=executable_plans,
                datasource=datasource,
                dataset_id=dataset_id,
                security_scope=security_scope,
                runtime_filters=runtime_filters,
            )

            fused_kpis = sum(len(group.widgets) for group in batch_groups)
            await self._metrics.record_kpi_batch(fused_count=fused_kpis, total_count=len(executable_plans))

            unique_single_plans: list[_WidgetPlan] = []
            duplicate_single_plans: dict[str, list[_WidgetPlan]] = defaultdict(list)
            for plan in single_plans:
                if plan.cache_key in duplicate_single_plans:
                    duplicate_single_plans[plan.cache_key].append(plan)
                    continue
                duplicate_single_plans[plan.cache_key] = []
                unique_single_plans.append(plan)

            task_results = await asyncio.gather(
                *[
                    self._execute_kpi_batch_group(
                        group=group,
                        semaphore=semaphore,
                        datasource=datasource,
                        dashboard_id=dashboard_id,
                        dataset_id=dataset_id,
                        user=user,
                        stale_fallbacks=stale_fallbacks,
                    )
                    for group in batch_groups
                ],
                *[
                    self._execute_single_plan(
                        plan=plan,
                        semaphore=semaphore,
                        datasource=datasource,
                        dashboard_id=dashboard_id,
                        dataset_id=dataset_id,
                        user=user,
                        stale_fallback=stale_fallbacks.get(plan.widget.id),
                    )
                    for plan in unique_single_plans
                ],
            )

            single_result_by_key: dict[str, WidgetExecutionResult] = {}
            for plan in unique_single_plans:
                if plan.widget.id in results:
                    continue
                # Filled below from task_results.

            for chunk in task_results:
                for item in chunk:
                    results[item.widget_id] = item
                    for plan in unique_single_plans:
                        if plan.widget.id == item.widget_id:
                            single_result_by_key[plan.cache_key] = item
                            break

            for cache_key, duplicate_plans in duplicate_single_plans.items():
                if not duplicate_plans:
                    continue
                base = single_result_by_key.get(cache_key)
                if base is None:
                    continue
                for duplicate_plan in duplicate_plans:
                    results[duplicate_plan.widget.id] = WidgetExecutionResult(
                        widget_id=duplicate_plan.widget.id,
                        payload=base.payload.model_copy(deep=True),
                        metadata=WidgetExecutionMetadata(
                            cache_hit=base.metadata.cache_hit,
                            stale=base.metadata.stale,
                            deduped=True,
                            batched=base.metadata.batched,
                            degraded=base.metadata.degraded,
                            execution_time_ms=base.metadata.execution_time_ms,
                            sql_hash=base.metadata.sql_hash,
                            source=base.metadata.source,
                        ),
                    )

        for widget in widgets:
            if widget.id not in results:
                raise HTTPException(status_code=500, detail=f"Missing widget execution result for widget {widget.id}")
            await self._log_widget_execution(
                dashboard_id=dashboard_id,
                widget_id=widget.id,
                dataset_id=dataset_id,
                widget_type=configs_by_widget_id[widget.id].widget_type,
                metadata=results[widget.id].metadata,
            )

        snapshot = await self._metrics.snapshot()
        logger.info("dashboard_execution_metrics | %s", snapshot)

        return results

    def preview_final_execution_units(
        self,
        *,
        datasource: DataSource | None,
        dataset_id: int,
        widgets: list[DashboardWidget],
        configs_by_widget_id: dict[int, WidgetConfig],
        user: User,
        runtime_filters: list[FilterConfig],
    ) -> list[DebugExecutionUnit]:
        security_scope = _security_scope_for_user(user)
        plans: list[_WidgetPlan] = []
        for widget in widgets:
            config = configs_by_widget_id[widget.id]
            if config.widget_type == "text":
                continue
            query_sql, params = build_widget_query(config)
            plans.append(
                _WidgetPlan(
                    widget=widget,
                    config=config,
                    query_sql=query_sql,
                    params=params,
                    cache_key=_fingerprint_key(
                        datasource_id=datasource.id if datasource else None,
                        dataset_id=dataset_id,
                        widget_type=config.widget_type,
                        query_sql=query_sql,
                        params=params,
                        security_scope=security_scope,
                        runtime_filters=runtime_filters,
                    ),
                    sql_hash=_sql_hash(query_sql),
                    widget_type=config.widget_type,
                    timeout_seconds=_timeout_seconds(config.widget_type),
                )
            )

        batch_groups, single_plans = self._build_kpi_batch_groups(
            plans=plans,
            datasource=datasource,
            dataset_id=dataset_id,
            security_scope=security_scope,
            runtime_filters=runtime_filters,
        )

        units: list[DebugExecutionUnit] = []
        for group in batch_groups:
            sql, params, _aliases = build_kpi_batch_query(
                group.view_name,
                group.metrics,
                group.filters,
                composite_metrics=group.composite_metrics or None,
            )
            unit_key = hashlib.sha256(f"kpi_batch:{group.group_key}".encode("utf-8")).hexdigest()
            units.append(
                DebugExecutionUnit(
                    execution_kind="kpi_batched",
                    widget_ids=[widget.id for widget in group.widgets],
                    sql=sql,
                    params=params,
                    sql_hash=_sql_hash(sql),
                    fingerprint_key=unit_key,
                )
            )

        deduped: OrderedDict[str, list[_WidgetPlan]] = OrderedDict()
        for plan in single_plans:
            deduped.setdefault(plan.cache_key, []).append(plan)

        for cache_key, group in deduped.items():
            head = group[0]
            units.append(
                DebugExecutionUnit(
                    execution_kind="deduped" if len(group) > 1 else "single",
                    widget_ids=[item.widget.id for item in group],
                    sql=head.query_sql,
                    params=head.params,
                    sql_hash=head.sql_hash,
                    fingerprint_key=cache_key,
                )
            )

        return units

    async def _cache_get(self, cache_key: str) -> tuple[str, _CacheEntry | None]:
        now = _utcnow()
        async with self._cache_lock:
            entry = self._cache.get(cache_key)
            if not entry:
                return "miss", None

            self._cache.move_to_end(cache_key)
            if now <= entry.expires_at:
                return "hit", entry
            if now <= entry.grace_expires_at:
                return "stale", entry
            if now <= entry.failover_expires_at:
                return "failover", entry

            self._cache.pop(cache_key, None)
            return "miss", None

    async def _cache_set(
        self,
        *,
        cache_key: str,
        payload: DashboardWidgetDataResponse,
        widget_type: str,
        execution_time_ms: int,
        sql_hash: str,
        source: str,
        config: WidgetConfig,
    ) -> None:
        now = _utcnow()
        ttl = _widget_ttl_seconds(widget_type, config)
        entry = _CacheEntry(
            payload=payload.model_copy(deep=True),
            created_at=now,
            expires_at=now + timedelta(seconds=ttl),
            grace_expires_at=now + timedelta(seconds=ttl + self._cache_grace),
            failover_expires_at=now + timedelta(seconds=ttl + self._cache_grace + self._cache_failover),
            execution_time_ms=execution_time_ms,
            sql_hash=sql_hash,
            source=source,
        )

        async with self._cache_lock:
            self._cache[cache_key] = entry
            self._cache.move_to_end(cache_key)
            while len(self._cache) > self._cache_max_entries:
                self._cache.popitem(last=False)

    async def _singleflight(self, key: str, producer: Any) -> tuple[Any, bool]:
        now = _utcnow()
        loop = asyncio.get_running_loop()

        async with self._inflight_lock:
            call = self._inflight.get(key)
            if call and call.expires_at > now and not call.future.done():
                future = call.future
                deduped = True
            else:
                future = loop.create_future()
                self._inflight[key] = _InflightCall(
                    future=future,
                    expires_at=now + timedelta(seconds=self._singleflight_ttl),
                )
                deduped = False

        if deduped:
            result = await future
            return result, True

        try:
            result = await producer()
            if not future.done():
                future.set_result(result)
            return result, False
        except Exception as exc:
            if not future.done():
                future.set_exception(exc)
            raise
        finally:
            async with self._inflight_lock:
                current = self._inflight.get(key)
                if current and current.future is future:
                    self._inflight.pop(key, None)

    def _build_kpi_batch_groups(
        self,
        *,
        plans: list[_WidgetPlan],
        datasource: DataSource | None,
        dataset_id: int,
        security_scope: dict[str, Any],
        runtime_filters: list[FilterConfig],
    ) -> tuple[list[_KpiBatchPlan], list[_WidgetPlan]]:
        grouped: dict[str, list[_WidgetPlan]] = defaultdict(list)
        singles: list[_WidgetPlan] = []

        for plan in plans:
            if not _is_batchable_kpi(plan.config):
                singles.append(plan)
                continue

            filters = _normalize_filters_for_key(plan.config.filters)
            batch_kind = "composite" if plan.config.composite_metric is not None else "simple"
            group_scope = {
                "datasource_id": datasource.id if datasource else None,
                "dataset_id": dataset_id,
                "security_scope": security_scope,
                "view_name": plan.config.view_name,
                "filters": filters,
                "runtime_filters": _normalize_filters_for_key(runtime_filters),
                "batch_kind": batch_kind,
            }
            if batch_kind == "composite":
                composite_metric = plan.config.composite_metric
                if composite_metric is None:
                    singles.append(plan)
                    continue
                group_scope["composite_bucket"] = {
                    "time_column": composite_metric.time_column,
                    "granularity": composite_metric.granularity,
                }
            group_key = hashlib.sha256(_canonical_json(group_scope).encode("utf-8")).hexdigest()
            grouped[group_key].append(plan)

        batch_groups: list[_KpiBatchPlan] = []
        for group_key, group_plans in grouped.items():
            if len(group_plans) < 2:
                singles.extend(group_plans)
                continue

            batch_groups.append(
                _KpiBatchPlan(
                    widgets=[plan.widget for plan in group_plans],
                    configs=[plan.config for plan in group_plans],
                    metrics=[plan.config.metrics[0] for plan in group_plans if plan.config.composite_metric is None],
                    composite_metrics=[
                        plan.config.composite_metric for plan in group_plans if plan.config.composite_metric is not None
                    ],
                    cache_keys=[plan.cache_key for plan in group_plans],
                    widget_types=[plan.widget_type for plan in group_plans],
                    timeout_seconds=max(plan.timeout_seconds for plan in group_plans),
                    group_key=group_key,
                    view_name=group_plans[0].config.view_name,
                    filters=group_plans[0].config.filters,
                    batch_kind="composite" if group_plans[0].config.composite_metric is not None else "simple",
                )
            )

        return batch_groups, singles

    async def _execute_kpi_batch_group(
        self,
        *,
        group: _KpiBatchPlan,
        semaphore: asyncio.Semaphore,
        datasource: DataSource | None,
        dashboard_id: int,
        dataset_id: int,
        user: User,
        stale_fallbacks: dict[int, _CacheEntry],
    ) -> list[WidgetExecutionResult]:
        query_sql, params, aliases = build_kpi_batch_query(
            group.view_name,
            group.metrics,
            group.filters,
            composite_metrics=group.composite_metrics or None,
        )
        sql_hash = _sql_hash(query_sql)

        async def _producer() -> tuple[list[dict[str, Any]], int]:
            async with semaphore:
                started = perf_counter()
                rows = await asyncio.wait_for(
                    self._run_query(
                        query_sql=query_sql,
                        params=params,
                        datasource=datasource,
                        dashboard_id=dashboard_id,
                        widget_id=0,
                        dataset_id=dataset_id,
                        user=user,
                        timeout_seconds=group.timeout_seconds,
                    ),
                    timeout=group.timeout_seconds,
                )
                elapsed = max(0, int((perf_counter() - started) * 1000))
                return rows, elapsed

        try:
            (rows, elapsed_ms), deduped = await self._singleflight(f"kpi_batch:{group.group_key}", _producer)
        except HTTPException:
            recovered: list[WidgetExecutionResult] = []
            for widget in group.widgets:
                fallback = stale_fallbacks.get(widget.id)
                if fallback is None:
                    raise
                recovered.append(
                    WidgetExecutionResult(
                        widget_id=widget.id,
                        payload=fallback.payload.model_copy(deep=True),
                        metadata=WidgetExecutionMetadata(
                            cache_hit=True,
                            stale=True,
                            deduped=False,
                            batched=True,
                            degraded=True,
                            execution_time_ms=fallback.execution_time_ms,
                            sql_hash=fallback.sql_hash,
                            source="stale",
                        ),
                    )
                )
            return recovered

        row = rows[0] if rows else {}
        results: list[WidgetExecutionResult] = []
        for idx, widget in enumerate(group.widgets):
            alias = aliases[idx]
            value = row.get(alias)
            payload = DashboardWidgetDataResponse(columns=["m0"], rows=[{"m0": value}], row_count=1)
            await self._cache_set(
                cache_key=group.cache_keys[idx],
                payload=payload,
                widget_type=group.widget_types[idx],
                execution_time_ms=elapsed_ms,
                sql_hash=sql_hash,
                source="db",
                config=group.configs[idx],
            )
            metadata = WidgetExecutionMetadata(
                cache_hit=False,
                stale=False,
                deduped=deduped,
                batched=True,
                degraded=False,
                execution_time_ms=elapsed_ms,
                sql_hash=sql_hash,
                source="db",
            )
            result = WidgetExecutionResult(widget_id=widget.id, payload=payload, metadata=metadata)
            results.append(result)

        return results

    async def _execute_single_plan(
        self,
        *,
        plan: _WidgetPlan,
        semaphore: asyncio.Semaphore,
        datasource: DataSource | None,
        dashboard_id: int,
        dataset_id: int,
        user: User,
        stale_fallback: _CacheEntry | None,
    ) -> list[WidgetExecutionResult]:
        async def _producer() -> tuple[DashboardWidgetDataResponse, int]:
            async with semaphore:
                started = perf_counter()
                rows = await asyncio.wait_for(
                    self._run_query(
                        query_sql=plan.query_sql,
                        params=plan.params,
                        datasource=datasource,
                        dashboard_id=dashboard_id,
                        widget_id=plan.widget.id,
                        dataset_id=dataset_id,
                        user=user,
                        timeout_seconds=plan.timeout_seconds,
                    ),
                    timeout=plan.timeout_seconds,
                )
                elapsed = max(0, int((perf_counter() - started) * 1000))
                payload = DashboardWidgetDataResponse(
                    columns=list(rows[0].keys()) if rows else [],
                    rows=rows,
                    row_count=len(rows),
                )
                await self._cache_set(
                    cache_key=plan.cache_key,
                    payload=payload,
                    widget_type=plan.widget_type,
                    execution_time_ms=elapsed,
                    sql_hash=plan.sql_hash,
                    source="db",
                    config=plan.config,
                )
                return payload, elapsed

        try:
            (payload, elapsed_ms), deduped = await self._singleflight(plan.cache_key, _producer)
            metadata = WidgetExecutionMetadata(
                cache_hit=False,
                stale=False,
                deduped=deduped,
                batched=False,
                degraded=False,
                execution_time_ms=elapsed_ms,
                sql_hash=plan.sql_hash,
                source="db",
            )
        except HTTPException:
            if stale_fallback is None:
                raise
            payload = stale_fallback.payload.model_copy(deep=True)
            metadata = WidgetExecutionMetadata(
                cache_hit=True,
                stale=True,
                deduped=False,
                batched=False,
                degraded=True,
                execution_time_ms=stale_fallback.execution_time_ms,
                sql_hash=stale_fallback.sql_hash,
                source="stale",
            )

        result = WidgetExecutionResult(widget_id=plan.widget.id, payload=payload, metadata=metadata)
        return [result]

    async def _schedule_async_refresh(
        self,
        *,
        plan: _WidgetPlan,
        datasource: DataSource | None,
        dashboard_id: int,
        dataset_id: int,
        user: User,
    ) -> None:
        async def _refresh() -> None:
            try:
                async def _producer() -> tuple[DashboardWidgetDataResponse, int]:
                    started = perf_counter()
                    rows = await self._run_query(
                        query_sql=plan.query_sql,
                        params=plan.params,
                        datasource=datasource,
                        dashboard_id=dashboard_id,
                        widget_id=plan.widget.id,
                        dataset_id=dataset_id,
                        user=user,
                        timeout_seconds=_timeout_seconds(plan.widget_type),
                    )
                    elapsed = max(0, int((perf_counter() - started) * 1000))
                    payload = DashboardWidgetDataResponse(
                        columns=list(rows[0].keys()) if rows else [],
                        rows=rows,
                        row_count=len(rows),
                    )
                    await self._cache_set(
                        cache_key=plan.cache_key,
                        payload=payload,
                        widget_type=plan.widget_type,
                        execution_time_ms=elapsed,
                        sql_hash=plan.sql_hash,
                        source="db",
                        config=plan.config,
                    )
                    return payload, elapsed

                await self._singleflight(plan.cache_key, _producer)
            except Exception as exc:
                logger.warning(
                    "dashboard_widget_stale_refresh_failed | %s",
                    {
                        "dashboard_id": dashboard_id,
                        "widget_id": plan.widget.id,
                        "dataset_id": dataset_id,
                        "sql_hash": plan.sql_hash,
                        "error": repr(exc),
                    },
                )

        task = asyncio.create_task(_refresh())
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def _run_query(
        self,
        *,
        query_sql: str,
        params: list[Any],
        datasource: DataSource | None,
        dashboard_id: int,
        widget_id: int,
        dataset_id: int,
        user: User,
        timeout_seconds: int,
    ) -> list[dict[str, Any]]:
        try:
            runner = PostgresQueryRunnerAdapter(analytics_connection_factory=get_analytics_connection)
            result_set = await runner.run(
                compiled=CompiledQuery(
                    sql=query_sql,
                    params=params,
                    row_limit=_extract_sql_limit(query_sql, default_limit=1000),
                ),
                datasource=datasource,
                context=QueryExecutionContext(
                    operation=f"dashboard_widget:{dashboard_id}:{widget_id}",
                    user_id=user.id,
                    tenant_id=getattr(user, "tenant_id", None),
                    dataset_id=dataset_id,
                    datasource_id=datasource.id if datasource else None,
                ),
                timeout_seconds=timeout_seconds,
            )
            return result_set.rows
        except UndefinedTable as exc:
            raise HTTPException(status_code=400, detail=f"Dataset view was not found: {repr(exc)}") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Widget query execution failed: {repr(exc)}") from exc

    def _result_from_cache(self, widget_id: int, entry: _CacheEntry, stale: bool) -> WidgetExecutionResult:
        metadata = WidgetExecutionMetadata(
            cache_hit=True,
            stale=stale,
            deduped=False,
            batched=False,
            degraded=False,
            execution_time_ms=entry.execution_time_ms,
            sql_hash=entry.sql_hash,
            source="stale" if stale else "cache",
        )
        return WidgetExecutionResult(
            widget_id=widget_id,
            payload=entry.payload.model_copy(deep=True),
            metadata=metadata,
        )

    async def _log_widget_execution(
        self,
        *,
        dashboard_id: int,
        widget_id: int,
        dataset_id: int,
        widget_type: str,
        metadata: WidgetExecutionMetadata,
    ) -> None:
        await self._metrics.record_widget(
            widget_type=widget_type,
            cache_hit=metadata.cache_hit,
            deduped=metadata.deduped,
            execution_time_ms=metadata.execution_time_ms,
        )
        if settings.environment != "production":
            logger.info(
                "dashboard_widget_execution | %s",
                {
                    "dashboard_id": dashboard_id,
                    "widget_id": widget_id,
                    "dataset_id": dataset_id,
                    "cache_status": metadata.source,
                    "sql_hash": metadata.sql_hash,
                    "execution_time_ms": metadata.execution_time_ms,
                    "deduped": metadata.deduped,
                    "batched": metadata.batched,
                    "stale": metadata.stale,
                    "degraded": metadata.degraded,
                },
            )


_dashboard_widget_executor = DashboardWidgetExecutionCoordinator()


def get_dashboard_widget_executor() -> DashboardWidgetExecutionCoordinator:
    return _dashboard_widget_executor
