from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, joinedload
from datetime import datetime
from statistics import mean
import json

from app.shared.infrastructure.database import get_db
from app.modules.widgets.application.execution_coordinator import _to_engine_query_spec, get_dashboard_widget_executor
from app.modules.core.legacy.models import Dashboard, DashboardWidget, Dataset, DataSource, User, View
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user
from app.modules.core.legacy.schemas import (
    DashboardResponse,
    DashboardCreateRequest,
    DashboardUpdateRequest,
    DashboardWidgetResponse,
    DashboardWidgetCreateRequest,
    DashboardWidgetUpdateRequest,
    DashboardWidgetDataResponse,
    DashboardWidgetBatchDataRequest,
    DashboardWidgetBatchDataResponse,
    DashboardWidgetBatchDataItemResponse,
    DashboardCatalogItemResponse,
    DashboardDebugQueriesRequest,
    DashboardDebugQueriesResponse,
    DashboardDebugQueryItemResponse,
    DashboardDebugFinalQueryItemResponse,
)
from app.modules.widgets.domain.config import (
    FilterConfig,
    WidgetConfig,
    WidgetConfigValidationError,
    validate_widget_config_against_columns,
)

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _widget_load_cost(widget: DashboardWidget) -> float:
    payload = widget.query_config if isinstance(widget.query_config, dict) else {}
    widget_type = payload.get("widget_type") or widget.widget_type
    base_score = {
        "text": 4.0,
        "kpi": 16.0,
        "line": 22.0,
        "bar": 24.0,
        "column": 24.0,
        "donut": 24.0,
        "table": 34.0,
        "dre": 32.0,
    }.get(str(widget_type), 18.0)

    metrics = len(payload.get("metrics") or [])
    dimensions = len(payload.get("dimensions") or [])
    filters = len(payload.get("filters") or [])
    order_by = len(payload.get("order_by") or [])
    size_cfg = payload.get("size") if isinstance(payload.get("size"), dict) else {}
    width_raw = size_cfg.get("width", 1) if isinstance(size_cfg, dict) else 1
    try:
        width = max(1, min(4, int(width_raw)))
    except Exception:
        width = 1

    width_score = ((width - 1) / 3.0) * 8.0
    filter_score = min(12.0, filters * 2.0)
    dimension_score = min(8.0, dimensions * 2.0)
    metric_score = min(6.0, max(0, metrics - 1) * 2.0)
    order_score = min(4.0, order_by * 1.5)

    table_score = 0.0
    if widget_type in {"table", "dre"}:
        columns = len(payload.get("columns") or [])
        page_size_raw = payload.get("table_page_size") or payload.get("limit") or 25
        try:
            page_size = max(1, int(page_size_raw))
        except Exception:
            page_size = 25
        table_score = min(18.0, columns * 1.5 + (page_size / 15.0))

    bar_score = 0.0
    if widget_type in {"bar", "column", "donut"}:
        top_n_raw = payload.get("top_n")
        if top_n_raw is None:
            bar_score += 7.0
        else:
            try:
                top_n = max(1, int(top_n_raw))
                bar_score += min(6.0, top_n / 20.0)
            except Exception:
                bar_score += 7.0

    total = base_score + width_score + filter_score + dimension_score + metric_score + order_score + table_score + bar_score
    return max(0.0, min(100.0, total))


def _dashboard_load_score(dashboard: Dashboard) -> float:
    if not dashboard.widgets:
        return 0.0
    return round(mean([_widget_load_cost(widget) for widget in dashboard.widgets]), 1)


def _runtime_score(execution_values: list[int]) -> tuple[float | None, int | None]:
    if not execution_values:
        return None, None
    ordered = sorted(max(0, int(value)) for value in execution_values)
    avg_ms = sum(ordered) / len(ordered)
    p95_index = max(0, int(len(ordered) * 0.95) - 1)
    p95_ms = ordered[p95_index]

    avg_component = max(0.0, min(55.0, ((avg_ms - 80.0) / 1200.0) * 55.0))
    p95_component = max(0.0, min(45.0, ((p95_ms - 120.0) / 2500.0) * 45.0))
    return round(avg_component + p95_component, 1), p95_ms


