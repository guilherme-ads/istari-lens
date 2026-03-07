from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy import func
from datetime import datetime, timedelta
from statistics import mean
import json
import logging
from uuid import uuid4

from app.shared.infrastructure.database import get_db
from app.modules.widgets.application.execution_coordinator import _to_engine_query_spec, get_dashboard_widget_executor
from app.modules.core.legacy.models import (
    Dashboard,
    DashboardWidget,
    DashboardEmailShare,
    DashboardVersion,
    DashboardEditLock,
    Dataset,
    DataSource,
    User,
    View,
)
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user
from app.modules.dashboards.application.ai_generation import generate_dashboard_with_ai_service
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
    DashboardEmailShareResponse,
    DashboardShareUpsertRequest,
    DashboardVisibilityUpdateRequest,
    DashboardSharingResponse,
    DashboardShareableUserResponse,
    DashboardDebugQueriesRequest,
    DashboardDebugQueriesResponse,
    DashboardDebugQueryItemResponse,
    DashboardDebugFinalQueryItemResponse,
    DashboardSaveRequest,
    DashboardVersionSummaryResponse,
    DashboardExportResponse,
    DashboardImportRequest,
    DashboardImportConflictResponse,
    DashboardImportPreviewResponse,
    DashboardAIGenerateRequest,
    DashboardAIGenerateResponse,
    DashboardPublicResponse,
    DashboardEditLockResponse,
)
from app.modules.widgets.domain.config import (
    FilterConfig,
    WidgetConfig,
    WidgetConfigValidationError,
    validate_widget_config_against_columns,
)

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

ACCESS_RANK = {"view": 1, "edit": 2, "owner": 3}
DATASET_WIDGET_VIEW_NAME = "__dataset_base"
LOCK_TTL_MINUTES = 15
MAX_DASHBOARD_VERSIONS = 3
logger = logging.getLogger("uvicorn.error")


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _new_public_share_key() -> str:
    return uuid4().hex


def _resolve_dashboard_access(dashboard: Dashboard, user: User) -> tuple[str, str] | None:
    if dashboard.created_by_id == user.id:
        return ("owner", "owner")

    normalized_email = _normalize_email(user.email)
    direct_level: str | None = None
    for share in dashboard.email_shares or []:
        if _normalize_email(share.email) != normalized_email:
            continue
        if share.permission == "edit":
            direct_level = "edit"
            break
        if direct_level is None:
            direct_level = "view"

    workspace_level: str | None = None
    if dashboard.visibility == "workspace_edit":
        workspace_level = "edit"
    elif dashboard.visibility == "workspace_view":
        workspace_level = "view"
    elif dashboard.visibility == "public_view":
        workspace_level = "view"

    if direct_level and workspace_level:
        if ACCESS_RANK[direct_level] >= ACCESS_RANK[workspace_level]:
            return (direct_level, "direct")
        return (workspace_level, "workspace")
    if direct_level:
        return (direct_level, "direct")
    if workspace_level:
        source = "public" if dashboard.visibility == "public_view" else "workspace"
        return (workspace_level, source)
    if user.is_admin and dashboard.visibility == "public_view":
        return ("view", "public")
    return None


def _require_dashboard_access(
    dashboard: Dashboard,
    user: User,
    min_level: str = "view",
) -> tuple[str, str]:
    resolved = _resolve_dashboard_access(dashboard, user)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    level, source = resolved
    if ACCESS_RANK[level] < ACCESS_RANK[min_level]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission for this dashboard action")
    return level, source


def _load_dashboard_for_user(
    db: Session,
    dashboard_id: int,
    user: User,
    min_level: str = "view",
    options: list | None = None,
) -> tuple[Dashboard, str, str]:
    query = db.query(Dashboard)
    if options:
        query = query.options(*options)
    dashboard = query.filter(Dashboard.id == dashboard_id).first()
    if not dashboard:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    level, source = _require_dashboard_access(dashboard, user, min_level=min_level)
    return dashboard, level, source


def _dashboard_response_for_user(dashboard: Dashboard, user: User) -> DashboardResponse:
    level, source = _require_dashboard_access(dashboard, user, min_level="view")
    return DashboardResponse(
        id=dashboard.id,
        dataset_id=dashboard.dataset_id,
        created_by_id=dashboard.created_by_id,
        is_owner=level == "owner",
        access_level=level,
        access_source=source,
        visibility=dashboard.visibility or "private",
        public_share_key=dashboard.public_share_key,
        name=dashboard.name,
        description=dashboard.description,
        is_active=dashboard.is_active,
        layout_config=dashboard.layout_config or [],
        native_filters=dashboard.native_filters or [],
        widgets=[_widget_response(widget) for widget in dashboard.widgets],
        created_at=dashboard.created_at,
        updated_at=dashboard.updated_at,
    )


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


