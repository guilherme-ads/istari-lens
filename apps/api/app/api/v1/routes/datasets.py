from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from typing import Any, List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Dataset, DatasetEmailShare, View, DataSource
from app.modules.catalog import SemanticCatalogService
from app.modules.datasets.access import (
    can_view_organization_data,
    ensure_dataset_manage_access,
    find_dataset_email_share,
    load_dataset_with_access_relations,
    normalize_email,
)
from app.modules.datasets import build_legacy_base_query_spec, validate_and_resolve_base_query_spec
from app.modules.core.legacy.schemas import (
    DatasetCreateRequest,
    DatasetEmailShareResponse,
    DatasetResponse,
    DatasetShareUpsertRequest,
    DatasetSharingResponse,
    DatasetUpdateRequest,
)
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _semantic_description_map(raw_items: list[dict[str, Any]] | None) -> dict[str, str]:
    if not isinstance(raw_items, list):
        return {}
    result: dict[str, str] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        description = item.get("description")
        if not isinstance(description, str):
            continue
        normalized = description.strip()
        if not normalized:
            continue
        result[name.strip()] = normalized
    return result


def _apply_semantic_descriptions(
    semantic_columns: list[dict[str, Any]],
    description_map: dict[str, str],
) -> list[dict[str, Any]]:
    if not semantic_columns:
        return semantic_columns
    if not description_map:
        return semantic_columns
    enriched: list[dict[str, Any]] = []
    for item in semantic_columns:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        name = next_item.get("name")
        if isinstance(name, str):
            description = description_map.get(name.strip())
            if description:
                next_item["description"] = description
        enriched.append(next_item)
    return enriched


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
    query = (
        db.query(Dataset)
        .join(DataSource, DataSource.id == Dataset.datasource_id)
        .filter(Dataset.is_active == True)
    )
    if not can_view_organization_data(current_user):
        normalized_email = normalize_email(current_user.email)
        share_exists = (
            db.query(DatasetEmailShare.id)
            .filter(
                DatasetEmailShare.dataset_id == Dataset.id,
                func.lower(DatasetEmailShare.email) == normalized_email,
            )
            .exists()
        )
        query = query.filter(
            or_(
                DataSource.created_by_id == current_user.id,
                share_exists,
            )
        )
    datasets = query.all()
    response_items: list[DatasetResponse] = []
    for dataset in datasets:
        persisted_descriptions = _semantic_description_map(
            dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None
        )
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
        runtime_semantic_columns = _apply_semantic_descriptions(runtime_semantic_columns, persisted_descriptions)
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
    datasource = _resolve_dataset_datasource(db=db, datasource_id=request.datasource_id)
    if not current_user.is_admin and int(datasource.created_by_id) != int(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to create datasets for this datasource")
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
    semantic_columns = _apply_semantic_descriptions(
        semantic_columns,
        _semantic_description_map(request.semantic_columns),
    )

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
    db.flush()
    SemanticCatalogService(db).ensure_dataset_catalog(dataset=dataset)
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
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)

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
            dataset.semantic_columns = _apply_semantic_descriptions(
                semantic_columns,
                _semantic_description_map(request.semantic_columns)
                or _semantic_description_map(dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None),
            )
    if request.base_query_spec is not None:
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=dataset.datasource_id,
            base_query_spec=request.base_query_spec,
        )
        dataset.base_query_spec = resolved_base_query_spec
        dataset.semantic_columns = _apply_semantic_descriptions(
            semantic_columns,
            _semantic_description_map(request.semantic_columns)
            or _semantic_description_map(dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None),
        )
    elif request.semantic_columns is not None:
        current_semantic = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        dataset.semantic_columns = _apply_semantic_descriptions(
            [dict(item) for item in current_semantic if isinstance(item, dict)],
            _semantic_description_map(request.semantic_columns),
        )
    if request.is_active is not None:
        dataset.is_active = request.is_active

    SemanticCatalogService(db).ensure_dataset_catalog(dataset=dataset)
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


@router.get("/{dataset_id}/sharing", response_model=DatasetSharingResponse)
async def get_dataset_sharing(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


@router.post("/{dataset_id}/sharing/email", response_model=DatasetSharingResponse)
async def upsert_dataset_email_share(
    dataset_id: int,
    request: DatasetShareUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)

    normalized_email = normalize_email(request.email)
    if normalized_email == normalize_email(current_user.email):
        raise HTTPException(status_code=400, detail="Owner already has dataset access")

    invitee = (
        db.query(User)
        .filter(
            func.lower(User.email) == normalized_email,
            User.deleted_at.is_(None),
            User.is_active.is_(True),
        )
        .first()
    )
    if invitee is None:
        raise HTTPException(status_code=400, detail="Email must belong to an active user")

    share = find_dataset_email_share(
        db=db,
        dataset_id=dataset.id,
        normalized_email=normalized_email,
    )
    if share:
        share.updated_at = datetime.utcnow()
    else:
        share = DatasetEmailShare(
            dataset_id=dataset.id,
            email=normalized_email,
            created_by_id=current_user.id,
        )
        db.add(share)

    db.commit()
    db.refresh(dataset)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


@router.delete("/{dataset_id}/sharing/email/{share_id}", response_model=DatasetSharingResponse)
async def delete_dataset_email_share(
    dataset_id: int,
    share_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)

    share = (
        db.query(DatasetEmailShare)
        .filter(
            DatasetEmailShare.id == share_id,
            DatasetEmailShare.dataset_id == dataset.id,
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    db.delete(share)
    db.commit()
    db.refresh(dataset)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


