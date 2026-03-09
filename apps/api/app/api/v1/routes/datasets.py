from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Any, List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Dataset, View, DataSource
from app.modules.datasets import build_legacy_base_query_spec, validate_and_resolve_base_query_spec
from app.modules.core.legacy.schemas import DatasetResponse, DatasetCreateRequest, DatasetUpdateRequest
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
    datasets = (
        db.query(Dataset)
        .filter(Dataset.is_active == True)
        .all()
    )
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