def _combined_load_score(
    *,
    complexity_score: float,
    runtime_score: float | None,
    telemetry_coverage: float,
    last_widget_executed_at: datetime | None,
) -> float:
    if runtime_score is None:
        return round(max(0.0, min(100.0, complexity_score)), 1)

    recency_factor = 0.3
    if last_widget_executed_at:
        age_days = max(0.0, (datetime.utcnow() - last_widget_executed_at).total_seconds() / 86400.0)
        if age_days <= 1:
            recency_factor = 1.0
        elif age_days <= 7:
            recency_factor = 0.75
        elif age_days <= 30:
            recency_factor = 0.5
        else:
            recency_factor = 0.3

    runtime_weight = max(0.0, min(1.0, telemetry_coverage * recency_factor))
    combined = (complexity_score * (1.0 - runtime_weight)) + (runtime_score * runtime_weight)
    return round(max(0.0, min(100.0, combined)), 1)


def _widget_response(widget: DashboardWidget) -> DashboardWidgetResponse:
    return DashboardWidgetResponse.model_validate(widget)


def _ensure_dashboard_dataset_is_refreshable(dashboard: Dashboard) -> None:
    dataset = dashboard.dataset
    if not dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    if not dataset.is_active:
        raise HTTPException(status_code=409, detail="Dashboard dataset is inactive; data refresh is disabled")
    if not dataset.datasource or not dataset.datasource.is_active:
        raise HTTPException(status_code=409, detail="Dashboard datasource is inactive; data refresh is disabled")
    if not dataset.view or not dataset.view.is_active:
        raise HTTPException(status_code=409, detail="Dashboard table is inactive; data refresh is disabled")


def _view_column_types(dashboard: Dashboard) -> dict[str, str]:
    dataset = dashboard.dataset
    if not dataset or not dataset.view:
        raise HTTPException(status_code=400, detail="Dashboard dataset/view is unavailable")
    return {column.column_name: column.column_type for column in dataset.view.columns}


def _validate_dashboard_native_filters(filters: list[FilterConfig], dashboard: Dashboard) -> None:
    _validate_native_filters_against_column_types(filters, _view_column_types(dashboard))


def _validate_native_filters_against_column_types(filters: list[FilterConfig], column_types: dict[str, str]) -> None:
    if not filters:
        return
    invalid: list[str] = []
    for index, filter_config in enumerate(filters):
        if filter_config.column not in column_types:
            invalid.append(f"native_filters[{index}].column")
    if invalid:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Dashboard native filters validation failed",
                "field_errors": {field: ["Column does not exist in dataset view"] for field in invalid},
            },
        )


def _view_full_name(dashboard: Dashboard) -> str:
    dataset = dashboard.dataset
    if not dataset or not dataset.view:
        raise HTTPException(status_code=400, detail="Dashboard dataset/view is unavailable")
    return f"{dataset.view.schema_name}.{dataset.view.view_name}"


