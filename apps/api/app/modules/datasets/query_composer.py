from __future__ import annotations

from copy import deepcopy
from typing import Any

from fastapi import HTTPException

from app.modules.core.legacy.models import Dataset, View

_COMPOSED_RESOURCE_ID = "__dataset_base"


def build_legacy_base_query_spec(*, datasource_id: int, view: View) -> dict[str, Any]:
    resource_id = f"{view.schema_name}.{view.view_name}"
    return {
        "version": 1,
        "source": {"datasource_id": datasource_id},
        "base": {
            "primary_resource": resource_id,
            "resources": [{"id": "base", "resource_id": resource_id}],
            "joins": [],
        },
        "preprocess": {
            "columns": {"include": [], "exclude": []},
            "computed_columns": [],
            "filters": [],
        },
    }


def resolve_dataset_base_query_spec(dataset: Dataset) -> dict[str, Any]:
    if isinstance(dataset.base_query_spec, dict):
        return deepcopy(dataset.base_query_spec)
    if dataset.view is not None:
        return build_legacy_base_query_spec(
            datasource_id=int(dataset.datasource_id),
            view=dataset.view,
        )
    raise HTTPException(status_code=400, detail="Dataset has no base_query_spec and no legacy view_id")


def compose_engine_query_spec_with_dataset(
    *,
    dataset: Dataset,
    query_spec: dict[str, Any],
) -> dict[str, Any]:
    composed = deepcopy(query_spec)
    composed["resource_id"] = _COMPOSED_RESOURCE_ID
    composed["base_query"] = resolve_dataset_base_query_spec(dataset)
    return composed

