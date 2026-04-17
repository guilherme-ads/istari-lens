from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from app.modules.mcp.context import DATASET_WIDGET_VIEW_NAME, dataset_column_types, load_accessible_dataset, load_dashboard_for_dataset
from app.modules.mcp.runtime import MCPToolRuntimeContext
from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.mcp.tools.common import fail, ok
from app.modules.mcp.tools.dashboard_validation import (
    parse_native_filters,
    parse_widget_config,
    validate_layout_widget_references,
    validate_widget_config_for_dashboard,
)


class ValidateWidgetConfigArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    widget_type: str = Field(min_length=1, max_length=32)
    config: dict[str, Any]
    dashboard_id: int | None = Field(default=None, gt=0)


class ValidateDashboardDraftArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    dashboard_id: int = Field(gt=0)
    strict: bool = True


class SuggestBestVisualizationArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    metrics: list[str] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    time_column: str | None = Field(default=None, max_length=255)
    goal: str | None = Field(default=None, max_length=512)
    max_suggestions: int = Field(default=3, ge=1, le=8)

    @model_validator(mode="after")
    def validate_inputs(self) -> "SuggestBestVisualizationArgs":
        if len(self.metrics) < 1 and len(self.dimensions) < 1 and not self.time_column:
            raise ValueError("Provide at least one metric, dimension or time_column")
        return self


def _score_suggestion(base_score: float, *, goal: str | None, widget_type: str) -> float:
    result = float(base_score)
    if not goal:
        return result
    text = goal.strip().lower()
    if any(token in text for token in ["tendencia", "trend", "evolucao", "serie temporal"]) and widget_type == "line":
        result += 0.08
    if any(token in text for token in ["composicao", "participacao", "share"]) and widget_type in {"donut", "bar"}:
        result += 0.07
    if any(token in text for token in ["ranking", "top", "comparacao"]) and widget_type in {"bar", "column"}:
        result += 0.07
    return min(0.99, round(result, 2))


def _fallback_numeric(column_types: dict[str, str]) -> str | None:
    for name, raw_type in column_types.items():
        if str(raw_type).lower() in {"numeric", "integer", "decimal", "float", "double", "real"}:
            return name
        lowered = str(raw_type).lower()
        if any(token in lowered for token in ["int", "numeric", "decimal", "float", "double", "real", "money"]):
            return name
    return None


def _fallback_temporal(column_types: dict[str, str]) -> str | None:
    for name, raw_type in column_types.items():
        lowered = str(raw_type).lower()
        if "temporal" in lowered or any(token in lowered for token in ["date", "time", "timestamp"]):
            return name
    return None


def _fallback_categorical(column_types: dict[str, str]) -> str | None:
    for name, raw_type in column_types.items():
        lowered = str(raw_type).lower()
        if "text" in lowered or "bool" in lowered or "char" in lowered:
            return name
    return None


def _suggested_widget_config(
    *,
    widget_type: str,
    metric_column: str | None,
    dimension_column: str | None,
    time_column: str | None,
    all_columns: list[str],
) -> dict[str, Any]:
    if widget_type == "kpi":
        return {
            "widget_type": "kpi",
            "view_name": DATASET_WIDGET_VIEW_NAME,
            "metrics": [{"op": "sum", "column": metric_column}],
        }
    if widget_type == "line":
        payload: dict[str, Any] = {
            "widget_type": "line",
            "view_name": DATASET_WIDGET_VIEW_NAME,
            "metrics": [{"op": "sum", "column": metric_column}],
            "time": {"column": time_column, "granularity": "month"},
        }
        if dimension_column:
            payload["dimensions"] = [dimension_column]
        return payload
    if widget_type in {"bar", "column", "donut"}:
        return {
            "widget_type": widget_type,
            "view_name": DATASET_WIDGET_VIEW_NAME,
            "metrics": [{"op": "sum", "column": metric_column}],
            "dimensions": [dimension_column],
            "order_by": [{"metric_ref": "m0", "direction": "desc"}],
            "top_n": 10 if widget_type != "column" else None,
        }
    return {
        "widget_type": "table",
        "view_name": DATASET_WIDGET_VIEW_NAME,
        "columns": all_columns[: min(6, len(all_columns))],
        "limit": 50,
    }


