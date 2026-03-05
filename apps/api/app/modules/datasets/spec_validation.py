from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import View
from app.modules.widgets.domain import normalize_column_type

_ALLOWED_JOIN_TYPES = {"inner", "left"}
_ALLOWED_EXPR_OPS = {"add", "sub", "mul", "div", "concat", "coalesce", "lower", "upper", "date_trunc"}
_ALLOWED_FILTER_OPS = {
    "eq",
    "neq",
    "gt",
    "lt",
    "gte",
    "lte",
    "in",
    "not_in",
    "contains",
    "is_null",
    "not_null",
    "between",
}


def _raise(message: str, *, field: str | None = None) -> None:
    if field:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Dataset base_query_spec validation failed",
                "field_errors": {field: [message]},
            },
        )
    raise HTTPException(status_code=400, detail=message)


def _as_dict(value: Any, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _raise("Expected object", field=field)
    return value


def _as_list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list):
        _raise("Expected array", field=field)
    return value


def _as_str(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        _raise("Expected non-empty string", field=field)
    return value.strip()


def _normalize_semantic_type(value: Any) -> str:
    if not isinstance(value, str):
        return "text"
    normalized = value.strip().lower()
    if normalized in {"numeric", "temporal", "text", "boolean"}:
        return normalized
    return "text"


def _raw_type_from_semantic_type(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized == "temporal":
        return "timestamp"
    if normalized in {"numeric", "boolean", "text"}:
        return normalized
    return "text"


def _validate_expr_node(
    node: Any,
    *,
    field: str,
    available_columns: set[str],
) -> None:
    if not isinstance(node, dict):
        _raise("Expression node must be an object", field=field)
    if "column" in node:
        column_name = node.get("column")
        if not isinstance(column_name, str) or not column_name.strip():
            _raise("column reference must be a non-empty string", field=field)
        if column_name not in available_columns:
            _raise(f"Unknown column reference '{column_name}'", field=field)
        return
    if "literal" in node:
        literal = node.get("literal")
        if not isinstance(literal, (str, int, float, bool)) and literal is not None:
            _raise("literal must be string, number, boolean or null", field=field)
        return

    op = node.get("op")
    args = node.get("args")
    if not isinstance(op, str) or op not in _ALLOWED_EXPR_OPS:
        _raise(f"Unsupported expression operator '{op}'", field=field)
    if not isinstance(args, list) or len(args) < 1:
        _raise("Expression operator args must be a non-empty array", field=field)
    if op in {"lower", "upper", "date_trunc"} and len(args) != 1:
        _raise(f"Operator '{op}' expects exactly 1 argument", field=field)
    if op in {"add", "sub", "mul", "div", "concat"} and len(args) != 2:
        _raise(f"Operator '{op}' expects exactly 2 arguments", field=field)
    for idx, item in enumerate(args):
        _validate_expr_node(item, field=f"{field}.args[{idx}]", available_columns=available_columns)


def validate_and_resolve_base_query_spec(
    *,
    db: Session,
    datasource_id: int,
    base_query_spec: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(base_query_spec, dict):
        _raise("base_query_spec must be an object")

    version = base_query_spec.get("version")
    if not isinstance(version, int) or version != 1:
        _raise("base_query_spec.version must be 1", field="version")

    source = _as_dict(base_query_spec.get("source"), field="source")
    source_datasource_id = source.get("datasource_id")
    if source_datasource_id is None:
        _raise("source.datasource_id is required", field="source.datasource_id")
    if int(source_datasource_id) != int(datasource_id):
        _raise("source.datasource_id must match dataset datasource_id", field="source.datasource_id")

    base = _as_dict(base_query_spec.get("base"), field="base")
    primary_resource_id = _as_str(base.get("primary_resource"), field="base.primary_resource")
    resources_payload = _as_list(base.get("resources"), field="base.resources")
    joins_payload = base.get("joins", [])
    if joins_payload is None:
        joins_payload = []
    joins_payload = _as_list(joins_payload, field="base.joins")

    resources_by_id: dict[str, dict[str, Any]] = {}
    resources_by_resource_id: dict[str, dict[str, Any]] = {}
    seen_resource_ids: set[str] = set()
    for index, raw in enumerate(resources_payload):
        item = _as_dict(raw, field=f"base.resources[{index}]")
        resource_key = _as_str(item.get("id"), field=f"base.resources[{index}].id")
        resource_id = _as_str(item.get("resource_id"), field=f"base.resources[{index}].resource_id")
        if resource_key in resources_by_id:
            _raise(f"Duplicated resource id '{resource_key}'", field=f"base.resources[{index}].id")
        if resource_id in seen_resource_ids:
            _raise(f"Duplicated resource_id '{resource_id}'", field=f"base.resources[{index}].resource_id")
        seen_resource_ids.add(resource_id)

        if "." not in resource_id:
            _raise("resource_id must be in 'schema.resource' format", field=f"base.resources[{index}].resource_id")
        schema_name, view_name = resource_id.split(".", 1)
        if not schema_name or not view_name:
            _raise("resource_id must be in 'schema.resource' format", field=f"base.resources[{index}].resource_id")

        view = (
            db.query(View)
            .filter(
                View.datasource_id == datasource_id,
                View.schema_name == schema_name,
                View.view_name == view_name,
                View.is_active == True,  # noqa: E712
            )
            .first()
        )
        if view is None:
            _raise(
                f"Resource '{resource_id}' is not registered/active in datasource",
                field=f"base.resources[{index}].resource_id",
            )
        column_types = {column.column_name: normalize_column_type(column.column_type) for column in view.columns}
        raw_column_types = {column.column_name: (column.column_type or "text") for column in view.columns}
        resources_by_id[resource_key] = {
            "resource_id": resource_id,
            "column_types": column_types,
            "raw_column_types": raw_column_types,
        }
        resources_by_resource_id[resource_id] = resources_by_id[resource_key]

    if not resources_by_id:
        _raise("At least one resource is required", field="base.resources")
    if primary_resource_id not in resources_by_resource_id:
        _raise("base.primary_resource must match one of base.resources[*].resource_id", field="base.primary_resource")

    for index, raw in enumerate(joins_payload):
        item = _as_dict(raw, field=f"base.joins[{index}]")
        join_type = _as_str(item.get("type"), field=f"base.joins[{index}].type").lower()
        if join_type not in _ALLOWED_JOIN_TYPES:
            _raise("join type must be 'inner' or 'left'", field=f"base.joins[{index}].type")
        left_resource = _as_str(item.get("left_resource"), field=f"base.joins[{index}].left_resource")
        right_resource = _as_str(item.get("right_resource"), field=f"base.joins[{index}].right_resource")
        if left_resource not in resources_by_id:
            _raise("Unknown left_resource", field=f"base.joins[{index}].left_resource")
        if right_resource not in resources_by_id:
            _raise("Unknown right_resource", field=f"base.joins[{index}].right_resource")
        on_payload = _as_list(item.get("on"), field=f"base.joins[{index}].on")
        if not on_payload:
            _raise("Join must contain at least one join key", field=f"base.joins[{index}].on")
        for on_index, on_raw in enumerate(on_payload):
            on_item = _as_dict(on_raw, field=f"base.joins[{index}].on[{on_index}]")
            left_column = _as_str(on_item.get("left_column"), field=f"base.joins[{index}].on[{on_index}].left_column")
            right_column = _as_str(on_item.get("right_column"), field=f"base.joins[{index}].on[{on_index}].right_column")
            if left_column not in resources_by_id[left_resource]["column_types"]:
                _raise("Unknown left join column", field=f"base.joins[{index}].on[{on_index}].left_column")
            if right_column not in resources_by_id[right_resource]["column_types"]:
                _raise("Unknown right join column", field=f"base.joins[{index}].on[{on_index}].right_column")

    preprocess = _as_dict(base_query_spec.get("preprocess"), field="preprocess")
    preprocess_columns = _as_dict(preprocess.get("columns"), field="preprocess.columns")
    include_payload = preprocess_columns.get("include", [])
    exclude_payload = preprocess_columns.get("exclude", [])
    include_payload = _as_list(include_payload, field="preprocess.columns.include")
    exclude_payload = _as_list(exclude_payload, field="preprocess.columns.exclude")
    computed_payload = _as_list(preprocess.get("computed_columns", []), field="preprocess.computed_columns")
    dataset_filters = _as_list(preprocess.get("filters", []), field="preprocess.filters")

    semantic_columns: list[dict[str, Any]] = []
    semantic_types: dict[str, str] = {}
    semantic_names: set[str] = set()

    def _add_semantic_column(name: str, data_type: str, *, source: str, raw_type: str | None = None) -> None:
        if name in semantic_names:
            _raise(f"Duplicated semantic column alias '{name}'")
        semantic_names.add(name)
        semantic_types[name] = data_type
        semantic_columns.append(
            {
                "name": name,
                "type": data_type,
                "raw_type": raw_type or _raw_type_from_semantic_type(data_type),
                "source": source,
            }
        )

    if include_payload:
        for index, raw in enumerate(include_payload):
            item = _as_dict(raw, field=f"preprocess.columns.include[{index}]")
            resource_key = _as_str(item.get("resource"), field=f"preprocess.columns.include[{index}].resource")
            column_name = _as_str(item.get("column"), field=f"preprocess.columns.include[{index}].column")
            alias = _as_str(item.get("alias"), field=f"preprocess.columns.include[{index}].alias")
            if resource_key not in resources_by_id:
                _raise("Unknown include resource", field=f"preprocess.columns.include[{index}].resource")
            column_type = resources_by_id[resource_key]["column_types"].get(column_name)
            if column_type is None:
                _raise("Unknown include column", field=f"preprocess.columns.include[{index}].column")
            raw_column_type = resources_by_id[resource_key]["raw_column_types"].get(column_name)
            _add_semantic_column(alias, column_type, source="projected", raw_type=raw_column_type)
    else:
        primary_resource = resources_by_resource_id[primary_resource_id]
        for column_name, column_type in primary_resource["column_types"].items():
            raw_column_type = primary_resource["raw_column_types"].get(column_name)
            _add_semantic_column(column_name, column_type, source="projected", raw_type=raw_column_type)

    if exclude_payload:
        excluded_names: set[str] = set()
        for index, raw in enumerate(exclude_payload):
            if isinstance(raw, str):
                if not raw.strip():
                    _raise("Exclude alias cannot be empty", field=f"preprocess.columns.exclude[{index}]")
                excluded_names.add(raw.strip())
                continue
            item = _as_dict(raw, field=f"preprocess.columns.exclude[{index}]")
            alias = item.get("alias")
            if isinstance(alias, str) and alias.strip():
                excluded_names.add(alias.strip())
                continue
            resource_key = _as_str(item.get("resource"), field=f"preprocess.columns.exclude[{index}].resource")
            column_name = _as_str(item.get("column"), field=f"preprocess.columns.exclude[{index}].column")
            if resource_key not in resources_by_id:
                _raise("Unknown exclude resource", field=f"preprocess.columns.exclude[{index}].resource")
            if column_name not in resources_by_id[resource_key]["column_types"]:
                _raise("Unknown exclude column", field=f"preprocess.columns.exclude[{index}].column")
            excluded_names.add(column_name)

        semantic_columns = [item for item in semantic_columns if item["name"] not in excluded_names]
        semantic_types = {item["name"]: item["type"] for item in semantic_columns}
        semantic_names = set(semantic_types.keys())
        if not semantic_columns:
            _raise("At least one semantic column must remain after exclude")

    for index, raw in enumerate(computed_payload):
        item = _as_dict(raw, field=f"preprocess.computed_columns[{index}]")
        alias = _as_str(item.get("alias"), field=f"preprocess.computed_columns[{index}].alias")
        expr = item.get("expr")
        if expr is None:
            _raise("computed column expr is required", field=f"preprocess.computed_columns[{index}].expr")
        _validate_expr_node(
            expr,
            field=f"preprocess.computed_columns[{index}].expr",
            available_columns=set(semantic_names),
        )
        data_type = _normalize_semantic_type(item.get("data_type"))
        _add_semantic_column(alias, data_type, source="computed")

    for index, raw in enumerate(dataset_filters):
        item = _as_dict(raw, field=f"preprocess.filters[{index}]")
        field_name = item.get("field") if "field" in item else item.get("column")
        field_name = _as_str(field_name, field=f"preprocess.filters[{index}].field")
        if field_name not in semantic_types:
            _raise("Unknown filter column in preprocess.filters", field=f"preprocess.filters[{index}].field")
        op = _as_str(item.get("op"), field=f"preprocess.filters[{index}].op")
        if op not in _ALLOWED_FILTER_OPS:
            _raise("Unsupported filter op in preprocess.filters", field=f"preprocess.filters[{index}].op")

    return base_query_spec, semantic_columns
