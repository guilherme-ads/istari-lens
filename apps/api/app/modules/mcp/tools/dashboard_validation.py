from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from app.modules.core.legacy.models import Dashboard
from app.modules.core.legacy.schemas import DashboardNativeFilterConfig
from app.modules.mcp.context import DATASET_WIDGET_VIEW_NAME
from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.widgets.domain.config import WidgetConfig, WidgetConfigValidationError, validate_widget_config_against_columns


def adapt_legacy_query_config(raw: dict[str, Any]) -> dict[str, Any]:
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


def _validation_error(code: str, field: str | None, message: str) -> MCPToolValidationError:
    return MCPToolValidationError(code=code, field=field, message=message)


def _errors_from_pydantic(exc: ValidationError, *, code: str, field_prefix: str) -> list[MCPToolValidationError]:
    errors: list[MCPToolValidationError] = []
    for item in exc.errors():
        loc = ".".join(str(part) for part in item.get("loc", []))
        field = f"{field_prefix}.{loc}" if loc else field_prefix
        errors.append(_validation_error(code=code, field=field, message=item.get("msg", "Invalid input")))
    return errors


def _errors_from_widget_validation(
    exc: WidgetConfigValidationError,
    *,
    field_prefix: str,
) -> list[MCPToolValidationError]:
    errors: list[MCPToolValidationError] = []
    for field, messages in (exc.field_errors or {}).items():
        target = f"{field_prefix}.{field}" if field else field_prefix
        for message in messages:
            errors.append(_validation_error(code="widget_validation_error", field=target, message=message))
    return errors


def errors_from_exception(exc: Exception, *, field_prefix: str = "config") -> list[MCPToolValidationError]:
    if isinstance(exc, WidgetConfigValidationError):
        return _errors_from_widget_validation(exc, field_prefix=field_prefix)
    if isinstance(exc, ValidationError):
        return _errors_from_pydantic(exc, code="invalid_schema", field_prefix=field_prefix)
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            field_errors = detail.get("field_errors")
            if isinstance(field_errors, dict):
                output: list[MCPToolValidationError] = []
                for key, messages in field_errors.items():
                    field = f"{field_prefix}.{key}" if key else field_prefix
                    if isinstance(messages, list):
                        for message in messages:
                            output.append(
                                _validation_error(
                                    code="widget_validation_error",
                                    field=field,
                                    message=str(message),
                                )
                            )
                    else:
                        output.append(
                            _validation_error(
                                code="widget_validation_error",
                                field=field,
                                message=str(messages),
                            )
                        )
                return output
            message = str(detail.get("message") or detail)
            return [_validation_error(code="invalid_config", field=field_prefix, message=message)]
        return [_validation_error(code="invalid_config", field=field_prefix, message=str(detail))]
    return [_validation_error(code="invalid_config", field=field_prefix, message=str(exc))]


def parse_widget_config(
    raw_config: dict[str, Any],
    *,
    expected_widget_type: str | None = None,
) -> tuple[WidgetConfig | None, list[MCPToolValidationError]]:
    payload: dict[str, Any]
    try:
        payload = dict(raw_config)
    except Exception as exc:
        return None, [_validation_error(code="invalid_config", field="config", message=str(exc))]

    if "widget_type" not in payload and "type" in payload:
        payload = adapt_legacy_query_config(payload)

    try:
        parsed = WidgetConfig.model_validate(payload)
    except Exception as exc:
        return None, errors_from_exception(exc, field_prefix="config")

    if expected_widget_type and parsed.widget_type != expected_widget_type:
        return None, [
            _validation_error(
                code="widget_type_mismatch",
                field="widget_type",
                message=f"widget_type '{expected_widget_type}' must match config.widget_type '{parsed.widget_type}'",
            )
        ]

    parsed = parsed.model_copy(update={"view_name": DATASET_WIDGET_VIEW_NAME})
    return parsed, []


