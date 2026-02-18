from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import DataSource, Dataset, User
from app.modules.engine.datasource import resolve_datasource_url


@dataclass(slots=True)
class DatasourceAccessContext:
    datasource_id: int
    datasource_url: str
    workspace_id: int
    dataset_id: int | None
    actor_user_id: int | None


def resolve_datasource_access(
    *,
    datasource: DataSource | None,
    dataset: Dataset | None,
    current_user: User | None,
) -> DatasourceAccessContext:
    if datasource is None:
        raise HTTPException(status_code=400, detail="Datasource not found")

    workspace_id = int(datasource.created_by_id)
    actor_user_id = int(current_user.id) if current_user is not None else None

    if current_user is not None and not current_user.is_admin and current_user.id != datasource.created_by_id:
        raise HTTPException(status_code=403, detail="User is not authorized for datasource workspace")

    datasource_url = resolve_datasource_url(datasource)
    if not datasource_url:
        raise HTTPException(status_code=400, detail="Datasource URL is unavailable")

    dataset_id = int(dataset.id) if dataset is not None else None
    return DatasourceAccessContext(
        datasource_id=int(datasource.id),
        datasource_url=datasource_url,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
        actor_user_id=actor_user_id,
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