def _dashboard_snapshot_payload(dashboard: Dashboard, *, include_visibility: bool = True) -> dict:
    widgets = sorted(dashboard.widgets or [], key=lambda item: (item.position, item.id))
    payload = {
        "dataset_id": dashboard.dataset_id,
        "name": dashboard.name,
        "description": dashboard.description,
        "is_active": dashboard.is_active,
        "layout_config": dashboard.layout_config or [],
        "native_filters": dashboard.native_filters or [],
        "widgets": [
            {
                "id": widget.id,
                "widget_type": widget.widget_type,
                "title": widget.title,
                "position": widget.position,
                "config": widget.query_config if isinstance(widget.query_config, dict) else {},
                "config_version": widget.config_version,
                "visualization_config": widget.visualization_config,
            }
            for widget in widgets
        ],
    }
    if include_visibility:
        payload["visibility"] = dashboard.visibility or "private"
    return payload


def _persist_dashboard_version(
    db: Session,
    dashboard: Dashboard,
    user: User | None,
) -> None:
    current_version = (
        db.query(func.max(DashboardVersion.version_number))
        .filter(DashboardVersion.dashboard_id == dashboard.id)
        .scalar()
    ) or 0
    version = DashboardVersion(
        dashboard_id=dashboard.id,
        version_number=int(current_version) + 1,
        snapshot=_dashboard_snapshot_payload(dashboard),
        created_by_id=user.id if user else None,
    )
    db.add(version)
    db.flush()

    versions = (
        db.query(DashboardVersion)
        .filter(DashboardVersion.dashboard_id == dashboard.id)
        .order_by(DashboardVersion.version_number.desc())
        .all()
    )
    for stale in versions[MAX_DASHBOARD_VERSIONS:]:
        db.delete(stale)


def _clean_expired_lock(dashboard: Dashboard, db: Session) -> None:
    lock = dashboard.edit_lock
    if lock and lock.expires_at <= datetime.utcnow():
        db.delete(lock)
        db.flush()


def _lock_response(dashboard: Dashboard, current_user: User | None) -> DashboardEditLockResponse:
    lock = dashboard.edit_lock
    now = datetime.utcnow()
    if lock is None or lock.expires_at <= now:
        return DashboardEditLockResponse(
            dashboard_id=dashboard.id,
            is_locked=False,
            is_locked_by_current_user=False,
        )
    return DashboardEditLockResponse(
        dashboard_id=dashboard.id,
        is_locked=True,
        is_locked_by_current_user=bool(current_user and lock.user_id == current_user.id),
        locked_by_user_id=lock.user_id,
        locked_by_email=lock.user.email if lock.user else None,
        expires_at=lock.expires_at,
    )


def _commit_widget_execution_stats(db: Session, *, dashboard_id: int, widget_ids: list[int]) -> None:
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
        logger.warning(
            "Skipped widget execution stats commit due to stale row: dashboard_id=%s widget_ids=%s",
            dashboard_id,
            widget_ids,
        )


def _apply_dashboard_snapshot(
    *,
    dashboard: Dashboard,
    snapshot: dict,
    db: Session,
    apply_visibility: bool = True,
) -> None:
    dashboard.name = str(snapshot.get("name") or dashboard.name)
    dashboard.description = snapshot.get("description")
    dashboard.is_active = bool(snapshot.get("is_active", True))
    if apply_visibility:
        raw_visibility = str(snapshot.get("visibility") or "private")
        dashboard.visibility = raw_visibility if raw_visibility in {"private", "workspace_view", "workspace_edit", "public_view"} else "private"
    raw_layout = snapshot.get("layout_config") if isinstance(snapshot.get("layout_config"), list) else []
    dashboard.native_filters = snapshot.get("native_filters") or []

    incoming = snapshot.get("widgets") if isinstance(snapshot.get("widgets"), list) else []
    existing_by_id = {widget.id: widget for widget in dashboard.widgets or []}
    retained_ids: set[int] = set()
    remapped_widget_ids: dict[str, int] = {}
    created_widget_ids_in_order: list[int] = []
    for index, item in enumerate(incoming):
        if not isinstance(item, dict):
            continue
        raw_id = item.get("id")
        source_widget_key = str(raw_id) if raw_id is not None else None
        source_widget_id = int(raw_id) if isinstance(raw_id, int) else None
        widget = existing_by_id.get(source_widget_id) if source_widget_id is not None else None
        config_payload = item.get("config")
        if not isinstance(config_payload, dict):
            continue
        if widget is None:
            widget = DashboardWidget(
                dashboard_id=dashboard.id,
                widget_type=str(item.get("widget_type") or config_payload.get("widget_type") or "table"),
                title=item.get("title"),
                position=int(item.get("position") or index),
                query_config=config_payload,
                config_version=int(item.get("config_version") or 1),
                visualization_config=item.get("visualization_config"),
            )
            db.add(widget)
            db.flush()
        else:
            widget.widget_type = str(item.get("widget_type") or config_payload.get("widget_type") or widget.widget_type)
            widget.title = item.get("title")
            widget.position = int(item.get("position") or index)
            widget.query_config = config_payload
            widget.config_version = int(item.get("config_version") or widget.config_version or 1)
            widget.visualization_config = item.get("visualization_config")
        retained_ids.add(widget.id)
        if source_widget_key is not None:
            remapped_widget_ids[source_widget_key] = widget.id
        created_widget_ids_in_order.append(widget.id)

    for widget in list(dashboard.widgets or []):
        if widget.id not in retained_ids:
            db.delete(widget)

    # Preserve section/row placement while adapting source widget IDs to persisted IDs.
    normalized_layout: list[dict] = []
    fallback_widget_index = 0
    for section in raw_layout:
        if not isinstance(section, dict):
            continue
        next_section = dict(section)
        widgets_cfg = section.get("widgets")
        if isinstance(widgets_cfg, list):
            remapped_entries: list[dict] = []
            for entry in widgets_cfg:
                if not isinstance(entry, dict):
                    continue
                raw_widget_id = entry.get("widget_id")
                mapped_id = remapped_widget_ids.get(str(raw_widget_id)) if raw_widget_id is not None else None
                if mapped_id is None and fallback_widget_index < len(created_widget_ids_in_order):
                    mapped_id = created_widget_ids_in_order[fallback_widget_index]
                    fallback_widget_index += 1
                if mapped_id is None:
                    continue
                next_entry = dict(entry)
                next_entry["widget_id"] = mapped_id
                remapped_entries.append(next_entry)
            next_section["widgets"] = remapped_entries
        normalized_layout.append(next_section)
    dashboard.layout_config = normalized_layout