def validate_widget_config_for_dashboard(
    *,
    config: WidgetConfig,
    dashboard: Dashboard | None,
    column_types: dict[str, str],
    exclude_widget_id: int | None = None,
    field_prefix: str = "config",
) -> list[MCPToolValidationError]:
    errors: list[MCPToolValidationError] = []
    try:
        validate_widget_config_against_columns(config, column_types)
    except Exception as exc:
        errors.extend(errors_from_exception(exc, field_prefix=field_prefix))
        return errors

    if dashboard is None or config.widget_type != "kpi" or config.kpi_type != "derived":
        return errors

    widget_by_id = {
        int(widget.id): widget
        for widget in (dashboard.widgets or [])
        if exclude_widget_id is None or int(widget.id) != int(exclude_widget_id)
    }
    for index, dep in enumerate(config.kpi_dependencies):
        if dep.source_type == "column":
            if dep.column not in column_types:
                errors.append(
                    _validation_error(
                        code="unknown_dependency_column",
                        field=f"{field_prefix}.kpi_dependencies[{index}].column",
                        message=f"Column dependency '{dep.column}' does not exist in dataset schema",
                    )
                )
            continue

        if not isinstance(dep.widget_id, int):
            errors.append(
                _validation_error(
                    code="invalid_dependency_widget_id",
                    field=f"{field_prefix}.kpi_dependencies[{index}].widget_id",
                    message="Derived KPI dependency must reference a persisted widget_id",
                )
            )
            continue
        if dep.widget_id not in widget_by_id:
            errors.append(
                _validation_error(
                    code="dependency_widget_not_found",
                    field=f"{field_prefix}.kpi_dependencies[{index}].widget_id",
                    message="Widget dependency was not found in this dashboard",
                )
            )
            continue

        target = widget_by_id[dep.widget_id]
        target_type = target.widget_type
        if isinstance(target.query_config, dict):
            target_type = str(target.query_config.get("widget_type") or target.widget_type)
        if target_type != "kpi":
            errors.append(
                _validation_error(
                    code="dependency_widget_type_invalid",
                    field=f"{field_prefix}.kpi_dependencies[{index}].widget_id",
                    message="Widget dependency must point to a KPI widget",
                )
            )
    return errors


def parse_native_filters(
    *,
    raw_filters: list[Any],
    column_types: dict[str, str],
    field_prefix: str = "native_filters",
) -> tuple[list[DashboardNativeFilterConfig], list[MCPToolValidationError], list[str]]:
    parsed_filters: list[DashboardNativeFilterConfig] = []
    errors: list[MCPToolValidationError] = []
    warnings: list[str] = []
    for index, raw in enumerate(raw_filters):
        try:
            parsed = DashboardNativeFilterConfig.model_validate(raw)
        except Exception as exc:
            errors.extend(errors_from_exception(exc, field_prefix=f"{field_prefix}[{index}]"))
            continue
        if parsed.column not in column_types:
            errors.append(
                _validation_error(
                    code="unknown_filter_column",
                    field=f"{field_prefix}[{index}].column",
                    message=f"Column '{parsed.column}' does not exist in dataset schema",
                )
            )
        if parsed.op in {"is_null", "not_null"} and parsed.value is not None:
            warnings.append(f"{field_prefix}[{index}] op '{parsed.op}' ignores value")
        if parsed.op in {"in", "not_in", "between"} and (not isinstance(parsed.value, list) or len(parsed.value) == 0):
            errors.append(
                _validation_error(
                    code="invalid_filter_value",
                    field=f"{field_prefix}[{index}].value",
                    message=f"Operator '{parsed.op}' requires a non-empty list value",
                )
            )
        if parsed.op not in {"is_null", "not_null"} and parsed.value is None:
            errors.append(
                _validation_error(
                    code="missing_filter_value",
                    field=f"{field_prefix}[{index}].value",
                    message=f"Operator '{parsed.op}' requires value",
                )
            )
        parsed_filters.append(parsed)
    return parsed_filters, errors, warnings


def validate_layout_widget_references(
    *,
    layout_config: list[Any],
    widget_ids: set[int],
) -> list[MCPToolValidationError]:
    errors: list[MCPToolValidationError] = []
    for section_index, section in enumerate(layout_config):
        if not isinstance(section, dict):
            errors.append(
                _validation_error(
                    code="invalid_layout_section",
                    field=f"layout_config[{section_index}]",
                    message="Section must be an object",
                )
            )
            continue
        section_widgets = section.get("widgets")
        if not isinstance(section_widgets, list):
            continue
        for widget_index, entry in enumerate(section_widgets):
            if not isinstance(entry, dict):
                errors.append(
                    _validation_error(
                        code="invalid_layout_widget_ref",
                        field=f"layout_config[{section_index}].widgets[{widget_index}]",
                        message="Section widget entry must be an object",
                    )
                )
                continue
            raw_widget_id = entry.get("widget_id")
            resolved_widget_id: int | None = None
            if isinstance(raw_widget_id, int):
                resolved_widget_id = raw_widget_id
            elif isinstance(raw_widget_id, str) and raw_widget_id.strip().isdigit():
                resolved_widget_id = int(raw_widget_id.strip())
            if resolved_widget_id is None:
                errors.append(
                    _validation_error(
                        code="invalid_layout_widget_ref",
                        field=f"layout_config[{section_index}].widgets[{widget_index}].widget_id",
                        message="widget_id must be an existing integer id",
                    )
                )
                continue
            if resolved_widget_id not in widget_ids:
                errors.append(
                    _validation_error(
                        code="layout_widget_not_found",
                        field=f"layout_config[{section_index}].widgets[{widget_index}].widget_id",
                        message=f"widget_id {resolved_widget_id} does not exist in dashboard widgets",
                    )
                )
    return errors

