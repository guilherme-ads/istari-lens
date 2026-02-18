from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from time import perf_counter
from typing import Any

from app.datasources.postgres import PostgresAdapter, sql_hash
from app.errors import EngineError
from app.schemas import BatchQueryResponse, BatchQueryResultItem, QueryResult, QuerySpec, ResourceList, SchemaDefinition
from app.services.canonicalizer import build_query_keys
from app.services.compiler import compile_query
from app.services.query_fusion_planner import QueryFusionGroup, QueryFusionPlanner
from app.settings import Settings

logger = logging.getLogger("uvicorn.error")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _redact_datasource_id(datasource_url: str) -> str:
    if "://" not in datasource_url or "@" not in datasource_url:
        return datasource_url

    scheme, remainder = datasource_url.split("://", 1)
    if "@" not in remainder:
        return datasource_url

    credentials, location = remainder.rsplit("@", 1)
    if not credentials:
        return datasource_url

    if ":" in credentials:
        username, _password = credentials.split(":", 1)
        safe_credentials = f"{username}:***"
    else:
        safe_credentials = "***"

    return f"{scheme}://{safe_credentials}@{location}"


@dataclass(slots=True)
class _CacheEntry:
    result: QueryResult
    expires_at: datetime


@dataclass(slots=True)
class _Inflight:
    future: asyncio.Future[QueryResult]
    expires_at: datetime


@dataclass(slots=True)
class _PreparedSpec:
    original: QuerySpec
    normalized: QuerySpec
    dedupe_key: str
    cache_key: str


@dataclass(slots=True)
class _DedupeGroup:
    representative_index: int
    member_indexes: list[int]
    item: _PreparedSpec


@dataclass(slots=True)
class _GroupExecutionOutcome:
    results_by_index: dict[int, QueryResult]
    executed_count: int
    cache_hit_count: int
    fused_groups_count: int
    metrics_per_group: list[int]