def _preview_dashboard_import_compatibility(
    *,
    dataset: Dataset,
    snapshot: dict,
) -> DashboardImportPreviewResponse:
    target_dataset_id = int(dataset.id)
    source_dataset_id_raw = snapshot.get("dataset_id")
    source_dataset_id = int(source_dataset_id_raw) if isinstance(source_dataset_id_raw, int) else None
    same_dataset = source_dataset_id == target_dataset_id if source_dataset_id is not None else False
    column_types = _dataset_column_types(dataset)

    conflicts: list[DashboardImportConflictResponse] = []
    total_widgets = 0
    valid_widgets = 0
    invalid_widgets = 0

    raw_native_filters = snapshot.get("native_filters")
    parsed_native_filters = _parse_native_filters_from_payload(raw_native_filters if isinstance(raw_native_filters, list) else [])
    native_filter_errors = []
    for index, native_filter in enumerate(parsed_native_filters):
        if native_filter.column not in column_types:
            native_filter_errors.append(index)
    for index in native_filter_errors:
        conflicts.append(
            DashboardImportConflictResponse(
                scope="native_filter",
                code="missing_column",
                field=f"native_filters[{index}].column",
                message="Coluna do filtro nativo nao existe no dataset de destino.",
            )
        )

    incoming_widgets = snapshot.get("widgets") if isinstance(snapshot.get("widgets"), list) else []
    for widget_index, item in enumerate(incoming_widgets):
        if not isinstance(item, dict):
            continue
        total_widgets += 1
        widget_title = str(item.get("title") or f"Widget {widget_index + 1}")
        config_payload = item.get("config")
        if not isinstance(config_payload, dict):
            invalid_widgets += 1
            conflicts.append(
                DashboardImportConflictResponse(
                    scope="widget",
                    code="invalid_config",
                    widget_index=widget_index,
                    widget_title=widget_title,
                    field=f"widgets[{widget_index}].config",
                    message="Config do widget ausente ou invalida.",
                )
            )
            continue
        normalized_payload = config_payload
        if "widget_type" not in normalized_payload and "type" in normalized_payload:
            normalized_payload = _adapt_legacy_query_config(normalized_payload)
        try:
            config = WidgetConfig.model_validate(normalized_payload)
            config = config.model_copy(update={"view_name": DATASET_WIDGET_VIEW_NAME})
            validate_widget_config_against_columns(config, column_types)
            valid_widgets += 1
        except WidgetConfigValidationError as exc:
            invalid_widgets += 1
            for field, messages in exc.field_errors.items():
                for message in messages:
                    conflicts.append(
                        DashboardImportConflictResponse(
                            scope="widget",
                            code="validation_error",
                            widget_index=widget_index,
                            widget_title=widget_title,
                            field=field,
                            message=message,
                        )
                    )
        except Exception as exc:
            invalid_widgets += 1
            conflicts.append(
                DashboardImportConflictResponse(
                    scope="widget",
                    code="invalid_config",
                    widget_index=widget_index,
                    widget_title=widget_title,
                    field=f"widgets[{widget_index}].config",
                    message=f"Config de widget invalida: {exc}",
                )
            )

    if invalid_widgets == 0 and not native_filter_errors:
        compatibility: str = "compatible"
    elif valid_widgets > 0:
        compatibility = "partial"
    else:
        compatibility = "incompatible"

    if source_dataset_id is not None and source_dataset_id != target_dataset_id:
        conflicts.insert(
            0,
            DashboardImportConflictResponse(
                scope="metadata",
                code="dataset_mismatch",
                field="dataset_id",
                message=f"Dashboard de origem usa dataset {source_dataset_id}, destino atual e {target_dataset_id}.",
            ),
        )

    return DashboardImportPreviewResponse(
        source_dataset_id=source_dataset_id,
        target_dataset_id=target_dataset_id,
        same_dataset=same_dataset,
        compatibility=compatibility,  # type: ignore[arg-type]
        total_widgets=total_widgets,
        valid_widgets=valid_widgets,
        invalid_widgets=invalid_widgets,
        conflicts=conflicts,
    )