def _parse_widget_config(payload: DashboardWidgetCreateRequest | DashboardWidgetUpdateRequest) -> WidgetConfig:
    raw = payload.config.model_dump() if payload.config else payload.query_config
    if raw is None:
        raise HTTPException(status_code=400, detail="Widget config payload is required")
    if isinstance(raw, dict) and "widget_type" not in raw and "type" in raw:
        raw = _adapt_legacy_query_config(raw)
    try:
        return WidgetConfig.model_validate(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid widget config schema: {exc}")


def _parse_native_filters_from_payload(raw_filters: list) -> list[FilterConfig]:
    try:
        return [FilterConfig.model_validate(item) for item in raw_filters]
    except Exception:
        return []


def _resolve_widget_config(
    widget: DashboardWidget,
    global_filters: list[FilterConfig] | None = None,
    native_filters_override: list[FilterConfig] | None = None,
) -> WidgetConfig:
    payload = widget.query_config
    if isinstance(payload, dict) and "widget_type" not in payload and "type" in payload:
        payload = _adapt_legacy_query_config(payload)
        dashboard = widget.dashboard
        if dashboard and dashboard.dataset and dashboard.dataset.view:
            payload["view_name"] = f"{dashboard.dataset.view.schema_name}.{dashboard.dataset.view.view_name}"

    config = WidgetConfig.model_validate(payload)
    dashboard_native_filters: list[FilterConfig] = native_filters_override or []
    if native_filters_override is None and widget.dashboard and isinstance(widget.dashboard.native_filters, list):
        dashboard_native_filters = _parse_native_filters_from_payload(widget.dashboard.native_filters)

    if config.widget_type != "text":
        merged_filters = [*dashboard_native_filters, *config.filters, *(global_filters or [])]
        config = config.model_copy(update={"filters": merged_filters})
        try:
            validate_widget_config_against_columns(config, _view_column_types(widget.dashboard))
        except WidgetConfigValidationError as exc:
            raise HTTPException(status_code=400, detail=exc.to_detail())

    return config


def _adapt_legacy_query_config(raw: dict) -> dict:
    widget_type = raw.get("type") or "table"
    metrics = []
    for metric in raw.get("metrics", []) or []:
        if not isinstance(metric, dict):
            continue
        metrics.append(
            {
                "op": metric.get("aggregation") or metric.get("op") or "count",
                "column": metric.get("column"),
            }
        )
    order_by = []
    for sort in raw.get("sorts", []) or []:
        if not isinstance(sort, dict):
            continue
        order_by.append(
            {
                "column": sort.get("column"),
                "direction": sort.get("direction") or "desc",
            }
        )
    filters = []
    op_map = {"=": "eq", "!=": "neq", ">": "gt", "<": "lt", ">=": "gte", "<=": "lte"}
    for item in raw.get("filters", []) or []:
        if not isinstance(item, dict):
            continue
        filters.append(
            {
                "column": item.get("column"),
                "op": op_map.get(item.get("operator"), item.get("op") or "eq"),
                "value": item.get("value"),
            }
        )

    return {
        "widget_type": widget_type,
        "view_name": raw.get("view_name", ""),
        "metrics": metrics,
        "dimensions": raw.get("dimensions", []),
        "filters": filters,
        "order_by": order_by,
        "columns": raw.get("columns"),
        "top_n": raw.get("top_n"),
        "limit": raw.get("limit"),
        "offset": raw.get("offset"),
    }


def _validate_and_normalize_config(config: WidgetConfig, dashboard: Dashboard) -> WidgetConfig:
    expected_view = _view_full_name(dashboard)
    if config.view_name != expected_view:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Widget config validation failed",
                "field_errors": {
                    "view_name": [f"Expected '{expected_view}' for this dashboard dataset view"],
                },
            },
        )
    try:
        validate_widget_config_against_columns(config, _view_column_types(dashboard))
        return config
    except WidgetConfigValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.to_detail())


