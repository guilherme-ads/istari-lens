from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.schemas import QuerySpec

_CAST_SUFFIX_RE = re.compile(r"::[a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?$")
_DATE_TRUNC_RE = re.compile(r"^date_trunc\(\s*'([a-z]+)'\s*,\s*(.+)\)$", re.IGNORECASE)
_AT_TZ_RE = re.compile(r"^(.+)\s+at\s+time\s+zone\s+'([^']+)'$", re.IGNORECASE)
_VALID_TIME_GRANULARITIES = {"day", "week", "month", "hour"}


def _normalize_timezone(value: str | None) -> str:
    normalized = _normalize_column_expr(value or "")
    return normalized or "utc"


def _normalize_time_granularity(value: str | None) -> str:
    normalized = _normalize_column_expr(value or "day") or "day"
    if normalized in {"d", "daily"}:
        normalized = "day"
    if normalized in {"w", "weekly"}:
        normalized = "week"
    if normalized in {"m", "monthly"}:
        normalized = "month"
    if normalized in {"h", "hourly"}:
        normalized = "hour"
    return normalized if normalized in _VALID_TIME_GRANULARITIES else "day"


def _normalize_column_expr(value: str | None) -> str | None:
    if value is None:
        return None
    expr = str(value).strip()
    if not expr:
        return expr
    lowered = re.sub(r"\s+", " ", expr).strip().lower()
    while True:
        updated = _CAST_SUFFIX_RE.sub("", lowered).strip()
        if updated == lowered:
            break
        lowered = updated
    return lowered


def _normalize_time_payload(value: dict[str, Any] | None, timezone: str) -> dict[str, Any] | None:
    if not value:
        return None
    column = _normalize_column_expr(str(value.get("column") or ""))
    granularity = _normalize_time_granularity(str(value.get("granularity") or "day"))
    if column:
        parsed = _DATE_TRUNC_RE.match(column)
        if parsed:
            granularity = _normalize_time_granularity(parsed.group(1))
            column = _normalize_column_expr(parsed.group(2))
        parsed_tz = _AT_TZ_RE.match(column or "")
        if parsed_tz and _normalize_column_expr(parsed_tz.group(2)) == _normalize_timezone(timezone):
            column = _normalize_column_expr(parsed_tz.group(1))
    timezone_normalized = _normalize_timezone(timezone)
    return {
        "column": column,
        "granularity": granularity,
        "timezone": timezone_normalized,
        "signature": f"{granularity}:{column}:{timezone_normalized}",
    }


