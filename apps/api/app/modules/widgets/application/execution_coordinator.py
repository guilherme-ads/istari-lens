from __future__ import annotations

import ast
import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from app.modules.core.legacy.models import DashboardWidget, DataSource, User
from app.modules.core.legacy.schemas import DashboardWidgetDataResponse
from app.modules.engine import get_engine_client, resolve_datasource_access
from app.modules.widgets.domain.config import FilterConfig, MetricConfig, WidgetConfig

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
        available_widget_ids = set(configs_by_widget_id.keys())
        results: dict[int, WidgetExecutionResult] = {}
        engine_result_cache: dict[str, WidgetExecutionResult] = {}

        # Preserve current batching behavior for directly requested non-derived widgets.
        requested_non_derived_ids = [
            widget.id
            for widget in widgets
            if not _is_text_widget(configs_by_widget_id[widget.id]) and not _is_dashboard_derived_kpi(configs_by_widget_id[widget.id])
        ]
        if requested_non_derived_ids:
            batched_results = await self._execute_engine_batch(
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                access=access,
                widget_ids=requested_non_derived_ids,
                configs_by_widget_id=configs_by_widget_id,
                correlation_id=correlation_id,
            )
            for widget_id, execution in batched_results.items():
                results[widget_id] = execution
                engine_result_cache[_engine_cache_key(widget_id, configs_by_widget_id[widget_id].filters)] = execution

        for widget in widgets:
            if widget.id in results:
                continue
            config = configs_by_widget_id[widget.id]
            execution = await self._resolve_widget_execution(
                widget_id=widget.id,
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                access=access,
                available_widget_ids=available_widget_ids,
                configs_by_widget_id=configs_by_widget_id,
                correlation_id=correlation_id,
                engine_result_cache=engine_result_cache,
                stack=[],
                inherited_filters=None,
            )
            results[widget.id] = execution

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
            if _is_dashboard_derived_kpi(config):
                query_spec = {
                    "widget_type": "kpi_derived_dashboard",
                    "formula": config.formula,
                    "kpi_dependencies": [item.model_dump(mode="json") for item in config.kpi_dependencies],
                }
            else:
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

    async def _execute_engine_batch(
        self,
        *,
        dashboard_id: int,
        dataset_id: int,
        access: Any,
        widget_ids: list[int],
        configs_by_widget_id: dict[int, WidgetConfig],
        correlation_id: str | None,
    ) -> dict[int, WidgetExecutionResult]:
        batch_queries = [{"request_id": str(widget_id), "spec": _to_engine_query_spec(configs_by_widget_id[widget_id])} for widget_id in widget_ids]
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
        results: dict[int, WidgetExecutionResult] = {}
        for widget_id in widget_ids:
            engine_payload = by_request_id.get(str(widget_id))
            if engine_payload is None:
                raise HTTPException(status_code=500, detail=f"Missing batch result for widget {widget_id}")
            execution = _engine_payload_to_execution_result(
                widget_id=widget_id,
                engine_payload=engine_payload,
                batched=len(widget_ids) > 1,
                source="engine",
            )
            results[widget_id] = execution
            _log_widget_execution(
                dashboard_id=dashboard_id,
                widget_id=widget_id,
                dataset_id=dataset_id,
                metadata=execution.metadata,
                correlation_id=correlation_id,
            )
        return results

    async def _resolve_widget_execution(
        self,
        *,
        widget_id: int,
        dashboard_id: int,
        dataset_id: int,
        access: Any,
        available_widget_ids: set[int],
        configs_by_widget_id: dict[int, WidgetConfig],
        correlation_id: str | None,
        engine_result_cache: dict[str, WidgetExecutionResult],
        stack: list[int],
        inherited_filters: list[FilterConfig] | None,
    ) -> WidgetExecutionResult:
        if widget_id in stack:
            cycle = " -> ".join(str(item) for item in [*stack, widget_id])
            raise HTTPException(status_code=400, detail=f"Derived KPI circular dependency detected: {cycle}")
        if widget_id not in available_widget_ids:
            raise HTTPException(status_code=400, detail=f"Derived KPI dependency widget not found: {widget_id}")
        base_config = configs_by_widget_id.get(widget_id)
        if base_config is None:
            raise HTTPException(status_code=400, detail=f"Widget config not resolved for widget {widget_id}")
        config = base_config
        if inherited_filters is not None and base_config.widget_type != "text":
            config = base_config.model_copy(update={"filters": _merge_filters(base_config.filters, inherited_filters)})

        if _is_text_widget(config):
            return WidgetExecutionResult(
                widget_id=widget_id,
                payload=DashboardWidgetDataResponse(columns=[], rows=[], row_count=0),
                metadata=WidgetExecutionMetadata(source="text"),
            )

        if not _is_dashboard_derived_kpi(config):
            cache_key = _engine_cache_key(widget_id, config.filters)
            cached = engine_result_cache.get(cache_key)
            if cached is not None:
                return cached
            try:
                engine_payload = await get_engine_client().execute_query(
                    datasource_id=access.datasource_id,
                    workspace_id=access.workspace_id,
                    dataset_id=dataset_id,
                    query_spec=_to_engine_query_spec(config),
                    datasource_url=access.datasource_url,
                    actor_user_id=access.actor_user_id,
                    correlation_id=correlation_id,
                )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Widget execution failed via engine: {exc}") from exc
            execution = _engine_payload_to_execution_result(
                widget_id=widget_id,
                engine_payload=engine_payload,
                batched=False,
                source="engine",
            )
            engine_result_cache[cache_key] = execution
            _log_widget_execution(
                dashboard_id=dashboard_id,
                widget_id=widget_id,
                dataset_id=dataset_id,
                metadata=execution.metadata,
                correlation_id=correlation_id,
            )
            return execution

        if config.widget_type != "kpi":
            raise HTTPException(status_code=400, detail=f"Derived KPI widget {widget_id} must be KPI")
        if not config.formula:
            raise HTTPException(status_code=400, detail=f"Derived KPI widget {widget_id} is missing formula")
        if not config.kpi_dependencies:
            raise HTTPException(status_code=400, detail=f"Derived KPI widget {widget_id} has no dependencies")

        root_filters = inherited_filters if inherited_filters is not None else config.filters
        dep_values: dict[str, float | None] = {}
        column_deps: dict[str, Any] = {}
        total_exec_ms = 0
        any_cache_hit = False
        for dep in config.kpi_dependencies:
            if getattr(dep, "source_type", "widget") == "column":
                column_deps[dep.alias] = dep
                continue
            else:
                if dep.widget_id not in available_widget_ids:
                    raise HTTPException(status_code=400, detail=f"Derived KPI dependency widget not found: {dep.widget_id}")
                dep_config = configs_by_widget_id.get(dep.widget_id)
                if dep_config is None:
                    raise HTTPException(status_code=400, detail=f"Derived KPI dependency config not found: {dep.widget_id}")
                if dep_config.widget_type != "kpi":
                    raise HTTPException(status_code=400, detail=f"Derived KPI dependency widget {dep.widget_id} is not a KPI")
                if dep_config.view_name != config.view_name:
                    raise HTTPException(status_code=400, detail="Derived KPI dependencies must use the same dataset view in MVP")
                dep_execution = await self._resolve_widget_execution(
                    widget_id=dep.widget_id,
                    dashboard_id=dashboard_id,
                    dataset_id=dataset_id,
                    access=access,
                    available_widget_ids=available_widget_ids,
                    configs_by_widget_id=configs_by_widget_id,
                    correlation_id=correlation_id,
                    engine_result_cache=engine_result_cache,
                    stack=[*stack, widget_id],
                    inherited_filters=root_filters,
                )
            total_exec_ms += max(0, int(dep_execution.metadata.execution_time_ms))
            any_cache_hit = any_cache_hit or bool(dep_execution.metadata.cache_hit)
            dep_values[dep.alias] = _extract_kpi_scalar(dep_execution.payload)

        derived_value, column_exec_ms, column_cache_hit = await self._evaluate_derived_formula_for_widget(
            formula=config.formula,
            scalar_values=dep_values,
            column_deps=column_deps,
            owner_widget_id=widget_id,
            owner_config=config,
            dashboard_id=dashboard_id,
            dataset_id=dataset_id,
            access=access,
            correlation_id=correlation_id,
            engine_result_cache=engine_result_cache,
            inherited_filters=root_filters,
        )
        total_exec_ms += column_exec_ms
        any_cache_hit = any_cache_hit or column_cache_hit
        payload = DashboardWidgetDataResponse(
            columns=["m0"],
            rows=[{"m0": derived_value}],
            row_count=1,
        )
        metadata = WidgetExecutionMetadata(
            cache_hit=any_cache_hit,
            batched=False,
            degraded=False,
            deduped=False,
            execution_time_ms=total_exec_ms,
            sql_hash=None,
            source="derived_widget",
        )
        return WidgetExecutionResult(widget_id=widget_id, payload=payload, metadata=metadata)

    async def _execute_column_dependency(
        self,
        *,
        dep: Any,
        agg: str,
        owner_widget_id: int,
        owner_config: WidgetConfig,
        dashboard_id: int,
        dataset_id: int,
        access: Any,
        correlation_id: str | None,
        engine_result_cache: dict[str, WidgetExecutionResult],
        inherited_filters: list[FilterConfig],
    ) -> WidgetExecutionResult:
        cache_key = _column_dep_cache_key(owner_widget_id, str(dep.alias), agg, str(dep.column), inherited_filters)
        cached = engine_result_cache.get(cache_key)
        if cached is not None:
            return cached
        virtual_config = owner_config.model_copy(
            update={
                "kpi_type": "atomic",
                "formula": None,
                "dependencies": [],
                "kpi_dependencies": [],
                "composite_metric": None,
                "metrics": [MetricConfig(op=agg, column=dep.column)],
                "filters": inherited_filters,
            }
        )
        try:
            engine_payload = await get_engine_client().execute_query(
                datasource_id=access.datasource_id,
                workspace_id=access.workspace_id,
                dataset_id=dataset_id,
                query_spec=_to_engine_query_spec(virtual_config),
                datasource_url=access.datasource_url,
                actor_user_id=access.actor_user_id,
                correlation_id=correlation_id,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Column dependency execution failed via engine: {exc}") from exc
        execution = _engine_payload_to_execution_result(
            widget_id=owner_widget_id,
            engine_payload=engine_payload,
            batched=False,
            source="derived_column",
        )
        engine_result_cache[cache_key] = execution
        _log_widget_execution(
            dashboard_id=dashboard_id,
            widget_id=owner_widget_id,
            dataset_id=dataset_id,
            metadata=execution.metadata,
            correlation_id=correlation_id,
        )
        return execution

    async def _evaluate_derived_formula_for_widget(
        self,
        *,
        formula: str,
        scalar_values: dict[str, float | None],
        column_deps: dict[str, Any],
        owner_widget_id: int,
        owner_config: WidgetConfig,
        dashboard_id: int,
        dataset_id: int,
        access: Any,
        correlation_id: str | None,
        engine_result_cache: dict[str, WidgetExecutionResult],
        inherited_filters: list[FilterConfig],
    ) -> tuple[float | None, int, bool]:
        ast_root = _parse_derived_formula_ast(formula)
        func_calls = _collect_formula_function_calls(ast_root)
        func_values: dict[tuple[str, str], float | None] = {}
        total_exec_ms = 0
        any_cache_hit = False
        for func_name, alias in sorted(func_calls):
            dep = column_deps.get(alias)
            if dep is None:
                raise HTTPException(status_code=400, detail=f"Function {func_name} expects a column dependency alias: {alias}")
            agg = _formula_function_to_metric_op(func_name)
            execution = await self._execute_column_dependency(
                dep=dep,
                agg=agg,
                owner_widget_id=owner_widget_id,
                owner_config=owner_config,
                dashboard_id=dashboard_id,
                dataset_id=dataset_id,
                access=access,
                correlation_id=correlation_id,
                engine_result_cache=engine_result_cache,
                inherited_filters=inherited_filters,
            )
            total_exec_ms += max(0, int(execution.metadata.execution_time_ms))
            any_cache_hit = any_cache_hit or bool(execution.metadata.cache_hit)
            func_values[(func_name.upper(), alias)] = _extract_kpi_scalar(execution.payload)
        return _evaluate_derived_formula(ast_root, scalar_values, column_deps, func_values), total_exec_ms, any_cache_hit



def _to_engine_query_spec(config: WidgetConfig) -> dict[str, Any]:
    resolved_limit = config.limit if config.limit is not None else 500
    if config.widget_type != "table":
        resolved_limit = None
    payload: dict[str, Any] = {
        "resource_id": config.view_name,
        "widget_type": config.widget_type,
        "metrics": [{"field": item.column, "agg": item.op, "alias": item.alias} for item in config.metrics],
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
        "derived_metric": (
            {
                "formula": config.formula,
                "dependencies": list(config.dependencies),
                "on_divide_by_zero": "null",
            }
            if config.widget_type == "kpi" and config.kpi_type == "derived" and config.formula and not config.kpi_dependencies
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


def _is_text_widget(config: WidgetConfig) -> bool:
    return config.widget_type == "text"


def _is_dashboard_derived_kpi(config: WidgetConfig) -> bool:
    return config.widget_type == "kpi" and config.kpi_type == "derived" and len(config.kpi_dependencies) > 0


def _engine_payload_to_execution_result(
    *,
    widget_id: int,
    engine_payload: dict[str, Any],
    batched: bool,
    source: str,
) -> WidgetExecutionResult:
    payload = DashboardWidgetDataResponse(
        columns=engine_payload.get("columns", []),
        rows=engine_payload.get("rows", []),
        row_count=int(engine_payload.get("row_count", 0)),
    )
    metadata = WidgetExecutionMetadata(
        cache_hit=bool(engine_payload.get("cache_hit", False)),
        stale=False,
        deduped=bool(engine_payload.get("deduped", False)),
        batched=batched,
        degraded=False,
        execution_time_ms=int(engine_payload.get("execution_time_ms", 0)),
        sql_hash=engine_payload.get("sql_hash"),
        source=source,
    )
    return WidgetExecutionResult(widget_id=widget_id, payload=payload, metadata=metadata)


def _log_widget_execution(
    *,
    dashboard_id: int,
    widget_id: int,
    dataset_id: int,
    metadata: WidgetExecutionMetadata,
    correlation_id: str | None,
) -> None:
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


def _engine_cache_key(widget_id: int, filters: list[FilterConfig]) -> str:
    filters_json = json.dumps([item.model_dump(mode="json") for item in filters], sort_keys=True, separators=(",", ":"), default=str)
    return f"{widget_id}:{hashlib.sha256(filters_json.encode('utf-8')).hexdigest()}"


def _column_dep_cache_key(owner_widget_id: int, alias: str, agg: str, column: str, filters: list[FilterConfig]) -> str:
    filters_json = json.dumps([item.model_dump(mode="json") for item in filters], sort_keys=True, separators=(",", ":"), default=str)
    seed = f"{owner_widget_id}:{alias}:{agg}:{column}:{filters_json}"
    return f"coldep:{hashlib.sha256(seed.encode('utf-8')).hexdigest()}"


def _merge_filters(base_filters: list[FilterConfig], extra_filters: list[FilterConfig]) -> list[FilterConfig]:
    merged: list[FilterConfig] = []
    seen: set[str] = set()
    for item in [*base_filters, *extra_filters]:
        key = json.dumps(item.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), default=str)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def _extract_kpi_scalar(payload: DashboardWidgetDataResponse) -> float | None:
    row = payload.rows[0] if payload.rows else {}
    raw = row.get("m0")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _parse_derived_formula_ast(formula: str) -> ast.Expression:
    try:
        root = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise HTTPException(status_code=400, detail="Invalid derived KPI formula syntax") from exc
    if not isinstance(root, ast.Expression):
        raise HTTPException(status_code=400, detail="Invalid derived KPI formula syntax")
    return root


def _collect_formula_function_calls(root: ast.Expression) -> set[tuple[str, str]]:
    calls: set[tuple[str, str]] = set()

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Expression):
            visit(node.body)
            return
        if isinstance(node, ast.BinOp):
            visit(node.left)
            visit(node.right)
            return
        if isinstance(node, ast.UnaryOp):
            visit(node.operand)
            return
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise HTTPException(status_code=400, detail="Derived KPI formula contains unsupported function")
            func_name = node.func.id.upper()
            if func_name not in {"COUNT", "DISTINCT", "SUM", "AVG", "MAX", "MIN"}:
                raise HTTPException(status_code=400, detail=f"Unsupported function '{node.func.id}' in derived KPI formula")
            if len(node.args) != 1 or node.keywords:
                raise HTTPException(status_code=400, detail=f"Function {node.func.id} requires exactly one argument")
            arg = node.args[0]
            if not isinstance(arg, ast.Name):
                raise HTTPException(status_code=400, detail=f"Function {node.func.id} argument must be a column alias")
            calls.add((func_name, arg.id))
            return
        if isinstance(node, (ast.Name, ast.Constant)):
            return
        raise HTTPException(status_code=400, detail="Derived KPI formula contains unsupported tokens")

    visit(root)
    return calls


def _formula_function_to_metric_op(func_name: str) -> str:
    fn = func_name.upper()
    if fn == "COUNT":
        return "count"
    if fn == "DISTINCT":
        return "distinct_count"
    if fn == "SUM":
        return "sum"
    if fn == "AVG":
        return "avg"
    if fn == "MAX":
        return "max"
    if fn == "MIN":
        return "min"
    raise HTTPException(status_code=400, detail=f"Unsupported formula function '{func_name}'")


def _evaluate_derived_formula(
    root: ast.Expression,
    scalar_values: dict[str, float | None],
    column_deps: dict[str, Any],
    func_values: dict[tuple[str, str], float | None],
) -> float | None:
    def eval_node(node: ast.AST) -> float | None:
        if isinstance(node, ast.Expression):
            return eval_node(node.body)
        if isinstance(node, ast.Name):
            if node.id in column_deps:
                raise HTTPException(status_code=400, detail=f"Column alias '{node.id}' must be used with COUNT/DISTINCT/AVG/MAX/MIN")
            if node.id not in scalar_values:
                raise HTTPException(status_code=400, detail=f"Derived KPI formula references unknown dependency '{node.id}'")
            return scalar_values[node.id]
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or len(node.args) != 1 or not isinstance(node.args[0], ast.Name):
                raise HTTPException(status_code=400, detail="Derived KPI formula contains unsupported function call")
            key = (node.func.id.upper(), node.args[0].id)
            if key not in func_values:
                raise HTTPException(status_code=400, detail=f"Function result not available for {node.func.id}({node.args[0].id})")
            return func_values[key]
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.UnaryOp):
            val = eval_node(node.operand)
            if val is None:
                return None
            if isinstance(node.op, ast.UAdd):
                return +val
            if isinstance(node.op, ast.USub):
                return -val
            raise HTTPException(status_code=400, detail="Derived KPI formula has unsupported unary operator")
        if isinstance(node, ast.BinOp):
            left = eval_node(node.left)
            right = eval_node(node.right)
            if left is None or right is None:
                return None
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                if right == 0:
                    return None
                return left / right
            raise HTTPException(status_code=400, detail="Derived KPI formula only supports +, -, *, /")
        raise HTTPException(status_code=400, detail="Derived KPI formula contains unsupported tokens")

    return eval_node(root)


def _fingerprint_key(config: WidgetConfig) -> str:
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


_dashboard_widget_executor = DashboardWidgetExecutionCoordinator()


def get_dashboard_widget_executor() -> DashboardWidgetExecutionCoordinator:
    return _dashboard_widget_executor