@router.post("/{dashboard_id}/debug/queries", response_model=DashboardDebugQueriesResponse)
async def debug_dashboard_queries(
    dashboard_id: int,
    request: DashboardDebugQueriesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    dashboard = (
        db.query(Dashboard)
        .options(
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(Dashboard.id == dashboard_id)
        .first()
    )
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    native_override = request.native_filters_override
    items: list[DashboardDebugQueryItemResponse] = []
    resolved_configs: dict[int, WidgetConfig] = {}
    resolved_widgets: list[DashboardWidget] = []
    for widget in sorted(dashboard.widgets, key=lambda item: (item.position, item.id)):
        try:
            config = _resolve_widget_config(
                widget,
                global_filters=request.global_filters,
                native_filters_override=native_override,
            )
            resolved_configs[widget.id] = config
            resolved_widgets.append(widget)
            if config.widget_type == "text":
                items.append(
                    DashboardDebugQueryItemResponse(
                        widget_id=widget.id,
                        widget_type=widget.widget_type,
                        title=widget.title,
                        status="text_widget",
                    )
                )
                continue

            items.append(
                DashboardDebugQueryItemResponse(
                    widget_id=widget.id,
                    widget_type=widget.widget_type,
                    title=widget.title,
                    status="ok",
                    sql="ENGINE_MANAGED_QUERY",
                    query_spec=_to_engine_query_spec(config),
                    params=[],
                )
            )
        except HTTPException as exc:
            detail = exc.detail
            detail_text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)
            items.append(
                DashboardDebugQueryItemResponse(
                    widget_id=widget.id,
                    widget_type=widget.widget_type,
                    title=widget.title,
                    status="error",
                    error=detail_text,
                )
            )
        except Exception as exc:
            items.append(
                DashboardDebugQueryItemResponse(
                    widget_id=widget.id,
                    widget_type=widget.widget_type,
                    title=widget.title,
                    status="error",
                    error=repr(exc),
                )
            )

    final_items: list[DashboardDebugFinalQueryItemResponse] = []
    if dashboard.dataset:
        executor = get_dashboard_widget_executor()
        units = executor.preview_final_execution_units(
            datasource=dashboard.dataset.datasource,
            dataset_id=dashboard.dataset_id,
            widgets=resolved_widgets,
            configs_by_widget_id=resolved_configs,
            user=current_user,
            runtime_filters=request.global_filters,
        )
        for unit in units:
            final_items.append(
                DashboardDebugFinalQueryItemResponse(
                    execution_kind=unit.execution_kind,
                    widget_ids=unit.widget_ids,
                    sql=unit.sql,
                    query_spec=unit.query_spec,
                    params=unit.params,
                    sql_hash=unit.sql_hash,
                    fingerprint_key=unit.fingerprint_key,
                )
            )

    view_name = None
    datasource_id = None
    if dashboard.dataset:
        datasource_id = dashboard.dataset.datasource_id
        if dashboard.dataset.view:
            view_name = f"{dashboard.dataset.view.schema_name}.{dashboard.dataset.view.view_name}"

    return DashboardDebugQueriesResponse(
        dashboard_id=dashboard.id,
        dashboard_name=dashboard.name,
        dataset_id=dashboard.dataset_id,
        datasource_id=datasource_id,
        view_name=view_name,
        items=items,
        final_items=final_items,
        mode=request.mode,
    )


@router.get("", response_model=list[DashboardResponse])
async def list_dashboards(
    dataset_id: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Dashboard)
    if dataset_id is not None:
        query = query.filter(Dashboard.dataset_id == dataset_id)
    return query.all()


@router.get("/catalog", response_model=list[DashboardCatalogItemResponse])
async def list_dashboard_catalog(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboards = (
        db.query(Dashboard)
        .options(
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.created_by_user),
            joinedload(Dashboard.dataset)
            .joinedload(Dataset.datasource)
            .joinedload(DataSource.created_by_user),
        )
        .all()
    )
    items: list[DashboardCatalogItemResponse] = []
    for dashboard in dashboards:
        widget_updated_values = [widget.updated_at for widget in dashboard.widgets if widget.updated_at]
        last_edited_at = max([dashboard.updated_at, *widget_updated_values]) if widget_updated_values else dashboard.updated_at

        creator = dashboard.created_by_user
        if creator is None and dashboard.dataset and dashboard.dataset.datasource:
            creator = dashboard.dataset.datasource.created_by_user

        execution_values = [int(widget.last_execution_ms) for widget in dashboard.widgets if widget.last_execution_ms is not None]
        execution_timestamps = [widget.last_executed_at for widget in dashboard.widgets if widget.last_executed_at]
        telemetry_coverage = (len(execution_values) / len(dashboard.widgets)) if dashboard.widgets else 0.0
        complexity_score = _dashboard_load_score(dashboard)
        runtime_score, p95_execution_ms = _runtime_score(execution_values)
        last_widget_executed_at = max(execution_timestamps) if execution_timestamps else None
        load_score = _combined_load_score(
            complexity_score=complexity_score,
            runtime_score=runtime_score,
            telemetry_coverage=telemetry_coverage,
            last_widget_executed_at=last_widget_executed_at,
        )

        items.append(
            DashboardCatalogItemResponse(
                id=dashboard.id,
                dataset_id=dashboard.dataset_id,
                dataset_name=dashboard.dataset.name if dashboard.dataset else f"Dataset {dashboard.dataset_id}",
                name=dashboard.name,
                created_by_id=creator.id if creator else None,
                created_by_name=creator.full_name if creator else None,
                created_by_email=creator.email if creator else None,
                widget_count=len(dashboard.widgets),
                last_edited_at=last_edited_at,
                last_data_refresh_at=dashboard.dataset.datasource.last_synced_at if dashboard.dataset and dashboard.dataset.datasource else None,
                load_score=load_score,
                complexity_score=complexity_score,
                runtime_score=runtime_score,
                telemetry_coverage=round(telemetry_coverage, 3),
                avg_widget_execution_ms=round(sum(execution_values) / len(execution_values), 1) if execution_values else None,
                p95_widget_execution_ms=p95_execution_ms,
                slowest_widget_execution_ms=max(execution_values) if execution_values else None,
                last_widget_executed_at=last_widget_executed_at,
            )
        )
    items.sort(key=lambda item: item.last_edited_at, reverse=True)
    return items


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    return dashboard


@router.post("", response_model=DashboardResponse)
async def create_dashboard(
    request: DashboardCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = db.query(Dataset).filter(Dataset.id == request.dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    if not dataset.is_active:
        raise HTTPException(status_code=400, detail="Dataset is inactive")
    if not dataset.datasource or not dataset.datasource.is_active:
        raise HTTPException(status_code=400, detail="Dataset datasource is inactive")
    if not dataset.view:
        raise HTTPException(status_code=400, detail="Dataset view is unavailable")
    if not dataset.view.is_active:
        raise HTTPException(status_code=400, detail="Dataset view is inactive")

    _validate_native_filters_against_column_types(
        request.native_filters,
        {column.column_name: column.column_type for column in dataset.view.columns},
    )

    dashboard = Dashboard(
        dataset_id=request.dataset_id,
        name=request.name,
        description=request.description,
        layout_config=request.layout_config,
        native_filters=[item.model_dump(mode="json") for item in request.native_filters],
        is_active=request.is_active,
        created_by_id=current_user.id,
    )
    db.add(dashboard)
    db.commit()
    db.refresh(dashboard)
    return dashboard


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
async def update_dashboard(
    dashboard_id: int,
    request: DashboardUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    if request.name is not None:
        dashboard.name = request.name
    if request.description is not None:
        dashboard.description = request.description
    if request.layout_config is not None:
        dashboard.layout_config = request.layout_config
    if request.native_filters is not None:
        _validate_dashboard_native_filters(request.native_filters, dashboard)
        dashboard.native_filters = [item.model_dump(mode="json") for item in request.native_filters]
    if request.is_active is not None:
        dashboard.is_active = request.is_active

    db.commit()
    db.refresh(dashboard)
    return dashboard


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    db.delete(dashboard)
    db.commit()


@router.post("/{dashboard_id}/widgets", response_model=DashboardWidgetResponse)
async def create_widget(
    dashboard_id: int,
    request: DashboardWidgetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")

    config = _parse_widget_config(request)
    if request.widget_type != config.widget_type:
        raise HTTPException(status_code=400, detail="widget_type must match config.widget_type")
    config = _validate_and_normalize_config(config, dashboard)

    widget = DashboardWidget(
        dashboard_id=dashboard_id,
        widget_type=request.widget_type,
        title=request.title,
        position=request.position,
        query_config=config.model_dump(mode="json"),
        config_version=request.config_version,
        visualization_config=request.visualization_config,
    )
    db.add(widget)
    db.commit()
    db.refresh(widget)
    return _widget_response(widget)


@router.patch("/{dashboard_id}/widgets/{widget_id}", response_model=DashboardWidgetResponse)
async def update_widget(
    dashboard_id: int,
    widget_id: int,
    request: DashboardWidgetUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    widget = db.query(DashboardWidget).filter(
        DashboardWidget.id == widget_id,
        DashboardWidget.dashboard_id == dashboard_id,
    ).first()
    if not widget:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")

    dashboard = widget.dashboard

    if request.widget_type is not None:
        widget.widget_type = request.widget_type
    if request.title is not None:
        widget.title = request.title
    if request.position is not None:
        widget.position = request.position
    if request.config_version is not None:
        widget.config_version = request.config_version
    if request.visualization_config is not None:
        widget.visualization_config = request.visualization_config

    if request.config is not None or request.query_config is not None:
        config = _parse_widget_config(request)
        if request.widget_type and request.widget_type != config.widget_type:
            raise HTTPException(status_code=400, detail="widget_type must match config.widget_type")
        if request.widget_type is None and widget.widget_type != config.widget_type:
            raise HTTPException(status_code=400, detail="config.widget_type must match persisted widget_type")
        config = _validate_and_normalize_config(config, dashboard)
        widget.query_config = config.model_dump(mode="json")
        widget.widget_type = config.widget_type

    db.commit()
    db.refresh(widget)
    return _widget_response(widget)


@router.delete("/{dashboard_id}/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    dashboard_id: int,
    widget_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    widget = db.query(DashboardWidget).filter(
        DashboardWidget.id == widget_id,
        DashboardWidget.dashboard_id == dashboard_id,
    ).first()
    if not widget:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")
    db.delete(widget)
    db.commit()


@router.get("/{dashboard_id}/widgets/{widget_id}/data", response_model=DashboardWidgetDataResponse)
async def get_widget_data(
    dashboard_id: int,
    widget_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    widget = (
        db.query(DashboardWidget)
        .options(
            joinedload(DashboardWidget.dashboard)
            .joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(DashboardWidget.dashboard).joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(
            DashboardWidget.id == widget_id,
            DashboardWidget.dashboard_id == dashboard_id,
        )
        .first()
    )
    if not widget:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")
    dashboard = widget.dashboard
    if not dashboard or not dashboard.dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    _ensure_dashboard_dataset_is_refreshable(dashboard)

    config = _resolve_widget_config(widget)
    executor = get_dashboard_widget_executor()
    result_by_widget = await executor.execute_widgets(
        dashboard_id=dashboard_id,
        dataset_id=dashboard.dataset_id,
        datasource=dashboard.dataset.datasource,
        widgets=[widget],
        configs_by_widget_id={widget.id: config},
        user=current_user,
        runtime_filters=[],
        correlation_id=_resolve_correlation_id(request),
    )
    result = result_by_widget[widget.id]
    widget.last_execution_ms = result.metadata.execution_time_ms
    widget.last_executed_at = datetime.utcnow()
    db.commit()
    return DashboardWidgetDataResponse(
        columns=result.payload.columns,
        rows=result.payload.rows,
        row_count=result.payload.row_count,
        cache_hit=result.metadata.cache_hit,
        stale=result.metadata.stale,
        deduped=result.metadata.deduped,
        batched=result.metadata.batched,
        degraded=result.metadata.degraded,
        execution_time_ms=result.metadata.execution_time_ms,
        sql_hash=result.metadata.sql_hash,
    )


@router.post("/{dashboard_id}/widgets/data", response_model=DashboardWidgetBatchDataResponse)
async def get_widget_data_batch(
    dashboard_id: int,
    request: DashboardWidgetBatchDataRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not request.widget_ids:
        return DashboardWidgetBatchDataResponse(results=[])

    widgets = (
        db.query(DashboardWidget)
        .options(
            joinedload(DashboardWidget.dashboard)
            .joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(DashboardWidget.dashboard).joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(
            DashboardWidget.dashboard_id == dashboard_id,
            DashboardWidget.id.in_(request.widget_ids),
        )
        .all()
    )
    widget_by_id = {widget.id: widget for widget in widgets}
    missing_ids = [widget_id for widget_id in request.widget_ids if widget_id not in widget_by_id]
    if missing_ids:
        raise HTTPException(status_code=404, detail=f"Widgets not found: {missing_ids}")

    first_widget = widget_by_id[request.widget_ids[0]]
    dashboard = first_widget.dashboard
    if not dashboard or not dashboard.dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    _ensure_dashboard_dataset_is_refreshable(dashboard)

    configs_by_widget_id: dict[int, WidgetConfig] = {}
    for widget in widgets:
        configs_by_widget_id[widget.id] = _resolve_widget_config(widget, request.global_filters)

    executor = get_dashboard_widget_executor()
    result_by_widget = await executor.execute_widgets(
        dashboard_id=dashboard_id,
        dataset_id=dashboard.dataset_id,
        datasource=dashboard.dataset.datasource,
        widgets=widgets,
        configs_by_widget_id=configs_by_widget_id,
        user=current_user,
        runtime_filters=request.global_filters,
        correlation_id=_resolve_correlation_id(http_request),
    )

    results: list[DashboardWidgetBatchDataItemResponse] = []
    for widget_id in request.widget_ids:
        widget = widget_by_id[widget_id]
        execution = result_by_widget[widget_id]
        widget.last_execution_ms = execution.metadata.execution_time_ms
        widget.last_executed_at = datetime.utcnow()
        results.append(
            DashboardWidgetBatchDataItemResponse(
                widget_id=widget_id,
                columns=execution.payload.columns,
                rows=execution.payload.rows,
                row_count=execution.payload.row_count,
                cache_hit=execution.metadata.cache_hit,
                stale=execution.metadata.stale,
                deduped=execution.metadata.deduped,
                batched=execution.metadata.batched,
                degraded=execution.metadata.degraded,
                execution_time_ms=execution.metadata.execution_time_ms,
                sql_hash=execution.metadata.sql_hash,
            )
        )
    db.commit()

    return DashboardWidgetBatchDataResponse(results=results)


