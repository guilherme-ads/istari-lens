from __future__ import annotations

from app.modules.core.legacy.models import Dataset

_BLOCKED_IMPORTED_STATUSES = {"draft", "initializing", "drift_blocked", "paused"}


def normalize_access_mode(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"direct", "imported"}:
        return normalized
    return "direct"


def normalize_data_status(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized:
        return normalized
    return "ready"


def has_published_import_binding(dataset: Dataset) -> bool:
    return (
        getattr(dataset, "execution_datasource_id", None) is not None
        and getattr(dataset, "execution_view_id", None) is not None
        and getattr(dataset, "last_successful_sync_at", None) is not None
    )


def resolve_effective_access_mode(dataset: Dataset) -> str:
    if normalize_access_mode(getattr(dataset, "access_mode", None)) != "imported":
        return "direct"
    if not has_published_import_binding(dataset):
        return "direct"
    if normalize_data_status(getattr(dataset, "data_status", None)) in _BLOCKED_IMPORTED_STATUSES:
        return "direct"
    return "imported"
