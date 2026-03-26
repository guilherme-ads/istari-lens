from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import DataSource, Dataset, User
from app.modules.datasets import resolve_effective_access_mode
from app.modules.engine.datasource import resolve_datasource_url


@dataclass(slots=True)
class DatasourceAccessContext:
    datasource_id: int
    datasource_url: str
    workspace_id: int
    dataset_id: int | None
    actor_user_id: int | None
    logical_datasource_id: int | None = None
    effective_access_mode: str = "direct"
    execution_view_id: int | None = None


def resolve_datasource_access(
    *,
    datasource: DataSource | None,
    dataset: Dataset | None,
    current_user: User | None,
) -> DatasourceAccessContext:
    if dataset is not None and not dataset.is_active:
        raise HTTPException(status_code=400, detail="Dataset is inactive")

    logical_datasource = dataset.datasource if dataset is not None and dataset.datasource is not None else datasource
    if logical_datasource is None:
        raise HTTPException(status_code=400, detail="Datasource not found")
    if not logical_datasource.is_active:
        raise HTTPException(status_code=400, detail="Datasource is inactive")

    effective_access_mode = resolve_effective_access_mode(dataset) if dataset is not None else "direct"
    effective_datasource = logical_datasource
    if dataset is not None and effective_access_mode == "imported":
        execution_datasource = dataset.execution_datasource
        if execution_datasource is None:
            raise HTTPException(status_code=409, detail="Imported dataset execution datasource is unavailable")
        if not execution_datasource.is_active:
            raise HTTPException(status_code=409, detail="Imported dataset execution datasource is inactive")
        effective_datasource = execution_datasource

    workspace_id = int(logical_datasource.created_by_id)
    actor_user_id = int(current_user.id) if current_user is not None else None
    datasource_url = resolve_datasource_url(effective_datasource)
    if not datasource_url:
        raise HTTPException(status_code=400, detail="Datasource URL is unavailable")

    dataset_id = int(dataset.id) if dataset is not None else None
    return DatasourceAccessContext(
        datasource_id=int(effective_datasource.id),
        datasource_url=datasource_url,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
        actor_user_id=actor_user_id,
        logical_datasource_id=int(logical_datasource.id),
        effective_access_mode=effective_access_mode,
        execution_view_id=int(dataset.execution_view_id) if dataset is not None and dataset.execution_view_id is not None else None,
    )


def resolve_datasource_access_by_dataset(
    *,
    db: Session,
    dataset_id: int,
    current_user: User | None,
) -> DatasourceAccessContext:
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    datasource = dataset.datasource
    return resolve_datasource_access(
        datasource=datasource,
        dataset=dataset,
        current_user=current_user,
    )
