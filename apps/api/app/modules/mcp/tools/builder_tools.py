from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import joinedload

from app.modules.core.legacy.models import Dashboard, DashboardWidget, Dataset, View
from app.modules.dashboards.application.ai_generation import generate_dashboard_with_ai_service
from app.modules.mcp.context import dataset_column_types, load_accessible_dataset, load_dashboard_for_dataset
from app.modules.mcp.runtime import MCPToolRuntimeContext
from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.mcp.tools.common import fail, ok
from app.modules.mcp.tools.dashboard_validation import (
    parse_native_filters,
    parse_widget_config,
    validate_layout_widget_references,
    validate_widget_config_for_dashboard,
)

DASHBOARD_VISIBILITY = Literal["private", "workspace_view", "workspace_edit", "public_view"]


class CreateDashboardDraftArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    name: str = Field(default="Novo Dashboard", min_length=1, max_length=255)
    description: str | None = None
    visibility: DASHBOARD_VISIBILITY = "private"


class GenerateDashboardPlanArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    prompt: str = Field(default="")
    title: str | None = Field(default=None, max_length=255)


class DashboardRefArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    dashboard_id: int = Field(gt=0)


class AddDashboardSectionArgs(DashboardRefArgs):
    section_id: str | None = Field(default=None, max_length=128)
    title: str = Field(default="Nova secao", min_length=1, max_length=255)
    show_title: bool = True
    columns: int = Field(default=6, ge=1, le=6)
    position: int | None = Field(default=None, ge=0)


class WidgetPlacementArgs(BaseModel):
    x: int = Field(default=0, ge=0, le=5)
    y: int = Field(default=0, ge=0)
    w: int = Field(default=1, ge=1, le=6)
    h: int = Field(default=4, ge=1, le=24)


class AddDashboardWidgetArgs(DashboardRefArgs):
    widget_type: str = Field(min_length=1, max_length=32)
    title: str | None = Field(default=None, max_length=255)
    position: int | None = Field(default=None, ge=0)
    config: dict[str, Any]
    config_version: int = Field(default=1, ge=1)
    visualization_config: dict[str, Any] | None = None
    section_id: str | None = Field(default=None, max_length=128)
    placement: WidgetPlacementArgs | None = None


class UpdateDashboardWidgetArgs(DashboardRefArgs):
    widget_id: int = Field(gt=0)
    widget_type: str | None = Field(default=None, min_length=1, max_length=32)
    title: str | None = Field(default=None, max_length=255)
    position: int | None = Field(default=None, ge=0)
    config: dict[str, Any] | None = None
    config_version: int | None = Field(default=None, ge=1)
    visualization_config: dict[str, Any] | None = None


class DeleteDashboardWidgetArgs(DashboardRefArgs):
    widget_id: int = Field(gt=0)


class SetDashboardNativeFiltersArgs(DashboardRefArgs):
    native_filters: list[dict[str, Any]] = Field(default_factory=list)


class SaveDashboardDraftArgs(DashboardRefArgs):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    visibility: DASHBOARD_VISIBILITY | None = None
    is_active: bool | None = None
    layout_config: list[dict[str, Any]] | None = None
    native_filters: list[dict[str, Any]] | None = None
    validate_before_save: bool = True


def _ensure_dataset_is_build_ready(dataset: Dataset) -> None:
    if not dataset.is_active:
        raise HTTPException(status_code=400, detail="Dataset is inactive")
    if not dataset.datasource or not dataset.datasource.is_active:
        raise HTTPException(status_code=400, detail="Dataset datasource is inactive")
    if dataset.base_query_spec is None and (not dataset.view or not dataset.view.is_active):
        raise HTTPException(status_code=400, detail="Dataset has no active base query or legacy view")


def _widget_to_payload(widget: DashboardWidget) -> dict[str, Any]:
    return {
        "id": int(widget.id),
        "dashboard_id": int(widget.dashboard_id),
        "widget_type": str(widget.widget_type),
        "title": widget.title,
        "position": int(widget.position or 0),
        "query_config": widget.query_config if isinstance(widget.query_config, dict) else {},
        "config_version": int(widget.config_version or 1),
        "visualization_config": widget.visualization_config if isinstance(widget.visualization_config, dict) else None,
    }


