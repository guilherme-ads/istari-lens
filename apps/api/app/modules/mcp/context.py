from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload

from app.modules.core.legacy.models import Dashboard, Dataset, User, View
from app.modules.datasets.access import can_view_dataset, ensure_dataset_view_access

ACCESS_RANK = {"view": 1, "edit": 2, "owner": 3}
DATASET_WIDGET_VIEW_NAME = "__dataset_base"


def semantic_raw_type(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized == "temporal":
        return "timestamp"
    if normalized in {"numeric", "boolean", "text"}:
        return normalized
    return value or "text"


def normalize_semantic_type(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"numeric", "boolean", "text", "temporal"}:
        return normalized
    if any(token in normalized for token in ["int", "numeric", "decimal", "real", "double", "float", "money"]):
        return "numeric"
    if any(token in normalized for token in ["date", "time", "timestamp"]):
        return "temporal"
    if "bool" in normalized:
        return "boolean"
    return "text"


def dataset_column_types(dataset: Dataset) -> dict[str, str]:
    semantic = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
    columns: dict[str, str] = {}
    for item in semantic:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        data_type = item.get("type")
        if not isinstance(name, str) or not name.strip():
            continue
        item_raw_type = item.get("raw_type")
        if isinstance(item_raw_type, str) and item_raw_type.strip():
            raw_type = item_raw_type.strip()
        else:
            raw_type = semantic_raw_type(str(data_type) if isinstance(data_type, str) else "text")
        columns[name] = raw_type
    if columns:
        return columns
    if dataset.view:
        return {column.column_name: column.column_type for column in dataset.view.columns}
    raise HTTPException(status_code=400, detail="Dataset has no semantic columns and no legacy view columns")


def dataset_semantic_columns(dataset: Dataset) -> list[dict[str, Any]]:
    semantic = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
    columns: list[dict[str, Any]] = []
    for item in semantic:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        semantic_type = normalize_semantic_type(str(item.get("type") or item.get("raw_type") or "text"))
        columns.append(
            {
                "name": name.strip(),
                "type": semantic_type,
                "raw_type": str(item.get("raw_type") or semantic_raw_type(semantic_type)),
                "description": str(item.get("description") or name).strip(),
                "source": "semantic",
            }
        )
    if columns:
        return columns
    if dataset.view:
        return [
            {
                "name": item.column_name,
                "type": normalize_semantic_type(item.column_type),
                "raw_type": item.column_type,
                "description": item.description or item.column_name,
                "source": "view",
            }
            for item in dataset.view.columns
        ]
    return []


def load_dataset_access_query(db: Session):
    return db.query(Dataset).options(
        joinedload(Dataset.datasource),
        joinedload(Dataset.email_shares),
        joinedload(Dataset.view).joinedload(View.columns),
        joinedload(Dataset.metrics),
        joinedload(Dataset.dimensions),
    )


def load_accessible_dataset(*, db: Session, dataset_id: int, current_user: User) -> Dataset:
    dataset = load_dataset_access_query(db).filter(Dataset.id == int(dataset_id)).first()
    ensure_dataset_view_access(dataset=dataset, user=current_user)
    return dataset


def list_accessible_datasets(*, db: Session, current_user: User, limit: int, search: str | None = None) -> list[Dataset]:
    query = load_dataset_access_query(db)
    if search and search.strip():
        token = f"%{search.strip()}%"
        query = query.filter((Dataset.name.ilike(token)) | (Dataset.description.ilike(token)))
    candidates = query.order_by(Dataset.updated_at.desc(), Dataset.id.desc()).limit(300).all()
    visible = [item for item in candidates if can_view_dataset(dataset=item, user=current_user)]
    return visible[: max(1, min(100, int(limit)))]


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def resolve_dashboard_access(*, dashboard: Dashboard, user: User) -> tuple[str, str] | None:
    if getattr(user, "is_admin", False):
        return ("owner", "organization")
    if int(dashboard.created_by_id or 0) == int(user.id):
        return ("owner", "owner")

    normalized_email = _normalize_email(user.email)
    direct_level: str | None = None
    for share in dashboard.email_shares or []:
        if _normalize_email(share.email) != normalized_email:
            continue
        if share.permission == "edit":
            direct_level = "edit"
            break
        if direct_level is None:
            direct_level = "view"

    workspace_level: str | None = None
    if dashboard.visibility == "workspace_edit":
        workspace_level = "edit"
    elif dashboard.visibility in {"workspace_view", "public_view"}:
        workspace_level = "view"

    if direct_level and workspace_level:
        if ACCESS_RANK[direct_level] >= ACCESS_RANK[workspace_level]:
            return (direct_level, "direct")
        return (workspace_level, "workspace")
    if direct_level:
        return (direct_level, "direct")
    if workspace_level:
        return (workspace_level, "workspace")
    if getattr(user, "is_owner", False):
        return ("view", "organization")
    return None


def load_dashboard_for_dataset(
    *,
    db: Session,
    dashboard_id: int,
    dataset_id: int,
    current_user: User,
    min_level: str = "view",
) -> tuple[Dashboard, str, str]:
    dashboard = (
        db.query(Dashboard)
        .options(
            joinedload(Dashboard.widgets),
            joinedload(Dashboard.email_shares),
            joinedload(Dashboard.dataset).joinedload(Dataset.datasource),
            joinedload(Dashboard.dataset).joinedload(Dataset.view).joinedload(View.columns),
            joinedload(Dashboard.dataset).joinedload(Dataset.metrics),
            joinedload(Dashboard.dataset).joinedload(Dataset.dimensions),
        )
        .filter(Dashboard.id == int(dashboard_id))
        .first()
    )
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    if int(dashboard.dataset_id) != int(dataset_id):
        raise HTTPException(status_code=400, detail="Dashboard does not belong to provided dataset_id")
    resolved = resolve_dashboard_access(dashboard=dashboard, user=current_user)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    level, source = resolved
    if ACCESS_RANK[level] < ACCESS_RANK[min_level]:
        raise HTTPException(status_code=403, detail="You do not have permission for this dashboard action")
    return dashboard, level, source