class QueryPipeline:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._fusion_planner = QueryFusionPlanner()
        self._cache: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._cache_lock = asyncio.Lock()
        self._inflight: dict[str, _Inflight] = {}
        self._inflight_lock = asyncio.Lock()

    async def execute(self, *, spec: QuerySpec, datasource_url: str, correlation_id: str | None = None) -> QueryResult:
        batch = await self.execute_batch(
            specs=[(None, spec)],
            datasource_url=datasource_url,
            correlation_id=correlation_id,
        )
        if not batch.results:
            raise EngineError(status_code=500, code="empty_batch_result", message="Engine returned an empty batch result")
        return batch.results[0].result

    async def execute_batch(
        self,
        *,
        specs: list[tuple[str | None, QuerySpec]],
        datasource_url: str,
        correlation_id: str | None = None,
    ) -> BatchQueryResponse:
        if not specs:
            return BatchQueryResponse(results=[], batch_size=0, deduped_count=0, executed_count=0, cache_hit_count=0)

        prepared = [self._prepare_spec(spec=spec, datasource_url=datasource_url) for _, spec in specs]
        groups: dict[str, list[int]] = {}
        for index, item in enumerate(prepared):
            groups.setdefault(item.dedupe_key, []).append(index)

        deduped_count = sum(max(0, len(indexes) - 1) for indexes in groups.values())
        results_by_index: dict[int, QueryResult] = {}
        cache_hit_count = 0
        executed_count = 0
        fused_groups_count = 0
        metrics_per_group: list[int] = []

        dedupe_groups: list[_DedupeGroup] = []
        for member_indexes in groups.values():
            representative_index = member_indexes[0]
            dedupe_groups.append(
                _DedupeGroup(
                    representative_index=representative_index,
                    member_indexes=member_indexes,
                    item=prepared[representative_index],
                )
            )

        pending_by_rep_index: dict[int, _DedupeGroup] = {}
        for dedupe_group in dedupe_groups:
            group_item = dedupe_group.item

            cached = await self._cache_get(group_item.cache_key)
            if cached is not None:
                cache_hit_count += len(dedupe_group.member_indexes)
                result = cached.model_copy(update={"cache_hit": True, "deduped": len(dedupe_group.member_indexes) > 1})
                for idx in dedupe_group.member_indexes:
                    results_by_index[idx] = result.model_copy(deep=True)
            else:
                pending_by_rep_index[dedupe_group.representative_index] = dedupe_group

        pending_specs = {idx: group.item.normalized for idx, group in pending_by_rep_index.items()}
        fusion_groups = self._fusion_planner.plan(pending_specs)
        if fusion_groups:
            semaphore = asyncio.Semaphore(max(1, self._settings.engine_batch_execution_concurrency_limit))

            async def _run_group(group: QueryFusionGroup) -> _GroupExecutionOutcome:
                async with semaphore:
                    return await self._execute_pending_group(
                        fusion_group=group,
                        pending_by_rep_index=pending_by_rep_index,
                        prepared=prepared,
                        datasource_url=datasource_url,
                        correlation_id=correlation_id,
                    )

            outcomes = await asyncio.gather(*[_run_group(group) for group in fusion_groups])
            for outcome in outcomes:
                results_by_index.update(outcome.results_by_index)
                executed_count += outcome.executed_count
                cache_hit_count += outcome.cache_hit_count
                fused_groups_count += outcome.fused_groups_count
                metrics_per_group.extend(outcome.metrics_per_group)

        items: list[BatchQueryResultItem] = []
        for index, (request_id, _spec) in enumerate(specs):
            items.append(BatchQueryResultItem(request_id=request_id, result=results_by_index[index]))

        logger.info(
            "engine.query.batch | %s",
            {
                "correlation_id": correlation_id,
                "batch_size": len(specs),
                "requested_count": len(specs),
                "deduped_count": deduped_count,
                "fused_groups_count": fused_groups_count,
                "executed_count": executed_count,
                "cache_hit_count": cache_hit_count,
                "metrics_per_group": metrics_per_group,
                "datasource_id": _redact_datasource_id(datasource_url),
            },
        )

        return BatchQueryResponse(
            results=items,
            batch_size=len(specs),
            deduped_count=deduped_count,
            executed_count=executed_count,
            cache_hit_count=cache_hit_count,
        )

    async def _execute_pending_group(
        self,
        *,
        fusion_group: QueryFusionGroup,
        pending_by_rep_index: dict[int, _DedupeGroup],
        prepared: list[_PreparedSpec],
        datasource_url: str,
        correlation_id: str | None,
    ) -> _GroupExecutionOutcome:
        results_by_index: dict[int, QueryResult] = {}
        executed_count = 0
        cache_hit_count = 0
        fused_groups_count = 0
        metrics_per_group: list[int] = []

        if not fusion_group.can_fuse or fusion_group.fused_spec is None or len(fusion_group.member_indexes) <= 1:
            if fusion_group.reason:
                logger.info(
                    "engine.query.fusion_skip | %s",
                    {
                        "correlation_id": correlation_id,
                        "reason": fusion_group.reason,
                        "member_count": len(fusion_group.member_indexes),
                    },
                )
            for rep_index in fusion_group.member_indexes:
                dedupe_group = pending_by_rep_index[rep_index]
                computed, singleflight_deduped = await self._execute_single_query(
                    item=dedupe_group.item,
                    datasource_url=datasource_url,
                    correlation_id=correlation_id,
                    batch_size=len(dedupe_group.member_indexes),
                )
                executed_count += 1
                metrics_per_group.append(len(dedupe_group.item.normalized.metrics))
                result = computed.model_copy(update={"deduped": len(dedupe_group.member_indexes) > 1 or singleflight_deduped})
                for idx in dedupe_group.member_indexes:
                    await self._cache_set(prepared[idx].cache_key, computed)
                    results_by_index[idx] = result.model_copy(deep=True)
            return _GroupExecutionOutcome(
                results_by_index=results_by_index,
                executed_count=executed_count,
                cache_hit_count=cache_hit_count,
                fused_groups_count=fused_groups_count,
                metrics_per_group=metrics_per_group,
            )

        try:
            fused_cache_key = self._fusion_cache_key(fusion_group, pending_by_rep_index)
            cached_fused_result = await self._cache_get(fused_cache_key)
            if cached_fused_result is None:
                fused_result, singleflight_deduped = await self._execute_fused_query(
                    fusion_group=fusion_group,
                    datasource_url=datasource_url,
                    correlation_id=correlation_id,
                    singleflight_key=self._fusion_singleflight_key(fusion_group, pending_by_rep_index),
                )
                executed_count += 1
                fused_groups_count += 1
                metrics_per_group.append(fusion_group.metrics_count)
                await self._cache_set(fused_cache_key, fused_result)
            else:
                fused_result = cached_fused_result.model_copy(update={"cache_hit": True}, deep=True)
                singleflight_deduped = False
                cache_hit_count += sum(len(pending_by_rep_index[idx].member_indexes) for idx in fusion_group.member_indexes)

            for rep_index in fusion_group.member_indexes:
                dedupe_group = pending_by_rep_index[rep_index]
                metric_positions = fusion_group.metric_positions_by_member.get(rep_index, [])
                projected = self._demultiplex_result(
                    result=fused_result,
                    spec=dedupe_group.item.normalized,
                    metric_positions=metric_positions,
                )
                for idx in dedupe_group.member_indexes:
                    await self._cache_set(prepared[idx].cache_key, projected)
                    deduped_value = len(dedupe_group.member_indexes) > 1 or len(fusion_group.member_indexes) > 1 or singleflight_deduped
                    results_by_index[idx] = projected.model_copy(update={"deduped": deduped_value}, deep=True)
        except Exception as exc:
            logger.warning(
                "engine.query.fusion_fallback | %s",
                {
                    "correlation_id": correlation_id,
                    "reason": str(exc),
                    "member_count": len(fusion_group.member_indexes),
                },
            )
            for rep_index in fusion_group.member_indexes:
                dedupe_group = pending_by_rep_index[rep_index]
                computed, singleflight_deduped = await self._execute_single_query(
                    item=dedupe_group.item,
                    datasource_url=datasource_url,
                    correlation_id=correlation_id,
                    batch_size=len(dedupe_group.member_indexes),
                )
                executed_count += 1
                metrics_per_group.append(len(dedupe_group.item.normalized.metrics))
                result = computed.model_copy(update={"deduped": len(dedupe_group.member_indexes) > 1 or singleflight_deduped})
                for idx in dedupe_group.member_indexes:
                    await self._cache_set(prepared[idx].cache_key, computed)
                    results_by_index[idx] = result.model_copy(deep=True)

        return _GroupExecutionOutcome(
            results_by_index=results_by_index,
            executed_count=executed_count,
            cache_hit_count=cache_hit_count,
            fused_groups_count=fused_groups_count,
            metrics_per_group=metrics_per_group,
        )

    async def _execute_single_query(
        self,
        *,
        item: _PreparedSpec,
        datasource_url: str,
        correlation_id: str | None,
        batch_size: int,
    ) -> tuple[QueryResult, bool]:
        async def _producer() -> QueryResult:
            started = perf_counter()
            sql, params, row_limit = compile_query(item.normalized, max_rows=self._settings.query_result_rows_max)
            adapter = PostgresAdapter(datasource_url)
            columns, rows = await adapter.execute(
                sql=sql,
                params=params,
                timeout_seconds=self._settings.query_timeout_seconds,
            )
            clipped_rows = rows[:row_limit]
            elapsed_ms = max(0, int((perf_counter() - started) * 1000))
            query_result = QueryResult(
                columns=columns,
                rows=clipped_rows,
                row_count=len(clipped_rows),
                execution_time_ms=elapsed_ms,
                sql_hash=sql_hash(sql),
                cache_hit=False,
                deduped=False,
            )
            logger.info(
                "engine.query.execute | %s",
                {
                    "correlation_id": correlation_id,
                    "resource_id": item.normalized.resource_id,
                    "sql_hash": query_result.sql_hash,
                    "execution_time_ms": elapsed_ms,
                    "row_count": query_result.row_count,
                    "batch_size": batch_size,
                },
            )
            return query_result

        return await self._singleflight(item.dedupe_key, _producer)

    async def _execute_fused_query(
        self,
        *,
        fusion_group: QueryFusionGroup,
        datasource_url: str,
        correlation_id: str | None,
        singleflight_key: str,
    ) -> tuple[QueryResult, bool]:
        if fusion_group.fused_spec is None:
            raise EngineError(status_code=400, code="invalid_fusion_group", message="Fused group missing fused_spec")

        async def _producer() -> QueryResult:
            started = perf_counter()
            sql, params, row_limit = compile_query(fusion_group.fused_spec, max_rows=self._settings.query_result_rows_max)
            adapter = PostgresAdapter(datasource_url)
            columns, rows = await adapter.execute(
                sql=sql,
                params=params,
                timeout_seconds=self._settings.query_timeout_seconds,
            )
            clipped_rows = rows[:row_limit]
            elapsed_ms = max(0, int((perf_counter() - started) * 1000))
            result = QueryResult(
                columns=columns,
                rows=clipped_rows,
                row_count=len(clipped_rows),
                execution_time_ms=elapsed_ms,
                sql_hash=sql_hash(sql),
                cache_hit=False,
                deduped=False,
            )
            logger.info(
                "engine.query.execute_fused | %s",
                {
                    "correlation_id": correlation_id,
                    "resource_id": fusion_group.fused_spec.resource_id,
                    "sql_hash": result.sql_hash,
                    "execution_time_ms": elapsed_ms,
                    "row_count": result.row_count,
                    "member_count": len(fusion_group.member_indexes),
                    "metrics_count": len(fusion_group.fused_spec.metrics),
                },
            )
            return result

        return await self._singleflight(singleflight_key, _producer)

    def _demultiplex_result(self, *, result: QueryResult, spec: QuerySpec, metric_positions: list[int]) -> QueryResult:
        metric_target_columns = [f"m{idx}" for idx in range(len(spec.metrics))]
        output_columns = self._non_metric_columns(spec) + metric_target_columns
        projected_rows: list[dict[str, object]] = []

        for row in result.rows:
            projected: dict[str, object] = {}
            for column in self._non_metric_columns(spec):
                projected[column] = row.get(column)
            for target_idx, source_idx in enumerate(metric_positions):
                projected[f"m{target_idx}"] = row.get(f"m{source_idx}")
            projected_rows.append(projected)
        if spec.widget_type == "line":
            projected_rows = self._sort_line_rows(spec=spec, rows=projected_rows)

        return QueryResult(
            columns=output_columns,
            rows=projected_rows,
            row_count=len(projected_rows),
            execution_time_ms=result.execution_time_ms,
            sql_hash=result.sql_hash,
            cache_hit=False,
            deduped=False,
        )

    def _non_metric_columns(self, spec: QuerySpec) -> list[str]:
        if spec.widget_type == "line" and spec.time:
            return ["time_bucket", *spec.dimensions]
        return list(spec.dimensions)

    def _fusion_singleflight_key(self, fusion_group: QueryFusionGroup, pending_by_rep_index: dict[int, _DedupeGroup]) -> str:
        cache_keys = [pending_by_rep_index[idx].item.cache_key for idx in fusion_group.member_indexes]
        joined = "|".join(sorted(cache_keys))
        return f"fusion:{sql_hash(joined)}"

    def _fusion_cache_key(self, fusion_group: QueryFusionGroup, pending_by_rep_index: dict[int, _DedupeGroup]) -> str:
        cache_keys = [pending_by_rep_index[idx].item.cache_key for idx in fusion_group.member_indexes]
        joined = "|".join(sorted(cache_keys))
        return f"cache:fusion:{sql_hash(joined)}"

    def _sort_line_rows(self, *, spec: QuerySpec, rows: list[dict[str, object]]) -> list[dict[str, object]]:
        order_by = spec.order_by
        if not order_by and spec.sort:
            order_by = [
                type("OrderBy", (), {"column": item.field, "metric_ref": None, "direction": item.dir})()
                for item in spec.sort
            ]
        if not order_by:
            order_by = [type("OrderBy", (), {"column": "time_bucket", "metric_ref": None, "direction": "asc"})()]

        ordered = list(rows)
        for item in reversed(order_by):
            direction = str(getattr(item, "direction", "asc") or "asc").lower()
            reverse = direction == "desc"
            column = getattr(item, "column", None)
            metric_ref = getattr(item, "metric_ref", None)
            if column:
                ordered.sort(key=lambda row: row.get(column), reverse=reverse)
            elif metric_ref:
                ordered.sort(key=lambda row: row.get(metric_ref), reverse=reverse)
        return ordered

    def _prepare_spec(self, *, spec: QuerySpec, datasource_url: str) -> _PreparedSpec:
        canonical_spec, dedupe_key, cache_key = build_query_keys(spec=spec, datasource_url=datasource_url)
        normalized = QuerySpec.model_validate(canonical_spec)
        return _PreparedSpec(
            original=spec,
            normalized=normalized,
            dedupe_key=dedupe_key,
            cache_key=cache_key,
        )

    async def list_resources(self, *, datasource_url: str) -> ResourceList:
        adapter = PostgresAdapter(datasource_url)
        items = await adapter.list_resources()
        return ResourceList(items=items)

    async def get_schema(self, *, datasource_url: str, resource_id: str) -> SchemaDefinition:
        if "." not in resource_id:
            raise EngineError(status_code=400, code="invalid_resource_id", message="resource_id must be schema.name")
        schema_name, resource_name = resource_id.split(".", 1)
        adapter = PostgresAdapter(datasource_url)
        fields = await adapter.get_schema(schema_name=schema_name, resource_name=resource_name)
        if not fields:
            raise EngineError(status_code=404, code="schema_not_found", message="Resource schema not found")
        return SchemaDefinition(resource_id=resource_id, fields=fields)

    async def _cache_get(self, key: str) -> QueryResult | None:
        now = _utcnow()
        async with self._cache_lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            if entry.expires_at <= now:
                self._cache.pop(key, None)
                return None
            self._cache.move_to_end(key)
            return entry.result.model_copy(deep=True)

    async def _cache_set(self, key: str, result: QueryResult) -> None:
        async with self._cache_lock:
            self._cache[key] = _CacheEntry(
                result=result.model_copy(deep=True),
                expires_at=_utcnow() + timedelta(seconds=self._settings.engine_cache_ttl_seconds),
            )
            self._cache.move_to_end(key)
            while len(self._cache) > self._settings.engine_cache_max_entries:
                self._cache.popitem(last=False)

    async def _singleflight(self, key: str, producer: Any) -> tuple[QueryResult, bool]:
        now = _utcnow()
        loop = asyncio.get_running_loop()

        async with self._inflight_lock:
            inflight = self._inflight.get(key)
            if inflight and inflight.expires_at > now and not inflight.future.done():
                future = inflight.future
                deduped = True
            else:
                future = loop.create_future()
                self._inflight[key] = _Inflight(
                    future=future,
                    expires_at=now + timedelta(seconds=self._settings.engine_singleflight_ttl_seconds),
                )
                deduped = False

        if deduped:
            return await future, True

        try:
            result = await producer()
            if not future.done():
                future.set_result(result)
            return result, False
        except Exception as exc:
            if not future.done():
                future.set_exception(exc)
                _ = future.exception()
            raise
        finally:
            async with self._inflight_lock:
                current = self._inflight.get(key)
                if current and current.future is future:
                    self._inflight.pop(key, None)