def _ensure_dashboard_dataset_is_refreshable(dashboard: Dashboard) -> None:
    dataset = dashboard.dataset
    if not dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    if not dataset.is_active:
        raise HTTPException(status_code=409, detail="Dashboard dataset is inactive; data refresh is disabled")
    if not dataset.datasource or not dataset.datasource.is_active:
        raise HTTPException(status_code=409, detail="Dashboard datasource is inactive; data refresh is disabled")
    if dataset.base_query_spec is None and (not dataset.view or not dataset.view.is_active):
        raise HTTPException(status_code=409, detail="Dashboard dataset has no active base query or legacy view")


def _semantic_raw_type(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized == "temporal":
        return "timestamp"
    if normalized in {"numeric", "boolean", "text"}:
        return normalized
    return value or "text"


def _dataset_column_types(dataset: Dataset) -> dict[str, str]:
    semantic = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
    columns: dict[str, str] = {}
    for item in semantic:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        data_type = item.get("type")
        if not isinstance(name, str) or not name.strip():
            continue
        item_raw_type = item.get("raw_type")
        if isinstance(item_raw_type, str) and item_raw_type.strip():
            raw_type = item_raw_type.strip()
        else:
            raw_type = _semantic_raw_type(str(data_type) if isinstance(data_type, str) else "text")
        columns[name] = raw_type
    if columns:
        return columns
    if dataset.view:
        return {column.column_name: column.column_type for column in dataset.view.columns}
    raise HTTPException(status_code=400, detail="Dataset has no semantic columns and no legacy view columns")


def _view_column_types(dashboard: Dashboard) -> dict[str, str]:
    dataset = dashboard.dataset
    if not dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    return _dataset_column_types(dataset)


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
                "field_errors": {field: ["Column does not exist in dataset semantic model"] for field in invalid},
            },
        )


def _dataset_widget_view_name(dashboard: Dashboard) -> str:
    _ = dashboard
    return DATASET_WIDGET_VIEW_NAME


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
        if dashboard:
            payload["view_name"] = _dataset_widget_view_name(dashboard)

    config = WidgetConfig.model_validate(payload)
    dashboard_native_filters: list[FilterConfig] = native_filters_override or []
    if native_filters_override is None and widget.dashboard and isinstance(widget.dashboard.native_filters, list):
        dashboard_native_filters = _parse_native_filters_from_payload(widget.dashboard.native_filters)

    if config.widget_type != "text":
        merged_filters = [*dashboard_native_filters, *config.filters, *(global_filters or [])]
        config = config.model_copy(
            update={
                "filters": merged_filters,
                "view_name": _dataset_widget_view_name(widget.dashboard),
            }
        )
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
        "view_name": raw.get("view_name", DATASET_WIDGET_VIEW_NAME),
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
    config = config.model_copy(update={"view_name": _dataset_widget_view_name(dashboard)})
    try:
        validate_widget_config_against_columns(config, _view_column_types(dashboard))
        _validate_kpi_dependency_refs(config, dashboard)
        return config
    except WidgetConfigValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.to_detail())


def _validate_kpi_dependency_refs(config: WidgetConfig, dashboard: Dashboard) -> None:
    if config.widget_type != "kpi" or config.kpi_type != "derived":
        return
    widget_by_id = {widget.id: widget for widget in (dashboard.widgets or [])}
    field_errors: dict[str, list[str]] = {}
    for index, dep in enumerate(config.kpi_dependencies):
        if dep.source_type == "column":
            if dep.column not in _view_column_types(dashboard):
                field_errors.setdefault(f"kpi_dependencies[{index}].column", []).append("Column dependency not found in dataset semantic model")
            continue
        if dep.widget_id not in widget_by_id:
            field_errors.setdefault(f"kpi_dependencies[{index}].widget_id", []).append("Widget dependency not found in dashboard")
            continue
        target_widget = widget_by_id[dep.widget_id]
        target_type = None
        if isinstance(target_widget.query_config, dict):
            target_type = target_widget.query_config.get("widget_type") or target_widget.widget_type
        if target_type != "kpi":
            field_errors.setdefault(f"kpi_dependencies[{index}].widget_id", []).append("Widget dependency must be a KPI")
    if field_errors:
        raise HTTPException(status_code=400, detail={"message": "Widget config validation failed", "field_errors": field_errors})


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
            dataset=dashboard.dataset,
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
    query = db.query(Dashboard).options(joinedload(Dashboard.widgets), joinedload(Dashboard.email_shares))
    if dataset_id is not None:
        query = query.filter(Dashboard.dataset_id == dataset_id)
    dashboards = query.all()
    visible: list[DashboardResponse] = []
    for dashboard in dashboards:
        if _resolve_dashboard_access(dashboard, current_user) is None:
            continue
        visible.append(_dashboard_response_for_user(dashboard, current_user))
    return visible


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
            joinedload(Dashboard.email_shares),
            joinedload(Dashboard.dataset)
            .joinedload(Dataset.datasource)
            .joinedload(DataSource.created_by_user),
        )
        .all()
    )
    items: list[DashboardCatalogItemResponse] = []
    for dashboard in dashboards:
        access = _resolve_dashboard_access(dashboard, current_user)
        if access is None:
            continue
        level, source = access
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
                is_owner=level == "owner",
                access_level=level,
                access_source=source,
                visibility=dashboard.visibility or "private",
                public_share_key=dashboard.public_share_key,
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


