from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Dataset, View
from app.modules.core.legacy.schemas import DatasetResponse, DatasetCreateRequest, DatasetUpdateRequest
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user

router = APIRouter(prefix="/datasets", tags=["datasets"])


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
    return datasets


@router.post("", response_model=DatasetResponse)
async def create_dataset(
    request: DatasetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    """Create a dataset from a registered view. Admin only."""
    view = (
        db.query(View)
        .filter(
            View.id == request.view_id,
            View.datasource_id == request.datasource_id,
        )
        .first()
    )
    if not view:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="View not found for the provided datasource",
        )

    dataset = Dataset(
        datasource_id=request.datasource_id,
        view_id=request.view_id,
        name=request.name,
        description=request.description,
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
    current_user: User = Depends(get_current_admin_user),
):
    """Update dataset metadata. Admin only."""
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
    """Delete a dataset. Admin only."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )

    db.delete(dataset)
    db.commit()