def _normalize_filter_payload(value: dict[str, Any] | Any, timezone: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        value = {}
    field = _normalize_column_expr(str(value.get("field") or ""))
    op = str(value.get("op") or "").strip().lower()
    normalized: dict[str, Any] = {"field": field, "op": op}
    if op not in {"is_null", "not_null"}:
        normalized["value"] = _normalize_value(value.get("value"))
    normalized["timezone"] = _normalize_timezone(timezone)
    return normalized


def _normalize_metric_payload(value: dict[str, Any], timezone: str) -> dict[str, Any]:
    normalized = _normalize_value(value)
    if not isinstance(normalized, dict):
        return {"agg": "count", "field": None, "filters": []}
    normalized["field"] = _normalize_column_expr(str(normalized.get("field"))) if normalized.get("field") is not None else None
    normalized["agg"] = str(normalized.get("agg") or "count").lower()
    raw_filters = normalized.get("filters") or []
    if isinstance(raw_filters, list):
        seen: set[str] = set()
        metric_filters: list[dict[str, Any]] = []
        for item in raw_filters:
            if not isinstance(item, dict):
                continue
            payload = _normalize_filter_payload(item, timezone)
            key = _canonical_json(payload)
            if key in seen:
                continue
            seen.add(key)
            metric_filters.append(payload)
        normalized["filters"] = sorted(metric_filters, key=_canonical_json)
    else:
        normalized["filters"] = []
    return normalized


def _normalize_scalar(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        stripped = value.strip()
        if stripped != value:
            value = stripped
        if value.lower() in {"true", "false"}:
            return value.lower() == "true"
        try:
            if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
                return int(value)
            if any(token in value for token in [".", "e", "E"]):
                return float(value)
        except ValueError:
            return value
    return value


def _normalize_value(value: Any) -> Any:
    if isinstance(value, dict):
        normalized_items = {str(key): _normalize_value(item) for key, item in value.items()}
        return {key: normalized_items[key] for key in sorted(normalized_items)}
    if isinstance(value, list):
        normalized = [_normalize_value(item) for item in value]
        if all(not isinstance(item, (dict, list)) for item in normalized):
            return sorted(normalized, key=lambda item: json.dumps(item, sort_keys=True, default=str))
        return normalized
    return _normalize_scalar(value)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)


def canonicalize_query_spec(spec: QuerySpec) -> dict[str, Any]:
    payload = spec.model_dump(mode="json")

    timezone = payload.get("timezone") or "UTC"
    timezone_normalized = _normalize_timezone(str(timezone))
    widget_type = payload.get("widget_type") or "table"
    limit = payload.get("limit") if payload.get("limit") is not None else 500
    if widget_type != "table":
        limit = 500
    offset = payload.get("offset") if payload.get("offset") is not None else 0

    normalized_metrics = [_normalize_metric_payload(item, str(timezone)) for item in payload.get("metrics", [])]
    deduped_metrics_map = {_canonical_json(item): item for item in normalized_metrics}
    metrics = [deduped_metrics_map[key] for key in sorted(deduped_metrics_map)]

    normalized_dimensions = [
        _normalize_column_expr(str(item))
        for item in payload.get("dimensions", [])
        if str(item).strip()
    ]
    deduped_dimensions = sorted({item for item in normalized_dimensions if item}, key=lambda item: item or "")
    dimensions = list(deduped_dimensions)
    order_by = sorted(
        [_normalize_value(item) for item in payload.get("order_by", [])],
        key=_canonical_json,
    )
    sort = sorted(
        [_normalize_value(item) for item in payload.get("sort", [])],
        key=_canonical_json,
    )
    normalized_filters: list[dict[str, Any]] = []
    seen_filter_keys: set[str] = set()
    for item in payload.get("filters", []):
        normalized = _normalize_filter_payload(item, str(timezone))
        if not normalized.get("field") or not normalized.get("op"):
            continue
        filter_key = _canonical_json(normalized)
        if filter_key in seen_filter_keys:
            continue
        seen_filter_keys.add(filter_key)
        normalized_filters.append(normalized)
    filters = sorted(normalized_filters, key=_canonical_json)

    time_payload = _normalize_time_payload(payload.get("time"), str(timezone)) if payload.get("time") else None
    time_range_payload = _normalize_value(payload.get("time_range")) if payload.get("time_range") else None
    composite_payload = _normalize_value(payload.get("composite_metric")) if payload.get("composite_metric") else None
    dre_rows_payload = [_normalize_value(item) for item in payload.get("dre_rows", [])]

    group_by: list[str] = []
    if isinstance(time_payload, dict) and time_payload.get("signature"):
        group_by.append(f"time:{time_payload['signature']}")
    group_by.extend(dimensions)

    return {
        "resource_id": str(payload["resource_id"]),
        "widget_type": widget_type,
        "metrics": metrics,
        "dimensions": dimensions,
        "group_by": group_by,
        "filters": filters,
        "sort": sort,
        "order_by": order_by,
        "columns": sorted([str(item) for item in payload.get("columns") or []]),
        "top_n": payload.get("top_n"),
        "limit": int(limit),
        "offset": int(offset),
        "time": time_payload,
        "time_range": time_range_payload,
        "timezone": timezone_normalized,
        "bucket": (time_payload or {}).get("granularity") if isinstance(time_payload, dict) else "day",
        "composite_metric": composite_payload,
        "dre_rows": dre_rows_payload,
    }


def build_query_keys(*, spec: QuerySpec, datasource_url: str) -> tuple[dict[str, Any], str, str]:
    canonical_spec = canonicalize_query_spec(spec)
    canonical_payload = {
        "datasource": datasource_url,
        "spec": canonical_spec,
    }
    canonical_json = _canonical_json(canonical_payload)
    full_hash = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    dedupe_key = f"sf:{full_hash[:24]}"
    cache_key = f"cache:{full_hash}"
    return canonical_spec, dedupe_key, cache_key