async def tool_validate_widget_config(args: ValidateWidgetConfigArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    dashboard = None
    warnings: list[str] = []
    if args.dashboard_id is not None:
        dashboard, _, _ = load_dashboard_for_dataset(
            db=runtime.db,
            dashboard_id=args.dashboard_id,
            dataset_id=args.dataset_id,
            current_user=runtime.current_user,
            min_level="view",
        )

    parsed, parse_errors = parse_widget_config(
        args.config,
        expected_widget_type=str(args.widget_type).strip().lower(),
    )
    if parse_errors:
        return fail(
            error="Widget config validation failed",
            validation_errors=parse_errors,
            suggestions=["Corrija os campos indicados e revalide a configuracao."],
        )

    column_types = dataset_column_types(dataset)
    validation_errors = validate_widget_config_for_dashboard(
        config=parsed,
        dashboard=dashboard,
        column_types=column_types,
        field_prefix="config",
    )
    if dashboard is None and parsed.widget_type == "kpi" and parsed.kpi_type == "derived":
        warnings.append("KPI dependencies were validated without dashboard context (widget refs may still fail on persist).")

    if validation_errors:
        return fail(
            error="Widget config validation failed",
            validation_errors=validation_errors,
            warnings=warnings,
            suggestions=["Use lens.suggest_best_visualization para proposta de visual com base na pergunta."],
        )

    return ok(
        data={
            "dataset_id": int(dataset.id),
            "dashboard_id": int(dashboard.id) if dashboard else None,
            "normalized_config": parsed.model_dump(mode="json"),
        },
        warnings=warnings,
    )


async def tool_validate_dashboard_draft(args: ValidateDashboardDraftArgs, runtime: MCPToolRuntimeContext):
    dashboard, _, _ = load_dashboard_for_dataset(
        db=runtime.db,
        dashboard_id=args.dashboard_id,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
        min_level="view",
    )
    column_types = dataset_column_types(dashboard.dataset)
    errors: list[MCPToolValidationError] = []
    warnings: list[str] = []

    raw_native_filters = dashboard.native_filters if isinstance(dashboard.native_filters, list) else []
    _, native_errors, native_warnings = parse_native_filters(
        raw_filters=raw_native_filters,
        column_types=column_types,
    )
    errors.extend(native_errors)
    warnings.extend(native_warnings)

    sorted_widgets = sorted(dashboard.widgets or [], key=lambda item: (int(item.position or 0), int(item.id)))
    valid_widgets = 0
    for index, widget in enumerate(sorted_widgets):
        if not isinstance(widget.query_config, dict):
            errors.append(
                MCPToolValidationError(
                    code="invalid_widget_config",
                    field=f"widgets[{index}].query_config",
                    message="Widget query_config must be an object",
                )
            )
            continue
        parsed, parse_errors = parse_widget_config(
            widget.query_config,
            expected_widget_type=str(widget.widget_type or ""),
        )
        if parse_errors:
            for item in parse_errors:
                field = f"widgets[{index}].{item.field}" if item.field else f"widgets[{index}]"
                errors.append(MCPToolValidationError(code=item.code, field=field, message=item.message))
            continue
        widget_errors = validate_widget_config_for_dashboard(
            config=parsed,
            dashboard=dashboard,
            column_types=column_types,
            exclude_widget_id=int(widget.id),
            field_prefix=f"widgets[{index}].config",
        )
        if widget_errors:
            errors.extend(widget_errors)
            continue
        valid_widgets += 1

    layout = dashboard.layout_config if isinstance(dashboard.layout_config, list) else []
    widget_ids = {int(item.id) for item in (dashboard.widgets or [])}
    errors.extend(validate_layout_widget_references(layout_config=layout, widget_ids=widget_ids))

    data = {
        "dataset_id": int(args.dataset_id),
        "dashboard_id": int(args.dashboard_id),
        "total_widgets": len(sorted_widgets),
        "valid_widgets": valid_widgets,
        "invalid_widgets": max(0, len(sorted_widgets) - valid_widgets),
        "native_filters_count": len(raw_native_filters),
        "is_valid": len(errors) == 0,
    }
    if errors and args.strict:
        return fail(
            error="Dashboard draft validation failed",
            data=data,
            warnings=warnings,
            validation_errors=errors,
            suggestions=["Corrija validation_errors antes de chamar lens.save_dashboard_draft."],
        )
    return ok(
        data=data,
        warnings=warnings,
        validation_errors=errors,
        suggestions=["Dashboard validado. Se necessario, rode lens.save_dashboard_draft para persistir o estado final."],
    )


async def tool_suggest_best_visualization(args: SuggestBestVisualizationArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    column_types = dataset_column_types(dataset)
    validation_errors: list[MCPToolValidationError] = []
    warnings: list[str] = []

    for index, dimension in enumerate(args.dimensions):
        if dimension not in column_types:
            validation_errors.append(
                MCPToolValidationError(
                    code="unknown_dimension_column",
                    field=f"dimensions[{index}]",
                    message=f"Column '{dimension}' does not exist in dataset schema",
                )
            )
    if args.time_column and args.time_column not in column_types:
        validation_errors.append(
            MCPToolValidationError(
                code="unknown_time_column",
                field="time_column",
                message=f"Column '{args.time_column}' does not exist in dataset schema",
            )
        )
    if validation_errors:
        return fail(
            error="Visualization suggestion input validation failed",
            validation_errors=validation_errors,
            suggestions=["Use lens.get_dataset_schema para inspecionar os nomes corretos de colunas."],
        )

    known_metrics = {str(item.name).strip().lower() for item in (dataset.metrics or []) if getattr(item, "name", None)}
    metric_column = None
    for metric in args.metrics:
        if metric in column_types:
            metric_column = metric
            break
    if metric_column is None:
        metric_column = _fallback_numeric(column_types)
    if metric_column is None:
        warnings.append("No numeric column found; KPI/line/bar suggestions may be limited.")
    for index, metric in enumerate(args.metrics):
        if metric not in column_types and metric.strip().lower() not in known_metrics:
            warnings.append(f"metrics[{index}] '{metric}' not found as schema column or semantic metric name")

    dimension_column = args.dimensions[0] if args.dimensions else _fallback_categorical(column_types)
    temporal_column = args.time_column or _fallback_temporal(column_types)

    candidates: list[dict[str, Any]] = []
    if temporal_column and metric_column:
        candidates.append(
            {
                "widget_type": "line",
                "score": _score_suggestion(0.92, goal=args.goal, widget_type="line"),
                "reason": "Time-series with metric is best represented with line chart.",
            }
        )
    if dimension_column and metric_column:
        candidates.extend(
            [
                {
                    "widget_type": "bar",
                    "score": _score_suggestion(0.88, goal=args.goal, widget_type="bar"),
                    "reason": "Single categorical dimension with metric favors ranking/comparison bars.",
                },
                {
                    "widget_type": "column",
                    "score": _score_suggestion(0.83, goal=args.goal, widget_type="column"),
                    "reason": "Column chart works for category comparisons with one or more metrics.",
                },
                {
                    "widget_type": "donut",
                    "score": _score_suggestion(0.74, goal=args.goal, widget_type="donut"),
                    "reason": "Donut can highlight part-to-whole share with one metric.",
                },
            ]
        )
    if metric_column and not args.dimensions and not temporal_column:
        candidates.append(
            {
                "widget_type": "kpi",
                "score": _score_suggestion(0.9, goal=args.goal, widget_type="kpi"),
                "reason": "Single metric without split is ideal for KPI card.",
            }
        )
    candidates.append(
        {
            "widget_type": "table",
            "score": _score_suggestion(0.62, goal=args.goal, widget_type="table"),
            "reason": "Table is robust fallback for exploratory validation and detailed inspection.",
        }
    )

    ranked = sorted(candidates, key=lambda item: (-float(item["score"]), str(item["widget_type"])))[: int(args.max_suggestions)]
    all_columns = list(column_types.keys())
    suggestions = [
        {
            **item,
            "recommended_config": _suggested_widget_config(
                widget_type=item["widget_type"],
                metric_column=metric_column,
                dimension_column=dimension_column,
                time_column=temporal_column,
                all_columns=all_columns,
            ),
        }
        for item in ranked
    ]
    return ok(
        data={
            "dataset_id": int(dataset.id),
            "inputs": {
                "metrics": args.metrics,
                "dimensions": args.dimensions,
                "time_column": args.time_column,
                "goal": args.goal,
            },
            "suggestions_ranked": suggestions,
        },
        warnings=warnings,
        suggestions=["Use lens.validate_widget_config na configuracao escolhida antes de adicionar widget ao draft."],
    )


VALIDATION_TOOL_SPECS = [
    {
        "name": "lens.validate_widget_config",
        "category": "validation",
        "description": "Valida configuracao de widget contra schema/semantica do dataset e contexto opcional de dashboard.",
        "input_model": ValidateWidgetConfigArgs,
        "handler": tool_validate_widget_config,
    },
    {
        "name": "lens.validate_dashboard_draft",
        "category": "validation",
        "description": "Valida consistencia de dashboard draft (widgets, filtros nativos e referencias de layout).",
        "input_model": ValidateDashboardDraftArgs,
        "handler": tool_validate_dashboard_draft,
    },
    {
        "name": "lens.suggest_best_visualization",
        "category": "validation",
        "description": "Sugere visualizacoes com ranking heuristico para a pergunta atual no dataset.",
        "input_model": SuggestBestVisualizationArgs,
        "handler": tool_suggest_best_visualization,
    },
]