@router.get("/shareable-users", response_model=list[DashboardShareableUserResponse])
async def list_dashboard_shareable_users(
    search: str | None = Query(default=None),
    limit: int = Query(default=8, ge=1, le=30),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = (
        db.query(User)
        .filter(User.deleted_at.is_(None), User.is_active.is_(True))
    )
    if search:
        like = f"%{search.strip()}%"
        query = query.filter((User.email.ilike(like)) | (User.full_name.ilike(like)))

    users = (
        query.order_by(User.full_name.asc().nullslast(), User.email.asc())
        .limit(limit)
        .all()
    )
    return [
        DashboardShareableUserResponse(id=user.id, email=user.email, full_name=user.full_name)
        for user in users
        if user.id != current_user.id
    ]


@router.post("/ai/generate", response_model=DashboardAIGenerateResponse)
async def generate_dashboard_with_ai(
    request: DashboardAIGenerateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    dataset = (
        db.query(Dataset)
        .options(joinedload(Dataset.view).joinedload(View.columns))
        .filter(Dataset.id == request.dataset_id)
        .first()
    )
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    column_types = _dataset_column_types(dataset)
    payload = await generate_dashboard_with_ai_service(
        db=db,
        dataset_name=dataset.name,
        column_types=column_types,
        semantic_columns=dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else [],
        prompt=request.prompt,
        title=request.title,
    )
    return DashboardAIGenerateResponse.model_validate(payload)


@router.get("/public/{public_share_key}", response_model=DashboardPublicResponse)
async def get_public_dashboard(
    public_share_key: str,
    db: Session = Depends(get_db),
):
    dashboard = (
        db.query(Dashboard)
        .options(joinedload(Dashboard.widgets), joinedload(Dashboard.dataset).joinedload(Dataset.datasource))
        .filter(Dashboard.public_share_key == public_share_key)
        .first()
    )
    if not dashboard or dashboard.visibility != "public_view":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public dashboard not found")
    if not dashboard.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public dashboard not found")
    return DashboardPublicResponse(
        id=dashboard.id,
        dataset_id=dashboard.dataset_id,
        visibility="public_view",
        public_share_key=dashboard.public_share_key,
        name=dashboard.name,
        description=dashboard.description,
        is_active=dashboard.is_active,
        layout_config=dashboard.layout_config or [],
        native_filters=dashboard.native_filters or [],
        widgets=[_widget_response(widget) for widget in dashboard.widgets],
        created_at=dashboard.created_at,
        updated_at=dashboard.updated_at,
    )


@router.post("/public/{public_share_key}/widgets/data", response_model=DashboardWidgetBatchDataResponse)
async def get_public_dashboard_widgets_data(
    public_share_key: str,
    request: DashboardWidgetBatchDataRequest,
    http_request: Request,
    db: Session = Depends(get_db),
):
    dashboard = (
        db.query(Dashboard)
        .options(joinedload(Dashboard.email_shares))
        .filter(Dashboard.public_share_key == public_share_key)
        .first()
    )
    if not dashboard or dashboard.visibility != "public_view":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Public dashboard not found")
    dashboard_id = dashboard.id
    if not request.widget_ids:
        return DashboardWidgetBatchDataResponse(results=[])

    requested_widgets = (
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
    widget_by_id = {widget.id: widget for widget in requested_widgets}
    missing_ids = [widget_id for widget_id in request.widget_ids if widget_id not in widget_by_id]
    if missing_ids:
        raise HTTPException(status_code=404, detail=f"Widgets not found: {missing_ids}")

    first_widget = widget_by_id[request.widget_ids[0]]
    resolved_dashboard = first_widget.dashboard
    if not resolved_dashboard or not resolved_dashboard.dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    _ensure_dashboard_dataset_is_refreshable(resolved_dashboard)

    all_widgets = (
        db.query(DashboardWidget)
        .options(
            joinedload(DashboardWidget.dashboard)
            .joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(DashboardWidget.dashboard).joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(DashboardWidget.dashboard_id == dashboard_id)
        .all()
    )
    configs_by_widget_id: dict[int, WidgetConfig] = {}
    for widget in all_widgets:
        configs_by_widget_id[widget.id] = _resolve_widget_config(widget, request.global_filters)

    executor = get_dashboard_widget_executor()
    result_by_widget = await executor.execute_widgets(
        dashboard_id=dashboard_id,
        dataset_id=resolved_dashboard.dataset_id,
        dataset=resolved_dashboard.dataset,
        datasource=resolved_dashboard.dataset.datasource,
        widgets=requested_widgets,
        configs_by_widget_id=configs_by_widget_id,
        user=None,
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


@router.post("/{dashboard_id}/save", response_model=DashboardResponse)
async def save_dashboard(
    dashboard_id: int,
    request: DashboardSaveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[
            joinedload(Dashboard.dataset).joinedload(Dataset.view).joinedload(View.columns),
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.email_shares),
        ],
    )
    _persist_dashboard_version(db, dashboard, current_user)

    snapshot = {
        "dataset_id": dashboard.dataset_id,
        "name": request.name if request.name is not None else dashboard.name,
        "description": request.description if request.description is not None else dashboard.description,
        "is_active": request.is_active if request.is_active is not None else dashboard.is_active,
        "visibility": request.visibility if request.visibility is not None else dashboard.visibility,
        "layout_config": request.layout_config,
        "native_filters": [item.model_dump(mode="json") for item in request.native_filters],
        "widgets": [
            {
                "id": item.id,
                "widget_type": item.widget_type,
                "title": item.title,
                "position": item.position,
                "config": item.config.model_dump(mode="json"),
                "config_version": item.config_version,
                "visualization_config": item.visualization_config,
            }
            for item in request.widgets
        ],
    }
    _apply_dashboard_snapshot(dashboard=dashboard, snapshot=snapshot, db=db)
    if dashboard.public_share_key is None:
        dashboard.public_share_key = _new_public_share_key()
    db.commit()
    db.refresh(dashboard)
    return _dashboard_response_for_user(dashboard, current_user)


@router.get("/{dashboard_id}/versions", response_model=list[DashboardVersionSummaryResponse])
async def list_dashboard_versions(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[joinedload(Dashboard.email_shares)],
    )
    versions = (
        db.query(DashboardVersion)
        .filter(DashboardVersion.dashboard_id == dashboard_id)
        .order_by(DashboardVersion.version_number.desc())
        .all()
    )
    return [DashboardVersionSummaryResponse.model_validate(item) for item in versions]


@router.post("/{dashboard_id}/versions/{version_id}/restore", response_model=DashboardResponse)
async def restore_dashboard_version(
    dashboard_id: int,
    version_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.email_shares),
        ],
    )
    version = (
        db.query(DashboardVersion)
        .filter(DashboardVersion.id == version_id, DashboardVersion.dashboard_id == dashboard_id)
        .first()
    )
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    _persist_dashboard_version(db, dashboard, current_user)
    snapshot = version.snapshot if isinstance(version.snapshot, dict) else {}
    _apply_dashboard_snapshot(dashboard=dashboard, snapshot=snapshot, db=db)
    db.commit()
    db.refresh(dashboard)
    return _dashboard_response_for_user(dashboard, current_user)


@router.get("/{dashboard_id}/export", response_model=DashboardExportResponse)
async def export_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="view",
        options=[joinedload(Dashboard.widgets), joinedload(Dashboard.email_shares)],
    )
    return DashboardExportResponse(
        format="istari.dashboard.v1",
        exported_at=datetime.utcnow(),
        dashboard=_dashboard_snapshot_payload(dashboard, include_visibility=False),
    )


@router.post("/import/preview", response_model=DashboardImportPreviewResponse)
async def preview_dashboard_import(
    request: DashboardImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    raw = request.dashboard if isinstance(request.dashboard, dict) else {}
    dataset_id = int(request.dataset_id or raw.get("dataset_id") or 0)
    if dataset_id <= 0:
        raise HTTPException(status_code=400, detail="dataset_id is required for import preview")
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return _preview_dashboard_import_compatibility(dataset=dataset, snapshot=raw)


@router.post("/import", response_model=DashboardResponse)
async def import_dashboard(
    request: DashboardImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    raw = request.dashboard if isinstance(request.dashboard, dict) else {}
    dataset_id = int(request.dataset_id or raw.get("dataset_id") or 0)
    if dataset_id <= 0:
        raise HTTPException(status_code=400, detail="dataset_id is required for import")
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    preview = _preview_dashboard_import_compatibility(dataset=dataset, snapshot=raw)
    if preview.compatibility == "incompatible":
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Dashboard import is incompatible with target dataset",
                "preview": preview.model_dump(mode="json"),
            },
        )

    dashboard = Dashboard(
        dataset_id=dataset_id,
        name=str(raw.get("name") or "Dashboard importado"),
        description=raw.get("description"),
        layout_config=[],
        native_filters=[],
        is_active=bool(raw.get("is_active", True)),
        visibility="private",
        public_share_key=_new_public_share_key(),
        created_by_id=current_user.id,
    )
    db.add(dashboard)
    db.flush()
    sanitized_snapshot = {
        **raw,
        "dataset_id": dataset_id,
    }
    sanitized_snapshot.pop("visibility", None)
    sanitized_snapshot.pop("public_share_key", None)
    sanitized_snapshot.pop("shares", None)
    _apply_dashboard_snapshot(dashboard=dashboard, snapshot=sanitized_snapshot, db=db, apply_visibility=False)
    db.commit()
    db.refresh(dashboard)
    return _dashboard_response_for_user(dashboard, current_user)


@router.get("/{dashboard_id}/lock", response_model=DashboardEditLockResponse)
async def get_dashboard_lock(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="view",
        options=[joinedload(Dashboard.edit_lock).joinedload(DashboardEditLock.user), joinedload(Dashboard.email_shares)],
    )
    _clean_expired_lock(dashboard, db)
    db.commit()
    db.refresh(dashboard)
    return _lock_response(dashboard, current_user)


@router.post("/{dashboard_id}/lock/acquire", response_model=DashboardEditLockResponse)
async def acquire_dashboard_lock(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[joinedload(Dashboard.edit_lock).joinedload(DashboardEditLock.user), joinedload(Dashboard.email_shares)],
    )
    _clean_expired_lock(dashboard, db)
    lock = dashboard.edit_lock
    now = datetime.utcnow()
    if lock is None:
        lock = DashboardEditLock(
            dashboard_id=dashboard.id,
            user_id=current_user.id,
            acquired_at=now,
            expires_at=now + timedelta(minutes=LOCK_TTL_MINUTES),
        )
        db.add(lock)
    else:
        lock.user_id = current_user.id
        lock.acquired_at = now
        lock.expires_at = now + timedelta(minutes=LOCK_TTL_MINUTES)
    db.commit()
    db.refresh(dashboard)
    return _lock_response(dashboard, current_user)


@router.delete("/{dashboard_id}/lock", response_model=DashboardEditLockResponse)
async def release_dashboard_lock(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[joinedload(Dashboard.edit_lock).joinedload(DashboardEditLock.user), joinedload(Dashboard.email_shares)],
    )
    lock = dashboard.edit_lock
    if lock and lock.user_id == current_user.id:
        db.delete(lock)
        db.commit()
        db.refresh(dashboard)
    return _lock_response(dashboard, current_user)


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="view",
        options=[joinedload(Dashboard.widgets), joinedload(Dashboard.email_shares)],
    )
    return _dashboard_response_for_user(dashboard, current_user)


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
    if dataset.base_query_spec is None and (not dataset.view or not dataset.view.is_active):
        raise HTTPException(status_code=400, detail="Dataset has no active base query or legacy view")

    _validate_native_filters_against_column_types(
        request.native_filters,
        _dataset_column_types(dataset),
    )

    dashboard = Dashboard(
        dataset_id=request.dataset_id,
        name=request.name,
        description=request.description,
        layout_config=request.layout_config,
        native_filters=[item.model_dump(mode="json") for item in request.native_filters],
        is_active=request.is_active,
        visibility=request.visibility,
        public_share_key=_new_public_share_key(),
        created_by_id=current_user.id,
    )
    db.add(dashboard)
    db.commit()
    db.refresh(dashboard)
    dashboard = (
        db.query(Dashboard)
        .options(joinedload(Dashboard.widgets), joinedload(Dashboard.email_shares))
        .filter(Dashboard.id == dashboard.id)
        .first()
    )
    return _dashboard_response_for_user(dashboard, current_user)


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
async def update_dashboard(
    dashboard_id: int,
    request: DashboardUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[
            joinedload(Dashboard.dataset).joinedload(Dataset.view).joinedload(View.columns),
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.email_shares),
        ],
    )
    _persist_dashboard_version(db, dashboard, current_user)

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
    return _dashboard_response_for_user(dashboard, current_user)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, level, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="owner",
        options=[joinedload(Dashboard.email_shares)],
    )
    if level != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the dashboard owner can delete it")
    db.delete(dashboard)
    db.commit()