def _dashboard_summary(dashboard: Dashboard) -> dict[str, Any]:
    widgets = sorted(dashboard.widgets or [], key=lambda item: (int(item.position or 0), int(item.id)))
    return {
        "dashboard": {
            "id": int(dashboard.id),
            "dataset_id": int(dashboard.dataset_id),
            "name": dashboard.name,
            "description": dashboard.description,
            "is_active": bool(dashboard.is_active),
            "visibility": dashboard.visibility,
            "layout_config": dashboard.layout_config if isinstance(dashboard.layout_config, list) else [],
            "native_filters": dashboard.native_filters if isinstance(dashboard.native_filters, list) else [],
        },
        "widgets": [_widget_to_payload(item) for item in widgets],
        "counts": {
            "sections": len(dashboard.layout_config or []),
            "widgets": len(widgets),
        },
    }


def _new_section(*, section_id: str, title: str, show_title: bool, columns: int) -> dict[str, Any]:
    return {
        "id": section_id,
        "title": title,
        "show_title": bool(show_title),
        "columns": int(columns),
        "widgets": [],
    }


def _parse_widget_id(value: Any) -> int | None:
    if isinstance(value, int):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _next_widget_layout_entry(*, widget_id: int, placement: WidgetPlacementArgs | None) -> dict[str, Any]:
    if placement is not None:
        return {
            "widget_id": int(widget_id),
            "i": str(widget_id),
            "x": int(placement.x),
            "y": int(placement.y),
            "w": int(placement.w),
            "h": int(placement.h),
        }
    return {
        "widget_id": int(widget_id),
        "i": str(widget_id),
        "x": 0,
        "y": 999,
        "w": 1,
        "h": 4,
    }


def _attach_widget_to_layout(
    *,
    layout_config: list[dict[str, Any]],
    widget_id: int,
    section_id: str | None,
    placement: WidgetPlacementArgs | None,
) -> tuple[list[dict[str, Any]], list[MCPToolValidationError], list[str]]:
    warnings: list[str] = []
    errors: list[MCPToolValidationError] = []
    next_layout = deepcopy(layout_config)
    if len(next_layout) == 0:
        auto_section = _new_section(
            section_id=f"sec-{uuid4().hex[:8]}",
            title="Principal",
            show_title=True,
            columns=6,
        )
        next_layout.append(auto_section)
        warnings.append("Dashboard had no section. Auto-created 'Principal' section.")

    target_section: dict[str, Any] | None = None
    if section_id:
        for item in next_layout:
            if str(item.get("id")) == section_id:
                target_section = item
                break
        if target_section is None:
            errors.append(
                MCPToolValidationError(
                    code="section_not_found",
                    field="section_id",
                    message=f"Section '{section_id}' was not found in dashboard layout",
                )
            )
            return next_layout, errors, warnings
    else:
        target_section = next_layout[0]

    section_widgets = target_section.get("widgets")
    if not isinstance(section_widgets, list):
        section_widgets = []
    section_widgets = [
        item
        for item in section_widgets
        if not (isinstance(item, dict) and _parse_widget_id(item.get("widget_id")) == int(widget_id))
    ]
    section_widgets.append(_next_widget_layout_entry(widget_id=widget_id, placement=placement))
    target_section["widgets"] = section_widgets
    return next_layout, errors, warnings


def _remove_widget_from_layout(layout_config: list[dict[str, Any]], *, widget_id: int) -> list[dict[str, Any]]:
    next_layout = deepcopy(layout_config)
    for section in next_layout:
        if not isinstance(section, dict):
            continue
        items = section.get("widgets")
        if not isinstance(items, list):
            continue
        section["widgets"] = [
            item
            for item in items
            if not (isinstance(item, dict) and _parse_widget_id(item.get("widget_id")) == int(widget_id))
        ]
    return next_layout


def _load_dashboard_editable(
    *,
    db,
    dataset_id: int,
    dashboard_id: int,
    current_user,
) -> Dashboard:
    dashboard, _, _ = load_dashboard_for_dataset(
        db=db,
        dashboard_id=dashboard_id,
        dataset_id=dataset_id,
        current_user=current_user,
        min_level="edit",
    )
    return dashboard


def _validate_dashboard_state(dashboard: Dashboard) -> tuple[list[MCPToolValidationError], list[str]]:
    errors: list[MCPToolValidationError] = []
    warnings: list[str] = []
    column_types = dataset_column_types(dashboard.dataset)
    raw_filters = dashboard.native_filters if isinstance(dashboard.native_filters, list) else []
    _, native_errors, native_warnings = parse_native_filters(raw_filters=raw_filters, column_types=column_types)
    errors.extend(native_errors)
    warnings.extend(native_warnings)

    for index, widget in enumerate(sorted(dashboard.widgets or [], key=lambda item: (int(item.position or 0), int(item.id)))):
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
        errors.extend(widget_errors)

    layout = dashboard.layout_config if isinstance(dashboard.layout_config, list) else []
    widget_ids = {int(item.id) for item in (dashboard.widgets or [])}
    errors.extend(validate_layout_widget_references(layout_config=layout, widget_ids=widget_ids))
    return errors, warnings


