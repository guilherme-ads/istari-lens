from __future__ import annotations

import copy
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from app.modules.widgets.domain.config import WidgetConfig

_PG_IDENTIFIER_MAX_LEN = 63
_SUPPORTED_WIDGET_TYPES = {"kpi", "bar", "column", "line"}
_SUPPORTED_METRIC_OPS = {"count", "sum", "min", "max"}


@dataclass(slots=True)
class RollupMetricMapping:
    source_op: str
    source_column: str | None
    rollup_column: str
    query_agg: str


@dataclass(slots=True)
class DatasetRollupPlan:
    signature: str
    group_columns: list[str]
    time_column: str | None
    metric_mappings: list[RollupMetricMapping]


def _sanitize_identifier_token(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    token = re.sub(r"[^A-Za-z0-9_]+", "_", ascii_only).strip("_").lower()
    return token or "x"


def _slugify_dataset_name(name: str | None) -> str:
    raw = str(name or "").strip()
    if not raw:
        return "dataset"
    normalized = unicodedata.normalize("NFKD", raw)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "_", ascii_only).strip("_").lower()
    slug = re.sub(r"_+", "_", slug)
    return slug or "dataset"


def _build_dataset_object_prefix(
    *,
    dataset_id: int,
    dataset_name: str | None,
    reserved_suffix_len: int = 0,
) -> str:
    base = f"ds_{int(dataset_id)}__"
    token = _slugify_dataset_name(dataset_name)
    max_token_len = max(1, _PG_IDENTIFIER_MAX_LEN - reserved_suffix_len - len(base))
    return f"{base}{token[:max_token_len]}"


def _build_metric_rollup_column_name(*, metric_index: int, op: str, column: str | None) -> str:
    op_token = _sanitize_identifier_token(op)
    col_token = _sanitize_identifier_token(column or "all")
    base = f"rm_{metric_index}_{op_token}_{col_token}"
    if len(base) <= _PG_IDENTIFIER_MAX_LEN:
        return base
    hash_token = hashlib.sha1(base.encode("utf-8")).hexdigest()[:8]
    head_max_len = max(1, _PG_IDENTIFIER_MAX_LEN - len(hash_token) - 1)
    return f"{base[:head_max_len]}_{hash_token}"


def _dedup_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        normalized = str(item or "").strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def build_rollup_table_name(*, dataset_id: int, dataset_name: str | None, signature: str) -> str:
    sig = str(signature or "").strip().lower()[:12] or "na"
    reserved_suffix_len = len("__rollup_") + len(sig)
    prefix = _build_dataset_object_prefix(
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        reserved_suffix_len=reserved_suffix_len,
    )
    return f"{prefix}__rollup_{sig}"


def resolve_rollup_plan_for_widget(config: WidgetConfig) -> DatasetRollupPlan | None:
    if config.widget_type not in _SUPPORTED_WIDGET_TYPES:
        return None
    if config.widget_type == "kpi" and config.kpi_type != "atomic":
        return None
    if config.composite_metric is not None:
        return None
    if config.kpi_dependencies:
        return None
    if not config.metrics:
        return None

    metric_mappings: list[RollupMetricMapping] = []
    signature_metrics: list[dict[str, Any]] = []
    for idx, metric in enumerate(config.metrics):
        op = str(metric.op or "").strip().lower()
        if op not in _SUPPORTED_METRIC_OPS:
            return None
        column = str(metric.column).strip() if metric.column else None
        if op != "count" and not column:
            return None
        rollup_column = _build_metric_rollup_column_name(metric_index=idx, op=op, column=column)
        query_agg = "sum" if op in {"count", "sum"} else op
        metric_mappings.append(
            RollupMetricMapping(
                source_op=op,
                source_column=column,
                rollup_column=rollup_column,
                query_agg=query_agg,
            )
        )
        signature_metrics.append({"op": op, "column": column})

    group_columns = _dedup_preserve_order(
        [
            *list(config.dimensions or []),
            *(([config.time.column] if config.time else [])),
            *[item.column for item in config.filters or [] if item.column],
            *[item.column for item in config.order_by or [] if item.column],
        ]
    )
    time_column = config.time.column if config.time else None

    signature_payload = {
        "view_name": str(config.view_name or ""),
        "group_columns": group_columns,
        "time_column": time_column,
        "metrics": signature_metrics,
    }
    signature_seed = json.dumps(signature_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    signature = hashlib.sha1(signature_seed.encode("utf-8")).hexdigest()[:12]

    return DatasetRollupPlan(
        signature=signature,
        group_columns=group_columns,
        time_column=time_column,
        metric_mappings=metric_mappings,
    )


def can_apply_rollup_to_query_spec(
    *,
    plan: DatasetRollupPlan,
    query_spec: dict[str, Any],
) -> bool:
    metrics = query_spec.get("metrics") if isinstance(query_spec.get("metrics"), list) else []
    if len(metrics) != len(plan.metric_mappings):
        return False
    for metric, mapping in zip(metrics, plan.metric_mappings):
        if not isinstance(metric, dict):
            return False
        metric_op = str(metric.get("agg") or "").strip().lower()
        metric_field = str(metric.get("field") or "").strip() if metric.get("field") is not None else None
        expected_field = mapping.source_column
        if mapping.source_op == "count":
            if metric_op != "count":
                return False
            if expected_field and metric_field and metric_field != expected_field:
                return False
        else:
            if metric_op != mapping.source_op:
                return False
            if metric_field != expected_field:
                return False

    dimensions = [str(item).strip() for item in (query_spec.get("dimensions") or []) if str(item).strip()]
    for column in dimensions:
        if column not in plan.group_columns:
            return False

    time_cfg = query_spec.get("time")
    if time_cfg is not None:
        if not isinstance(time_cfg, dict):
            return False
        time_column = str(time_cfg.get("column") or "").strip()
        if not time_column or time_column != str(plan.time_column or ""):
            return False

    filters = query_spec.get("filters") if isinstance(query_spec.get("filters"), list) else []
    for item in filters:
        if not isinstance(item, dict):
            continue
        column = str(item.get("field") or "").strip()
        if column and column not in plan.group_columns:
            return False

    order_by = query_spec.get("order_by") if isinstance(query_spec.get("order_by"), list) else []
    for item in order_by:
        if not isinstance(item, dict):
            continue
        column = str(item.get("column") or "").strip()
        metric_ref = str(item.get("metric_ref") or "").strip()
        if column and column not in plan.group_columns:
            return False
        if metric_ref:
            continue
    return True


def rewrite_query_spec_for_rollup(
    *,
    query_spec: dict[str, Any],
    plan: DatasetRollupPlan,
    resource_id: str,
) -> dict[str, Any]:
    rewritten = copy.deepcopy(query_spec)
    rewritten["resource_id"] = resource_id
    metrics = rewritten.get("metrics") if isinstance(rewritten.get("metrics"), list) else []
    for metric, mapping in zip(metrics, plan.metric_mappings):
        if not isinstance(metric, dict):
            continue
        metric["field"] = mapping.rollup_column
        metric["agg"] = mapping.query_agg
    return rewritten