@router.get("/{dashboard_id}/sharing", response_model=DashboardSharingResponse)
async def get_dashboard_sharing(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, level, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="owner",
        options=[joinedload(Dashboard.email_shares)],
    )
    if level != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the dashboard owner can manage sharing")
    shares = sorted(dashboard.email_shares, key=lambda item: (item.email, item.id))
    return DashboardSharingResponse(
        dashboard_id=dashboard.id,
        visibility=dashboard.visibility or "private",
        public_share_key=dashboard.public_share_key,
        shares=[DashboardEmailShareResponse.model_validate(item) for item in shares],
    )


@router.put("/{dashboard_id}/sharing/visibility", response_model=DashboardSharingResponse)
async def update_dashboard_visibility(
    dashboard_id: int,
    request: DashboardVisibilityUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, level, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="owner",
        options=[joinedload(Dashboard.email_shares)],
    )
    if level != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the dashboard owner can manage sharing")
    dashboard.visibility = request.visibility
    if dashboard.public_share_key is None:
        dashboard.public_share_key = _new_public_share_key()
    db.commit()
    db.refresh(dashboard)
    return DashboardSharingResponse(
        dashboard_id=dashboard.id,
        visibility=dashboard.visibility or "private",
        public_share_key=dashboard.public_share_key,
        shares=[DashboardEmailShareResponse.model_validate(item) for item in sorted(dashboard.email_shares, key=lambda item: (item.email, item.id))],
    )


