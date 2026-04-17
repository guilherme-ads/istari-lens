from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SemanticLabelIndex:
    field_labels: dict[str, str] = field(default_factory=dict)
    metric_labels: dict[str, str] = field(default_factory=dict)
    dimension_labels: dict[str, str] = field(default_factory=dict)
    synonym_to_canonical: dict[str, str] = field(default_factory=dict)
    metric_units: dict[str, str] = field(default_factory=dict)
    field_semantic_types: dict[str, str] = field(default_factory=dict)


_SPLIT_TOKEN_PATTERN = re.compile(r"[_\-.]+")


def humanize_identifier(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "Campo"
    normalized = _SPLIT_TOKEN_PATTERN.sub(" ", raw).strip()
    if not normalized:
        return "Campo"
    return " ".join(item[:1].upper() + item[1:] for item in normalized.split() if item)


def build_semantic_label_index(
    *,
    catalog: dict[str, Any] | None,
    schema: dict[str, Any] | None,
    semantic_layer: dict[str, Any] | None,
) -> SemanticLabelIndex:
    index = SemanticLabelIndex()

    for field in _schema_fields(schema):
        name = str(field.get("name") or "").strip()
        if not name:
            continue
        description = str(field.get("description") or "").strip()
        label = description if _is_short_human_description(description, name) else humanize_identifier(name)
        index.field_labels[name.lower()] = label
        semantic_type = str(field.get("semantic_type") or "").strip().lower()
        if semantic_type:
            index.field_semantic_types[name.lower()] = semantic_type

    for column in _semantic_columns(semantic_layer):
        name = str(column.get("name") or "").strip()
        if not name:
            continue
        description = str(column.get("description") or "").strip()
        existing = index.field_labels.get(name.lower())
        if existing and existing != humanize_identifier(name):
            pass
        else:
            index.field_labels[name.lower()] = description if _is_short_human_description(description, name) else humanize_identifier(name)
        semantic_type = str(column.get("type") or column.get("semantic_type") or "").strip().lower()
        if semantic_type:
            index.field_semantic_types[name.lower()] = semantic_type

    if isinstance(catalog, dict):
        for item in _catalog_items(catalog.get("metrics")):
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            display_name = _extract_display_name(item, default=name)
            index.metric_labels[name.lower()] = display_name
            index.field_labels.setdefault(name.lower(), display_name)
            unit = str(item.get("unit") or "").strip()
            if unit:
                index.metric_units[name.lower()] = unit
            for synonym in _extract_synonyms(item):
                index.synonym_to_canonical[synonym.lower()] = name.lower()

        for item in _catalog_items(catalog.get("dimensions")):
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            display_name = _extract_display_name(item, default=name)
            index.dimension_labels[name.lower()] = display_name
            index.field_labels.setdefault(name.lower(), display_name)
            for synonym in _extract_synonyms(item):
                index.synonym_to_canonical[synonym.lower()] = name.lower()

    return index


def resolve_field_label(index: SemanticLabelIndex, field_name: str) -> str:
    key = str(field_name or "").strip().lower()
    if not key:
        return "Campo"
    canonical = index.synonym_to_canonical.get(key, key)
    if canonical in index.metric_labels:
        return index.metric_labels[canonical]
    if canonical in index.dimension_labels:
        return index.dimension_labels[canonical]
    if canonical in index.field_labels:
        return index.field_labels[canonical]
    return humanize_identifier(field_name)


def resolve_metric_label(*, index: SemanticLabelIndex, field_name: str, agg: str | None) -> str:
    field_label = resolve_field_label(index, field_name)
    normalized_agg = str(agg or "").strip().lower()
    if normalized_agg in {"", "sum"} and str(field_name or "").strip().lower() in index.metric_labels:
        return field_label
    if normalized_agg in {"", "raw"}:
        return field_label
    agg_label = {
        "sum": "Soma de",
        "avg": "Media de",
        "min": "Minimo de",
        "max": "Maximo de",
        "count": "Contagem de",
        "distinct_count": "Contagem distinta de",
    }.get(normalized_agg, f"{humanize_identifier(normalized_agg)} de")
    return f"{agg_label} {field_label}"


def resolve_metric_unit(index: SemanticLabelIndex, field_name: str) -> str | None:
    key = str(field_name or "").strip().lower()
    if not key:
        return None
    canonical = index.synonym_to_canonical.get(key, key)
    unit = index.metric_units.get(canonical)
    return unit if unit else None


def resolve_field_semantic_type(index: SemanticLabelIndex, field_name: str) -> str | None:
    key = str(field_name or "").strip().lower()
    if not key:
        return None
    canonical = index.synonym_to_canonical.get(key, key)
    semantic_type = index.field_semantic_types.get(canonical)
    return semantic_type if semantic_type else None


def _schema_fields(schema: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(schema, dict):
        return []
    fields = schema.get("fields")
    if not isinstance(fields, list):
        return []
    return [item for item in fields if isinstance(item, dict)]


def _semantic_columns(semantic_layer: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(semantic_layer, dict):
        return []
    fields = semantic_layer.get("semantic_columns")
    if not isinstance(fields, list):
        return []
    return [item for item in fields if isinstance(item, dict)]


def _catalog_items(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _extract_display_name(item: dict[str, Any], *, default: str) -> str:
    for key in ("display_name", "label", "title"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return humanize_identifier(str(default))


def _extract_synonyms(item: dict[str, Any]) -> list[str]:
    raw = item.get("synonyms")
    if not isinstance(raw, list):
        return []
    return [str(value).strip() for value in raw if isinstance(value, str) and value.strip()]


def _is_short_human_description(description: str, name: str) -> bool:
    value = str(description or "").strip()
    if not value:
        return False
    if value.lower() == str(name or "").strip().lower():
        return False
    return len(value) <= 48
