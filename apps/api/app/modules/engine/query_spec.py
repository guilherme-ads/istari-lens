from __future__ import annotations

from app.modules.core.legacy.models import View
from app.modules.core.legacy.schemas import QuerySpec


def to_engine_query_spec(spec: QuerySpec, *, view: View) -> dict[str, object]:
    filters_payload: list[dict[str, object]] = []
    for item in spec.filters:
        value = item.value
        if isinstance(value, list) and item.op in {"eq", "neq", "contains", "gte", "lte", "gt", "lt"}:
            value = value[0] if value else None
        filters_payload.append({"field": item.field, "op": item.op, "value": value})

    return {
        "resource_id": f"{view.schema_name}.{view.view_name}",
        "metrics": [{"field": metric.field, "agg": metric.agg} for metric in spec.metrics],
        "dimensions": list(spec.dimensions),
        "filters": filters_payload,
        "sort": [{"field": item.field, "dir": item.dir} for item in spec.sort],
        "limit": min(spec.limit, 5000),
        "offset": max(0, spec.offset),
    }