async def tool_generate_dashboard_plan(args: GenerateDashboardPlanArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    result = await generate_dashboard_with_ai_service(
        db=runtime.db,
        dataset_name=dataset.name,
        column_types=dataset_column_types(dataset),
        semantic_columns=dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else [],
        prompt=args.prompt,
        title=args.title,
    )
    return ok(
        data=result if isinstance(result, dict) else {"result": result},
        metadata={"compatibility_tool": True},
        suggestions=["Use tools de builder para persistir incrementalmente o plano validado."],
    )


async def tool_create_dashboard_draft(args: CreateDashboardDraftArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    _ensure_dataset_is_build_ready(dataset)
    draft = Dashboard(
        dataset_id=int(dataset.id),
        name=args.name,
        description=args.description,
        layout_config=[],
        native_filters=[],
        is_active=True,
        visibility=args.visibility,
        created_by_id=runtime.current_user.id,
    )
    runtime.db.add(draft)
    runtime.db.commit()
    runtime.db.refresh(draft)
    return ok(
        data=_dashboard_summary(draft),
        suggestions=[
            "Use lens.add_dashboard_section para estruturar o canvas.",
            "Use lens.add_dashboard_widget para adicionar widgets com configuracao validada.",
        ],
    )


async def tool_add_dashboard_section(args: AddDashboardSectionArgs, runtime: MCPToolRuntimeContext):
    dashboard = _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    current_layout = deepcopy(dashboard.layout_config if isinstance(dashboard.layout_config, list) else [])
    section_id = args.section_id.strip() if isinstance(args.section_id, str) and args.section_id.strip() else f"sec-{uuid4().hex[:8]}"
    if any(isinstance(item, dict) and str(item.get("id")) == section_id for item in current_layout):
        return fail(
            error="Section already exists",
            validation_errors=[
                MCPToolValidationError(
                    code="duplicate_section_id",
                    field="section_id",
                    message=f"Section id '{section_id}' already exists",
                )
            ],
        )

    section = _new_section(
        section_id=section_id,
        title=args.title,
        show_title=args.show_title,
        columns=args.columns,
    )
    if args.position is None or args.position >= len(current_layout):
        current_layout.append(section)
    else:
        current_layout.insert(max(0, int(args.position)), section)
    dashboard.layout_config = current_layout
    runtime.db.commit()
    runtime.db.refresh(dashboard)
    return ok(
        data={
            **_dashboard_summary(dashboard),
            "section": section,
        },
        suggestions=["Use lens.add_dashboard_widget com section_id para preencher a secao criada."],
    )


async def tool_add_dashboard_widget(args: AddDashboardWidgetArgs, runtime: MCPToolRuntimeContext):
    dashboard = _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    column_types = dataset_column_types(dashboard.dataset)
    parsed_config, parse_errors = parse_widget_config(
        args.config,
        expected_widget_type=str(args.widget_type).strip().lower(),
    )
    if parse_errors:
        return fail(
            error="Widget config validation failed",
            validation_errors=parse_errors,
            suggestions=["Use lens.validate_widget_config para iterar na configuracao antes de persistir."],
        )
    validation_errors = validate_widget_config_for_dashboard(
        config=parsed_config,
        dashboard=dashboard,
        column_types=column_types,
        field_prefix="config",
    )
    if validation_errors:
        return fail(
            error="Widget config validation failed",
            validation_errors=validation_errors,
            suggestions=["Ajuste metricas/dimensoes/filtros para compatibilidade com o tipo de widget."],
        )

    next_position = args.position
    if next_position is None:
        current_positions = [int(item.position or 0) for item in (dashboard.widgets or [])]
        next_position = (max(current_positions) + 1) if current_positions else 0
    widget = DashboardWidget(
        dashboard_id=int(dashboard.id),
        widget_type=str(parsed_config.widget_type),
        title=args.title,
        position=int(next_position),
        query_config=parsed_config.model_dump(mode="json"),
        config_version=int(args.config_version),
        visualization_config=args.visualization_config,
    )
    runtime.db.add(widget)
    runtime.db.flush()

    current_layout = deepcopy(dashboard.layout_config if isinstance(dashboard.layout_config, list) else [])
    next_layout, layout_errors, warnings = _attach_widget_to_layout(
        layout_config=current_layout,
        widget_id=int(widget.id),
        section_id=args.section_id,
        placement=args.placement,
    )
    if layout_errors:
        runtime.db.rollback()
        return fail(
            error="Widget was not placed in dashboard layout",
            validation_errors=layout_errors,
            suggestions=["Use lens.add_dashboard_section antes de associar o widget a uma secao especifica."],
        )
    dashboard.layout_config = next_layout
    runtime.db.commit()
    runtime.db.refresh(widget)
    runtime.db.refresh(dashboard)
    return ok(
        data={
            **_dashboard_summary(dashboard),
            "widget": _widget_to_payload(widget),
        },
        warnings=warnings,
        suggestions=["Use lens.update_dashboard_widget para ajustes finos de configuracao e visual."],
    )


async def tool_update_dashboard_widget(args: UpdateDashboardWidgetArgs, runtime: MCPToolRuntimeContext):
    dashboard = _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    widget = (
        runtime.db.query(DashboardWidget)
        .filter(
            DashboardWidget.id == int(args.widget_id),
            DashboardWidget.dashboard_id == int(dashboard.id),
        )
        .first()
    )
    if widget is None:
        return fail(
            error="Widget not found",
            validation_errors=[
                MCPToolValidationError(
                    code="widget_not_found",
                    field="widget_id",
                    message="Widget does not exist in this dashboard",
                )
            ],
        )

    column_types = dataset_column_types(dashboard.dataset)
    if args.config is not None:
        requested_type = str(args.widget_type or widget.widget_type).strip().lower()
        parsed_config, parse_errors = parse_widget_config(
            args.config,
            expected_widget_type=requested_type,
        )
        if parse_errors:
            return fail(
                error="Widget config validation failed",
                validation_errors=parse_errors,
            )
        validation_errors = validate_widget_config_for_dashboard(
            config=parsed_config,
            dashboard=dashboard,
            column_types=column_types,
            exclude_widget_id=int(widget.id),
            field_prefix="config",
        )
        if validation_errors:
            return fail(
                error="Widget config validation failed",
                validation_errors=validation_errors,
            )
        widget.query_config = parsed_config.model_dump(mode="json")
        widget.widget_type = parsed_config.widget_type
    elif args.widget_type is not None and str(args.widget_type).strip().lower() != str(widget.widget_type).strip().lower():
        return fail(
            error="Cannot change widget_type without config",
            validation_errors=[
                MCPToolValidationError(
                    code="config_required_for_widget_type_change",
                    field="config",
                    message="Provide a compatible config when changing widget_type",
                )
            ],
        )

    if args.title is not None:
        widget.title = args.title
    if args.position is not None:
        widget.position = int(args.position)
    if args.config_version is not None:
        widget.config_version = int(args.config_version)
    if args.visualization_config is not None:
        widget.visualization_config = args.visualization_config

    runtime.db.commit()
    runtime.db.refresh(widget)
    runtime.db.refresh(dashboard)
    return ok(
        data={
            **_dashboard_summary(dashboard),
            "widget": _widget_to_payload(widget),
        }
    )


async def tool_delete_dashboard_widget(args: DeleteDashboardWidgetArgs, runtime: MCPToolRuntimeContext):
    dashboard = _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    widget = (
        runtime.db.query(DashboardWidget)
        .filter(
            DashboardWidget.id == int(args.widget_id),
            DashboardWidget.dashboard_id == int(dashboard.id),
        )
        .first()
    )
    if widget is None:
        return fail(
            error="Widget not found",
            validation_errors=[
                MCPToolValidationError(
                    code="widget_not_found",
                    field="widget_id",
                    message="Widget does not exist in this dashboard",
                )
            ],
        )

    dashboard.layout_config = _remove_widget_from_layout(
        dashboard.layout_config if isinstance(dashboard.layout_config, list) else [],
        widget_id=int(widget.id),
    )
    runtime.db.delete(widget)
    runtime.db.commit()
    runtime.db.refresh(dashboard)
    return ok(
        data={
            **_dashboard_summary(dashboard),
            "deleted_widget_id": int(args.widget_id),
        }
    )


async def tool_set_dashboard_native_filters(args: SetDashboardNativeFiltersArgs, runtime: MCPToolRuntimeContext):
    dashboard = _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    column_types = dataset_column_types(dashboard.dataset)
    parsed, errors, warnings = parse_native_filters(
        raw_filters=args.native_filters,
        column_types=column_types,
    )
    if errors:
        return fail(
            error="Native filters validation failed",
            validation_errors=errors,
            warnings=warnings,
        )
    dashboard.native_filters = [item.model_dump(mode="json") for item in parsed]
    runtime.db.commit()
    runtime.db.refresh(dashboard)
    return ok(
        data={
            **_dashboard_summary(dashboard),
            "native_filters": [item.model_dump(mode="json") for item in parsed],
        },
        warnings=warnings,
    )


async def tool_save_dashboard_draft(args: SaveDashboardDraftArgs, runtime: MCPToolRuntimeContext):
    _load_dashboard_editable(
        db=runtime.db,
        dataset_id=args.dataset_id,
        dashboard_id=args.dashboard_id,
        current_user=runtime.current_user,
    )
    dashboard = (
        runtime.db.query(Dashboard)
        .options(
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
            joinedload(Dashboard.dataset).joinedload(Dataset.view).joinedload(View.columns),
            joinedload(Dashboard.email_shares),
        )
        .filter(Dashboard.id == int(args.dashboard_id))
        .first()
    )
    if dashboard is None:
        return fail(error="Dashboard not found")
    if int(dashboard.dataset_id) != int(args.dataset_id):
        return fail(error="Dashboard dataset mismatch")

    warnings: list[str] = []
    if args.native_filters is not None:
        column_types = dataset_column_types(dashboard.dataset)
        parsed_filters, errors, native_warnings = parse_native_filters(
            raw_filters=args.native_filters,
            column_types=column_types,
        )
        if errors:
            return fail(
                error="Native filters validation failed",
                validation_errors=errors,
                warnings=native_warnings,
            )
        dashboard.native_filters = [item.model_dump(mode="json") for item in parsed_filters]
        warnings.extend(native_warnings)

    if args.layout_config is not None:
        dashboard.layout_config = deepcopy(args.layout_config)
    if args.name is not None:
        dashboard.name = args.name
    if args.description is not None:
        dashboard.description = args.description
    if args.visibility is not None:
        dashboard.visibility = args.visibility
    if args.is_active is not None:
        dashboard.is_active = bool(args.is_active)

    if args.validate_before_save:
        validation_errors, validation_warnings = _validate_dashboard_state(dashboard)
        warnings.extend(validation_warnings)
        if validation_errors:
            runtime.db.rollback()
            return fail(
                error="Dashboard draft validation failed",
                validation_errors=validation_errors,
                warnings=warnings,
                suggestions=["Use lens.validate_dashboard_draft para detalhes adicionais por widget/secao."],
            )

    runtime.db.commit()
    runtime.db.refresh(dashboard)
    return ok(
        data=_dashboard_summary(dashboard),
        warnings=warnings,
        suggestions=["Use lens.validate_dashboard_draft para validar consistencia final antes de publicar/usar."],
    )


BUILDER_TOOL_SPECS = [
    {
        "name": "lens.generate_dashboard_plan",
        "category": "builder",
        "description": "Tool de compatibilidade para gerar plano de dashboard via IA no dataset.",
        "input_model": GenerateDashboardPlanArgs,
        "handler": tool_generate_dashboard_plan,
    },
    {
        "name": "lens.create_dashboard_draft",
        "category": "builder",
        "description": "Cria dashboard draft vazio para o dataset informado.",
        "input_model": CreateDashboardDraftArgs,
        "handler": tool_create_dashboard_draft,
    },
    {
        "name": "lens.add_dashboard_section",
        "category": "builder",
        "description": "Adiciona secao no layout_config do dashboard draft.",
        "input_model": AddDashboardSectionArgs,
        "handler": tool_add_dashboard_section,
    },
    {
        "name": "lens.add_dashboard_widget",
        "category": "builder",
        "description": "Adiciona widget validado ao dashboard draft e opcionalmente posiciona em secao.",
        "input_model": AddDashboardWidgetArgs,
        "handler": tool_add_dashboard_widget,
    },
    {
        "name": "lens.update_dashboard_widget",
        "category": "builder",
        "description": "Atualiza configuracao/metadados de widget existente no dashboard draft.",
        "input_model": UpdateDashboardWidgetArgs,
        "handler": tool_update_dashboard_widget,
    },
    {
        "name": "lens.delete_dashboard_widget",
        "category": "builder",
        "description": "Remove widget do dashboard draft e limpa referencias no layout.",
        "input_model": DeleteDashboardWidgetArgs,
        "handler": tool_delete_dashboard_widget,
    },
    {
        "name": "lens.set_dashboard_native_filters",
        "category": "builder",
        "description": "Define filtros nativos do dashboard com validacao de schema.",
        "input_model": SetDashboardNativeFiltersArgs,
        "handler": tool_set_dashboard_native_filters,
    },
    {
        "name": "lens.save_dashboard_draft",
        "category": "builder",
        "description": "Persiste alteracoes do draft e valida consistencia final quando solicitado.",
        "input_model": SaveDashboardDraftArgs,
        "handler": tool_save_dashboard_draft,
    },
]