@router.post("/{dashboard_id}/sharing/email", response_model=DashboardSharingResponse)
async def upsert_dashboard_email_share(
    dashboard_id: int,
    request: DashboardShareUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, level, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="owner",
        options=[joinedload(Dashboard.email_shares)],
    )
    if level != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the dashboard owner can manage sharing")

    normalized_email = _normalize_email(request.email)
    if normalized_email == _normalize_email(current_user.email):
        raise HTTPException(status_code=400, detail="Owner already has full access")
    invitee = (
        db.query(User)
        .filter(
            func.lower(User.email) == normalized_email,
            User.deleted_at.is_(None),
            User.is_active.is_(True),
        )
        .first()
    )
    if invitee is None:
        raise HTTPException(status_code=400, detail="Email must belong to an active user")

    share = (
        db.query(DashboardEmailShare)
        .filter(
            DashboardEmailShare.dashboard_id == dashboard.id,
            func.lower(DashboardEmailShare.email) == normalized_email,
        )
        .first()
    )
    if share:
        share.permission = request.permission
        share.updated_at = datetime.utcnow()
    else:
        share = DashboardEmailShare(
            dashboard_id=dashboard.id,
            email=normalized_email,
            permission=request.permission,
            created_by_id=current_user.id,
        )
        db.add(share)
    db.commit()
    db.refresh(dashboard)
    return DashboardSharingResponse(
        dashboard_id=dashboard.id,
        visibility=dashboard.visibility or "private",
        public_share_key=dashboard.public_share_key,
        shares=[DashboardEmailShareResponse.model_validate(item) for item in sorted(dashboard.email_shares, key=lambda item: (item.email, item.id))],
    )


