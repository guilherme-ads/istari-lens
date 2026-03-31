from __future__ import annotations

from app.modules.core.legacy.models import Dataset, View
from app.modules.core.legacy.schemas import QuerySpec
from app.modules.datasets import compose_engine_query_spec_with_dataset, resolve_effective_access_mode


def to_engine_query_spec(
    spec: QuerySpec,
    *,
    view: View | None = None,
    dataset: Dataset | None = None,
) -> dict[str, object]:
    filters_payload: list[dict[str, object]] = []
    for item in spec.filters:
        value = item.value
        if isinstance(value, list) and item.op in {"eq", "neq", "contains", "not_contains", "gte", "lte", "gt", "lt"}:
            value = value[0] if value else None
        filters_payload.append({"field": item.field, "op": item.op, "value": value})

    if view is None and dataset is None:
        raise ValueError("to_engine_query_spec requires either view or dataset")
    resolved_view = view
    if dataset is not None:
        if resolve_effective_access_mode(dataset) == "imported" and dataset.execution_view is not None:
            resolved_view = dataset.execution_view
        elif resolved_view is None:
            resolved_view = dataset.view
    if dataset is None and resolved_view is None:
        raise ValueError("Dataset has no attached view and no explicit view was provided")

    payload: dict[str, object] = {
        "resource_id": (
            f"{resolved_view.schema_name}.{resolved_view.view_name}"
            if resolved_view is not None
            else "__dataset_base"
        ),
        "metrics": [{"field": metric.field, "agg": metric.agg} for metric in spec.metrics],
        "dimensions": list(spec.dimensions),
        "filters": filters_payload,
        "sort": [{"field": item.field, "dir": item.dir} for item in spec.sort],
        "limit": min(spec.limit, 5000),
        "offset": max(0, spec.offset),
    }
    if dataset is not None:
        return compose_engine_query_spec_with_dataset(dataset=dataset, query_spec=payload)
    return payload
