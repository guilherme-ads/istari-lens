from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.schemas import FilterSpec, MetricSpec, QuerySpec

_CAST_SUFFIX_RE = re.compile(r"::[a-zA-Z_][a-zA-Z0-9_]*(?:\[\])?$")
_VALID_TIME_GRANULARITIES = {"day", "week", "month", "hour"}


@dataclass(frozen=True, slots=True)
class StructuralSignature:
    resource_id: str
    widget_type: str
    filters_signature: tuple[str, ...]
    group_by_signature: tuple[str, ...]

    def key(self) -> str:
        return json.dumps(
            {
                "resource_id": self.resource_id,
                "widget_type": self.widget_type,
                "filters_signature": self.filters_signature,
                "group_by_signature": self.group_by_signature,
            },
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )


@dataclass(slots=True)
class QueryFusionGroup:
    signature: StructuralSignature
    member_indexes: list[int]
    can_fuse: bool
    fused_spec: QuerySpec | None
    metric_positions_by_member: dict[int, list[int]]
    reason: str | None = None

    @property
    def metrics_count(self) -> int:
        if self.fused_spec is None:
            return 0
        return len(self.fused_spec.metrics)


class QueryFusionPlanner:
    def build_signature(self, spec: QuerySpec) -> StructuralSignature:
        return StructuralSignature(
            resource_id=spec.resource_id,
            widget_type=spec.widget_type,
            filters_signature=tuple(sorted(self._filter_keys(spec.filters))),
            group_by_signature=tuple(self._group_by_signature(spec)),
        )

    def plan(self, specs_by_index: dict[int, QuerySpec]) -> list[QueryFusionGroup]:
        buckets: dict[str, list[int]] = {}
        signatures: dict[str, StructuralSignature] = {}
        for index, spec in specs_by_index.items():
            signature = self.build_signature(spec)
            signature_key = signature.key()
            signatures[signature_key] = signature
            buckets.setdefault(signature_key, []).append(index)

        groups: list[QueryFusionGroup] = []
        for signature_key, member_indexes in buckets.items():
            signature = signatures[signature_key]
            for subset in self._partition_compatible_groups(sorted(member_indexes), specs_by_index):
                can_fuse, reason = self._is_group_fusion_compatible(subset, specs_by_index)
                if not can_fuse:
                    groups.append(
                        QueryFusionGroup(
                            signature=signature,
                            member_indexes=subset,
                            can_fuse=False,
                            fused_spec=None,
                            metric_positions_by_member={},
                            reason=reason,
                        )
                    )
                    continue

                fused_spec, metric_positions = self._build_fused_spec(subset, specs_by_index)
                groups.append(
                    QueryFusionGroup(
                        signature=signature,
                        member_indexes=subset,
                        can_fuse=True,
                        fused_spec=fused_spec,
                        metric_positions_by_member=metric_positions,
                        reason=None,
                    )
                )
        return groups

    def _partition_compatible_groups(self, member_indexes: list[int], specs_by_index: dict[int, QuerySpec]) -> list[list[int]]:
        remaining = list(member_indexes)
        groups: list[list[int]] = []
        while remaining:
            group = [remaining.pop(0)]
            consumed: list[int] = []
            for candidate in remaining:
                probe = [*group, candidate]
                compatible, _reason = self._is_group_fusion_compatible(probe, specs_by_index)
                if compatible:
                    group.append(candidate)
                    consumed.append(candidate)
            remaining = [idx for idx in remaining if idx not in consumed]
            groups.append(group)
        return groups

    def _is_group_fusion_compatible(self, member_indexes: list[int], specs_by_index: dict[int, QuerySpec]) -> tuple[bool, str]:
        if len(member_indexes) <= 1:
            if not member_indexes:
                return False, "single_member_group"
            single = specs_by_index[member_indexes[0]]
            if not self._is_supported_fusion_shape(single):
                return False, "unsupported_widget_shape"
            limit_reason = self._limit_guard_reason(single)
            if limit_reason:
                return False, limit_reason
            return False, "single_member_group"

        baseline = specs_by_index[member_indexes[0]]
        if not self._is_supported_fusion_shape(baseline):
            return False, "unsupported_widget_shape"

        for idx in member_indexes[1:]:
            current = specs_by_index[idx]
            if current.widget_type != baseline.widget_type:
                return False, "widget_type_mismatch"
            if current.resource_id != baseline.resource_id:
                return False, "resource_mismatch"
            if tuple(self._group_by_signature(current)) != tuple(self._group_by_signature(baseline)):
                return False, "group_by_mismatch"
            if tuple(sorted(self._filter_keys(current.filters))) != tuple(sorted(self._filter_keys(baseline.filters))):
                return False, "filters_mismatch"
            if baseline.widget_type != "line":
                if self._canonical_json(current.sort) != self._canonical_json(baseline.sort):
                    return False, "sort_mismatch"
                if self._canonical_json(current.order_by) != self._canonical_json(baseline.order_by):
                    return False, "order_by_mismatch"
            limit_reason = self._limit_guard_reason(current) or self._limit_guard_reason(baseline)
            if limit_reason:
                return False, limit_reason

        return True, ""

    def _is_supported_fusion_shape(self, spec: QuerySpec) -> bool:
        if spec.widget_type == "kpi":
            return bool(not spec.dimensions and spec.composite_metric is None and not spec.dre_rows)
        if spec.widget_type == "line":
            return bool(spec.time and not spec.composite_metric and not spec.dre_rows)
        return False

    def _time_signature(self, spec: QuerySpec) -> str | None:
        if spec.time is None:
            return None
        timezone = self._canonical_timezone(spec.timezone)
        column = self._canonical_column(spec.time.column)
        granularity = self._canonical_granularity(spec.time.granularity)
        return f"{granularity}:{column}:{timezone}"

    def _limit_guard_reason(self, spec: QuerySpec) -> str | None:
        if spec.offset:
            return "offset_present"
        if spec.top_n is not None:
            return "top_n_present"
        if spec.widget_type == "kpi":
            return None
        if spec.limit not in {None, 500}:
            return "relevant_limit_present"
        return None

    def _build_fused_spec(self, member_indexes: list[int], specs_by_index: dict[int, QuerySpec]) -> tuple[QuerySpec, dict[int, list[int]]]:
        base = specs_by_index[member_indexes[0]]
        shared_filters = list(base.filters)
        fused_metrics: list[MetricSpec] = []
        metrics_positions: dict[str, int] = {}
        mapping: dict[int, list[int]] = {}

        for idx in member_indexes:
            spec = specs_by_index[idx]
            positions: list[int] = []
            for metric in spec.metrics:
                enriched_metric = metric.model_copy()
                key = self._canonical_json(enriched_metric.model_dump(mode="json"))
                if key not in metrics_positions:
                    metrics_positions[key] = len(fused_metrics)
                    fused_metrics.append(enriched_metric)
                positions.append(metrics_positions[key])
            mapping[idx] = positions

        fused_order_by = [] if base.widget_type == "line" else base.order_by
        fused_sort = [] if base.widget_type == "line" else base.sort

        fused_spec = base.model_copy(
            update={
                "metrics": fused_metrics,
                "filters": shared_filters,
                "order_by": fused_order_by,
                "sort": fused_sort,
                "offset": 0,
            }
        )
        return fused_spec, mapping

    def _filter_keys(self, filters: list[FilterSpec]) -> list[str]:
        return [self._filter_key(item) for item in filters]

    def _filter_key(self, item: FilterSpec) -> str:
        return self._canonical_json(
            {
                "field": self._canonical_column(item.field),
                "op": item.op,
                "value": item.value,
            }
        )

    def _canonical_dimensions(self, spec: QuerySpec) -> list[str]:
        return sorted(self._canonical_column(item) for item in spec.dimensions)

    def _group_by_signature(self, spec: QuerySpec) -> list[str]:
        parts: list[str] = []
        time_signature = self._time_signature(spec)
        if time_signature:
            parts.append(f"time:{time_signature}")
        parts.extend(self._canonical_dimensions(spec))
        return parts

    def _canonical_column(self, value: str | None) -> str:
        if value is None:
            return ""
        expr = value.strip().lower()
        while True:
            updated = _CAST_SUFFIX_RE.sub("", expr).strip()
            if updated == expr:
                break
            expr = updated
        return re.sub(r"\s+", " ", expr)

    def _canonical_timezone(self, value: str | None) -> str:
        return self._canonical_column(value or "") or "utc"

    def _canonical_granularity(self, value: str | None) -> str:
        normalized = self._canonical_column(value or "day") or "day"
        aliases = {"d": "day", "daily": "day", "w": "week", "weekly": "week", "m": "month", "monthly": "month", "h": "hour", "hourly": "hour"}
        normalized = aliases.get(normalized, normalized)
        if normalized not in _VALID_TIME_GRANULARITIES:
            return "day"
        return normalized

    @staticmethod
    def _canonical_json(value: object) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