@router.delete("/{dashboard_id}/sharing/email/{share_id}", response_model=DashboardSharingResponse)
async def delete_dashboard_email_share(
    dashboard_id: int,
    share_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, level, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="owner",
        options=[joinedload(Dashboard.email_shares)],
    )
    if level != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the dashboard owner can manage sharing")
    share = (
        db.query(DashboardEmailShare)
        .filter(
            DashboardEmailShare.id == share_id,
            DashboardEmailShare.dashboard_id == dashboard.id,
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    db.delete(share)
    db.commit()
    db.refresh(dashboard)
    return DashboardSharingResponse(
        dashboard_id=dashboard.id,
        visibility=dashboard.visibility or "private",
        public_share_key=dashboard.public_share_key,
        shares=[DashboardEmailShareResponse.model_validate(item) for item in sorted(dashboard.email_shares, key=lambda item: (item.email, item.id))],
    )


@router.post("/{dashboard_id}/widgets", response_model=DashboardWidgetResponse)
async def create_widget(
    dashboard_id: int,
    request: DashboardWidgetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[
            joinedload(Dashboard.dataset).joinedload(Dataset.view).joinedload(View.columns),
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.email_shares),
        ],
    )
    _persist_dashboard_version(db, dashboard, current_user)

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
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[joinedload(Dashboard.email_shares)],
    )
    _persist_dashboard_version(db, dashboard, current_user)
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
    dashboard, _, _ = _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="edit",
        options=[joinedload(Dashboard.email_shares)],
    )
    _persist_dashboard_version(db, dashboard, current_user)
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
    _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="view",
        options=[joinedload(Dashboard.email_shares)],
    )
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
    all_widgets = (
        db.query(DashboardWidget)
        .options(
            joinedload(DashboardWidget.dashboard)
            .joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(DashboardWidget.dashboard).joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(DashboardWidget.dashboard_id == dashboard_id)
        .all()
    )
    widgets_for_execution = [widget]
    configs_by_widget_id = {item.id: _resolve_widget_config(item) for item in all_widgets}
    executor = get_dashboard_widget_executor()
    result_by_widget = await executor.execute_widgets(
        dashboard_id=dashboard_id,
        dataset_id=dashboard.dataset_id,
        dataset=dashboard.dataset,
        datasource=dashboard.dataset.datasource,
        widgets=widgets_for_execution,
        configs_by_widget_id=configs_by_widget_id,
        user=current_user,
        runtime_filters=[],
        correlation_id=_resolve_correlation_id(request),
    )
    result = result_by_widget[widget.id]
    widget.last_execution_ms = result.metadata.execution_time_ms
    widget.last_executed_at = datetime.utcnow()
    _commit_widget_execution_stats(db, dashboard_id=dashboard_id, widget_ids=[widget.id])
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
    _load_dashboard_for_user(
        db,
        dashboard_id,
        current_user,
        min_level="view",
        options=[joinedload(Dashboard.email_shares)],
    )
    if not request.widget_ids:
        return DashboardWidgetBatchDataResponse(results=[])

    requested_widgets = (
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
    widget_by_id = {widget.id: widget for widget in requested_widgets}
    missing_ids = [widget_id for widget_id in request.widget_ids if widget_id not in widget_by_id]
    if missing_ids:
        raise HTTPException(status_code=404, detail=f"Widgets not found: {missing_ids}")

    first_widget = widget_by_id[request.widget_ids[0]]
    dashboard = first_widget.dashboard
    if not dashboard or not dashboard.dataset:
        raise HTTPException(status_code=400, detail="Dashboard dataset is unavailable")
    _ensure_dashboard_dataset_is_refreshable(dashboard)

    all_widgets = (
        db.query(DashboardWidget)
        .options(
            joinedload(DashboardWidget.dashboard)
            .joinedload(Dashboard.dataset)
            .joinedload(Dataset.view)
            .joinedload(View.columns),
            joinedload(DashboardWidget.dashboard).joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
        )
        .filter(DashboardWidget.dashboard_id == dashboard_id)
        .all()
    )
    configs_by_widget_id: dict[int, WidgetConfig] = {}
    for widget in all_widgets:
        configs_by_widget_id[widget.id] = _resolve_widget_config(widget, request.global_filters)

    executor = get_dashboard_widget_executor()
    result_by_widget = await executor.execute_widgets(
        dashboard_id=dashboard_id,
        dataset_id=dashboard.dataset_id,
        dataset=dashboard.dataset,
        datasource=dashboard.dataset.datasource,
        widgets=requested_widgets,
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
    _commit_widget_execution_stats(db, dashboard_id=dashboard_id, widget_ids=list(request.widget_ids))

    return DashboardWidgetBatchDataResponse(results=results)


