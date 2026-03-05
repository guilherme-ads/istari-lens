from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Any, List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Dataset, View, DataSource
from app.modules.datasets import build_legacy_base_query_spec, validate_and_resolve_base_query_spec
from app.modules.core.legacy.schemas import DatasetResponse, DatasetCreateRequest, DatasetUpdateRequest
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _resolve_dataset_view(
    *,
    db: Session,
    datasource_id: int,
    view_id: int | None,
) -> View | None:
    if view_id is None:
        return None
    view = (
        db.query(View)
        .filter(
            View.id == view_id,
            View.datasource_id == datasource_id,
        )
        .first()
    )
    if not view:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="View not found for the provided datasource",
        )
    if not view.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="View is inactive",
        )
    if not view.datasource or not view.datasource.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Datasource is inactive",
        )
    return view


def _resolve_dataset_datasource(*, db: Session, datasource_id: int) -> DataSource:
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Datasource not found")
    if not datasource.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Datasource is inactive")
    return datasource


@router.get("", response_model=List[DatasetResponse])
async def list_datasets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List all active datasets available to the user."""
    datasets = (
        db.query(Dataset)
        .filter(Dataset.is_active == True)
        .all()
    )
    response_items: list[DatasetResponse] = []
    for dataset in datasets:
        runtime_semantic_columns = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        if isinstance(dataset.base_query_spec, dict):
            try:
                _, runtime_semantic_columns = validate_and_resolve_base_query_spec(
                    db=db,
                    datasource_id=int(dataset.datasource_id),
                    base_query_spec=dataset.base_query_spec,
                )
            except HTTPException:
                runtime_semantic_columns = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        payload = DatasetResponse.model_validate(dataset)
        payload.semantic_columns = runtime_semantic_columns
        response_items.append(payload)
    return response_items


@router.post("", response_model=DatasetResponse)
async def create_dataset(
    request: DatasetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a dataset from legacy view reference or from base_query_spec."""
    _resolve_dataset_datasource(db=db, datasource_id=request.datasource_id)
    view = _resolve_dataset_view(db=db, datasource_id=request.datasource_id, view_id=request.view_id)

    resolved_base_query_spec = request.base_query_spec
    if resolved_base_query_spec is not None:
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=request.datasource_id,
            base_query_spec=resolved_base_query_spec,
        )
    elif view is not None:
        resolved_base_query_spec = build_legacy_base_query_spec(
            datasource_id=request.datasource_id,
            view=view,
        )
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=request.datasource_id,
            base_query_spec=resolved_base_query_spec,
        )
    else:
        semantic_columns = []

    dataset = Dataset(
        datasource_id=request.datasource_id,
        view_id=request.view_id,
        name=request.name,
        description=request.description,
        base_query_spec=resolved_base_query_spec,
        semantic_columns=semantic_columns,
        is_active=request.is_active,
    )
    db.add(dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


@router.patch("/{dataset_id}", response_model=DatasetResponse)
async def update_dataset(
    dataset_id: int,
    request: DatasetUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update dataset metadata/base_query_spec."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )

    if request.name is not None:
        dataset.name = request.name
    if request.description is not None:
        dataset.description = request.description
    if request.view_id is not None:
        view = _resolve_dataset_view(db=db, datasource_id=dataset.datasource_id, view_id=request.view_id)
        dataset.view_id = request.view_id
        if request.base_query_spec is None and view is not None:
            resolved_base_query_spec = build_legacy_base_query_spec(
                datasource_id=dataset.datasource_id,
                view=view,
            )
            resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
                db=db,
                datasource_id=dataset.datasource_id,
                base_query_spec=resolved_base_query_spec,
            )
            dataset.base_query_spec = resolved_base_query_spec
            dataset.semantic_columns = semantic_columns
    if request.base_query_spec is not None:
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=dataset.datasource_id,
            base_query_spec=request.base_query_spec,
        )
        dataset.base_query_spec = resolved_base_query_spec
        dataset.semantic_columns = semantic_columns
    if request.is_active is not None:
        dataset.is_active = request.is_active

    db.commit()
    db.refresh(dataset)
    return dataset


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    """Delete a dataset and its dashboards. Admin only."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )
    db.delete(dataset)
    db.commit()


