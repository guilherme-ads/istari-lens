from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from app.modules.core.legacy.models import DashboardWidget, DataSource, User
from app.modules.core.legacy.schemas import DashboardWidgetDataResponse
from app.modules.engine import get_engine_client, resolve_datasource_access
from app.modules.widgets.domain.config import FilterConfig, WidgetConfig

logger = logging.getLogger("uvicorn.error")


@dataclass(slots=True)
class WidgetExecutionMetadata:
    cache_hit: bool = False
    stale: bool = False
    deduped: bool = False
    batched: bool = False
    degraded: bool = False
    execution_time_ms: int = 0
    sql_hash: str | None = None
    source: str = "engine"


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
    query_spec: dict[str, Any] | None
    params: list[Any]
    sql_hash: str
    fingerprint_key: str


class DashboardWidgetExecutionCoordinator:
    async def reset_state_for_tests(self) -> None:
        return None

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
        correlation_id: str | None = None,
    ) -> dict[int, WidgetExecutionResult]:
        _ = user
        _ = runtime_filters

        access = resolve_datasource_access(
            datasource=datasource,
            dataset=None,
            current_user=user,
        )
        results: dict[int, WidgetExecutionResult] = {}
        batch_queries: list[dict[str, Any]] = []
        non_text_widget_ids: list[int] = []

        for widget in widgets:
            config = configs_by_widget_id[widget.id]
            if config.widget_type == "text":
                payload = DashboardWidgetDataResponse(columns=[], rows=[], row_count=0)
                metadata = WidgetExecutionMetadata(source="text")
                results[widget.id] = WidgetExecutionResult(widget_id=widget.id, payload=payload, metadata=metadata)
                continue
            batch_queries.append({"request_id": str(widget.id), "spec": _to_engine_query_spec(config)})
            non_text_widget_ids.append(widget.id)

        if batch_queries:
            try:
                batch_payload = await get_engine_client().execute_query_batch(
                    datasource_id=access.datasource_id,
                    workspace_id=access.workspace_id,
                    dataset_id=dataset_id,
                    queries=batch_queries,
                    datasource_url=access.datasource_url,
                    actor_user_id=access.actor_user_id,
                    correlation_id=correlation_id,
                )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Widget execution failed via engine: {exc}") from exc

            result_items = batch_payload.get("results", [])
            by_request_id = {str(item.get("request_id")): item.get("result", {}) for item in result_items}

            for widget_id in non_text_widget_ids:
                engine_payload = by_request_id.get(str(widget_id))
                if engine_payload is None:
                    raise HTTPException(status_code=500, detail=f"Missing batch result for widget {widget_id}")

                payload = DashboardWidgetDataResponse(
                    columns=engine_payload.get("columns", []),
                    rows=engine_payload.get("rows", []),
                    row_count=int(engine_payload.get("row_count", 0)),
                )
                metadata = WidgetExecutionMetadata(
                    cache_hit=bool(engine_payload.get("cache_hit", False)),
                    stale=False,
                    deduped=bool(engine_payload.get("deduped", False)),
                    batched=len(non_text_widget_ids) > 1,
                    degraded=False,
                    execution_time_ms=int(engine_payload.get("execution_time_ms", 0)),
                    sql_hash=engine_payload.get("sql_hash"),
                    source="engine",
                )
                results[widget_id] = WidgetExecutionResult(widget_id=widget_id, payload=payload, metadata=metadata)

                logger.info(
                    "dashboard_widget_execution | %s",
                    {
                        "dashboard_id": dashboard_id,
                        "widget_id": widget_id,
                        "dataset_id": dataset_id,
                        "cache_hit": metadata.cache_hit,
                        "sql_hash": metadata.sql_hash,
                        "execution_time_ms": metadata.execution_time_ms,
                        "deduped": metadata.deduped,
                        "batched": metadata.batched,
                        "source": metadata.source,
                        "correlation_id": correlation_id,
                    },
                )

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
        _ = datasource
        _ = dataset_id
        _ = user
        _ = runtime_filters

        units: list[DebugExecutionUnit] = []
        for widget in widgets:
            config = configs_by_widget_id[widget.id]
            if config.widget_type == "text":
                continue
            query_spec = _to_engine_query_spec(config)
            fingerprint_key = _fingerprint_key(config)
            units.append(
                DebugExecutionUnit(
                    execution_kind="single",
                    widget_ids=[widget.id],
                    sql="ENGINE_MANAGED_QUERY",
                    query_spec=query_spec,
                    params=[],
                    sql_hash=hashlib.sha256(fingerprint_key.encode("utf-8")).hexdigest(),
                    fingerprint_key=fingerprint_key,
                )
            )
        return units



def _to_engine_query_spec(config: WidgetConfig) -> dict[str, Any]:
    resolved_limit = config.limit if config.limit is not None else 500
    if config.widget_type != "table":
        resolved_limit = None
    payload: dict[str, Any] = {
        "resource_id": config.view_name,
        "widget_type": config.widget_type,
        "metrics": [{"field": item.column, "agg": item.op} for item in config.metrics],
        "dimensions": list(config.dimensions),
        "filters": [{"field": item.column, "op": item.op, "value": item.value} for item in config.filters],
        "order_by": [
            {
                "column": item.column,
                "metric_ref": item.metric_ref,
                "direction": item.direction,
            }
            for item in config.order_by
        ],
        "columns": list(config.columns) if config.columns else None,
        "top_n": config.top_n,
        "offset": config.offset if config.offset is not None else 0,
        "time": (
            {
                "column": config.time.column,
                "granularity": config.time.granularity,
            }
            if config.time
            else None
        ),
        "composite_metric": (
            {
                "inner_agg": config.composite_metric.inner_agg,
                "outer_agg": config.composite_metric.outer_agg,
                "value_column": config.composite_metric.value_column,
                "time_column": config.composite_metric.time_column,
                "granularity": config.composite_metric.granularity,
            }
            if config.composite_metric
            else None
        ),
        "dre_rows": [
            {
                "title": row.title,
                "row_type": row.row_type,
                "metrics": [{"field": metric.column, "agg": metric.op} for metric in row.metrics],
            }
            for row in config.dre_rows
        ],
    }
    if resolved_limit is not None:
        payload["limit"] = resolved_limit
    return payload


def _fingerprint_key(config: WidgetConfig) -> str:
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_dashboard_widget_executor = DashboardWidgetExecutionCoordinator()


def get_dashboard_widget_executor() -> DashboardWidgetExecutionCoordinator:
    return _dashboard_widget_executor
