from __future__ import annotations

import re
from copy import deepcopy
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
import psycopg
from psycopg import sql
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.catalog import SemanticCatalogService
from app.modules.core.legacy.models import DataSource, Dataset, Dimension, Metric, MetricDimension, User
from app.modules.datasets.access import (
    can_view_dataset,
    can_view_organization_data,
    ensure_dataset_manage_access,
    ensure_dataset_view_access,
)
from app.modules.datasets import validate_and_resolve_base_query_spec
from app.modules.datasets.sync_services import DatasetSyncWorkerService
from app.modules.engine import get_engine_client, resolve_datasource_access
from app.shared.infrastructure.database import get_db
from app.shared.infrastructure.settings import get_settings

router = APIRouter(tags=["catalog"])
_SAFE_ALIAS_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class CatalogResourceItem(BaseModel):
    id: str
    schema_name: str
    resource_name: str
    resource_type: str


class CatalogResourcesResponse(BaseModel):
    items: list[CatalogResourceItem] = Field(default_factory=list)


class SchemaFieldResponse(BaseModel):
    name: str
    data_type: str
    nullable: bool


class SchemaGetResponse(BaseModel):
    resource_id: str
    fields: list[SchemaFieldResponse] = Field(default_factory=list)


class CatalogDatasetSummary(BaseModel):
    id: int
    datasource_id: int
    view_id: int | None = None
    name: str
    description: str | None = None
    metrics_count: int
    dimensions_count: int


class CatalogMetricResponse(BaseModel):
    id: int
    dataset_id: int
    name: str
    description: str | None = None
    formula: str
    unit: str | None = None
    default_grain: str | None = None
    synonyms: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)

    class Config:
        from_attributes = True


class CatalogDimensionResponse(BaseModel):
    id: int
    dataset_id: int
    name: str
    description: str | None = None
    type: str
    synonyms: list[str] = Field(default_factory=list)

    class Config:
        from_attributes = True


class CatalogDatasetDetailResponse(BaseModel):
    id: int
    datasource_id: int
    view_id: int | None = None
    name: str
    description: str | None = None
    metrics: list[CatalogMetricResponse] = Field(default_factory=list)
    dimensions: list[CatalogDimensionResponse] = Field(default_factory=list)


class CatalogSearchHit(BaseModel):
    kind: str
    dataset_id: int
    dataset_name: str
    id: int
    name: str
    description: str | None = None


class CatalogSearchResponse(BaseModel):
    items: list[CatalogSearchHit] = Field(default_factory=list)


class CatalogMetricCreateRequest(BaseModel):
    dataset_id: int
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    formula: str = Field(min_length=3, max_length=500)
    unit: str | None = Field(default=None, max_length=64)
    default_grain: str | None = Field(default=None, max_length=64)
    synonyms: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class CatalogMetricUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    formula: str | None = Field(default=None, min_length=3, max_length=500)
    unit: str | None = Field(default=None, max_length=64)
    default_grain: str | None = Field(default=None, max_length=64)
    synonyms: list[str] | None = None
    examples: list[str] | None = None


class CatalogDimensionCreateRequest(BaseModel):
    dataset_id: int
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    type: str = Field(default="categorical", min_length=3, max_length=32)
    synonyms: list[str] = Field(default_factory=list)


class CatalogDimensionUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    type: str | None = Field(default=None, min_length=3, max_length=32)
    synonyms: list[str] | None = None


class CatalogProfilePreviewColumnRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: str = Field(min_length=3, max_length=32)


class CatalogProfilePreviewRequest(BaseModel):
    datasource_id: int
    base_query_spec: dict
    columns: list[CatalogProfilePreviewColumnRequest] = Field(default_factory=list)


class CatalogColumnQuickStats(BaseModel):
    name: str
    unique_count: float | None = None
    min: float | str | None = None
    max: float | str | None = None
    avg: float | None = None


class CatalogProfilePreviewResponse(BaseModel):
    items: list[CatalogColumnQuickStats] = Field(default_factory=list)


class CatalogDataPreviewRequest(BaseModel):
    datasource_id: int
    base_query_spec: dict
    columns: list[str] = Field(default_factory=list)
    limit: int = Field(default=15, ge=1, le=100)


class CatalogDataPreviewResponse(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[dict] = Field(default_factory=list)
    row_count: int = 0


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _load_datasource_or_404(db: Session, datasource_id: int) -> DataSource:
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if datasource is None:
        raise HTTPException(status_code=404, detail="Datasource not found")
    return datasource


def _load_dataset_or_404(db: Session, dataset_id: int) -> Dataset:
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset


def _ensure_datasource_access(*, datasource: DataSource, current_user: User) -> None:
    if current_user.is_admin:
        return
    if int(datasource.created_by_id) != int(current_user.id):
        raise HTTPException(status_code=403, detail="Not authorized to access this datasource")


def _load_metric_or_404(db: Session, metric_id: int) -> Metric:
    metric = db.query(Metric).filter(Metric.id == metric_id).first()
    if metric is None:
        raise HTTPException(status_code=404, detail="Metric not found")
    return metric


def _load_dimension_or_404(db: Session, dimension_id: int) -> Dimension:
    dimension = db.query(Dimension).filter(Dimension.id == dimension_id).first()
    if dimension is None:
        raise HTTPException(status_code=404, detail="Dimension not found")
    return dimension


def _sanitize_list(values: list[str] | None) -> list[str]:
    if not values:
        return []
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value or "").strip()
        if not normalized:
            continue
        lowered = normalized.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        deduped.append(normalized)
    return deduped


def _extract_single_metric_value(payload: dict) -> float | str | None:
    rows = payload.get("rows") or []
    if not isinstance(rows, list) or not rows:
        return None
    first_row = rows[0]
    if isinstance(first_row, dict):
        if len(first_row) == 1:
            return next(iter(first_row.values()))
        columns = payload.get("columns") or []
        if isinstance(columns, list) and columns:
            key = columns[0]
            if isinstance(key, str):
                return first_row.get(key)
        return None
    return None


def _resource_schema_name(resource_id: str | None) -> str | None:
    value = str(resource_id or "").strip()
    if "." not in value:
        return None
    schema, _ = value.split(".", 1)
    schema_name = schema.strip().strip('"')
    if not schema_name:
        return None
    return schema_name.lower()


def _base_query_spec_uses_workspace_internal_schema(
    *,
    base_query_spec: dict | None,
    workspace_id: int,
) -> bool:
    if not isinstance(base_query_spec, dict):
        return False
    expected_schema = f"lens_imp_t{int(workspace_id)}".lower()
    base = base_query_spec.get("base")
    if not isinstance(base, dict):
        return False

    primary_resource = base.get("primary_resource")
    if isinstance(primary_resource, str) and _resource_schema_name(primary_resource) == expected_schema:
        return True

    resources = base.get("resources")
    if not isinstance(resources, list):
        return False
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_id = item.get("resource_id")
        if isinstance(resource_id, str) and _resource_schema_name(resource_id) == expected_schema:
            return True
    return False


def _base_query_spec_is_mixed_internal_external(
    *,
    base_query_spec: dict | None,
    workspace_id: int,
) -> bool:
    if not isinstance(base_query_spec, dict):
        return False
    base = base_query_spec.get("base")
    if not isinstance(base, dict):
        return False
    resources = base.get("resources")
    if not isinstance(resources, list):
        return False
    internal_schema = f"lens_imp_t{int(workspace_id)}"
    has_internal = False
    has_external = False
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_id = str(item.get("resource_id") or "").strip()
        if "." not in resource_id:
            continue
        schema_name = resource_id.split(".", 1)[0].strip()
        if not schema_name:
            continue
        if schema_name == internal_schema:
            has_internal = True
        else:
            has_external = True
        if has_internal and has_external:
            return True
    return False


def _to_psycopg_url(url: str) -> str:
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


def _ensure_catalog_for_dataset(db: Session, *, dataset: Dataset) -> None:
    service = SemanticCatalogService(db)
    _, _, changed = service.ensure_dataset_catalog(dataset=dataset)
    if changed:
        db.commit()


def _sync_catalog_for_existing_datasets(db: Session) -> None:
    service = SemanticCatalogService(db)
    if service.sync_existing_datasets():
        db.commit()


def _build_dataset_detail_response(db: Session, *, dataset: Dataset) -> CatalogDatasetDetailResponse:
    service = SemanticCatalogService(db)
    metrics = service.list_metrics(dataset_id=int(dataset.id))
    dimensions = service.list_dimensions(dataset_id=int(dataset.id))
    return CatalogDatasetDetailResponse(
        id=int(dataset.id),
        datasource_id=int(dataset.datasource_id),
        view_id=int(dataset.view_id) if dataset.view_id is not None else None,
        name=dataset.name,
        description=dataset.description,
        metrics=[CatalogMetricResponse.model_validate(item) for item in metrics],
        dimensions=[CatalogDimensionResponse.model_validate(item) for item in dimensions],
    )


@router.get("/catalog/resources", response_model=CatalogResourcesResponse)
async def catalog_resources(
    request: Request,
    datasource_id: int = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _load_datasource_or_404(db, datasource_id)
    _ensure_datasource_access(datasource=datasource, current_user=current_user)
    access = resolve_datasource_access(datasource=datasource, dataset=None, current_user=current_user)
    payload = await get_engine_client().list_resources(
        datasource_id=access.datasource_id,
        workspace_id=access.workspace_id,
        dataset_id=None,
        datasource_url=access.datasource_url,
        actor_user_id=access.actor_user_id,
        correlation_id=_resolve_correlation_id(request),
    )
    return CatalogResourcesResponse(items=payload.get("items", []))


@router.get("/schema/{resource_id:path}", response_model=SchemaGetResponse)
async def schema_get(
    resource_id: str,
    request: Request,
    datasource_id: int = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _load_datasource_or_404(db, datasource_id)
    _ensure_datasource_access(datasource=datasource, current_user=current_user)
    access = resolve_datasource_access(datasource=datasource, dataset=None, current_user=current_user)
    payload = await get_engine_client().get_schema(
        datasource_id=access.datasource_id,
        workspace_id=access.workspace_id,
        dataset_id=None,
        resource_id=resource_id,
        datasource_url=access.datasource_url,
        actor_user_id=access.actor_user_id,
        correlation_id=_resolve_correlation_id(request),
    )
    return SchemaGetResponse(
        resource_id=payload.get("resource_id", resource_id),
        fields=payload.get("fields", []),
    )


@router.get("/catalog/datasets", response_model=list[CatalogDatasetSummary])
async def catalog_datasets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _sync_catalog_for_existing_datasets(db)
    service = SemanticCatalogService(db)
    datasets = (
        db.query(Dataset)
        .options(joinedload(Dataset.datasource), joinedload(Dataset.email_shares))
        .filter(Dataset.is_active == True)  # noqa: E712
        .order_by(Dataset.name.asc())
        .all()
    )
    if not can_view_organization_data(current_user):
        datasets = [item for item in datasets if can_view_dataset(dataset=item, user=current_user)]
    payload: list[CatalogDatasetSummary] = []
    for dataset in datasets:
        metrics = service.list_metrics(dataset_id=int(dataset.id))
        dimensions = service.list_dimensions(dataset_id=int(dataset.id))
        payload.append(
            CatalogDatasetSummary(
                id=int(dataset.id),
                datasource_id=int(dataset.datasource_id),
                view_id=int(dataset.view_id) if dataset.view_id is not None else None,
                name=dataset.name,
                description=dataset.description,
                metrics_count=len(metrics),
                dimensions_count=len(dimensions),
            )
        )
    return payload


@router.get("/catalog/dataset/{dataset_id}", response_model=CatalogDatasetDetailResponse)
async def catalog_dataset_detail(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = _load_dataset_or_404(db, dataset_id)
    ensure_dataset_view_access(dataset=dataset, user=current_user)
    _ensure_catalog_for_dataset(db, dataset=dataset)
    return _build_dataset_detail_response(db, dataset=dataset)


@router.post("/catalog/dataset/{dataset_id}/regenerate", response_model=CatalogDatasetDetailResponse)
async def catalog_regenerate_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = _load_dataset_or_404(db, dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    metric_rows = db.query(Metric).filter(Metric.dataset_id == dataset.id).all()
    dimension_rows = db.query(Dimension).filter(Dimension.dataset_id == dataset.id).all()
    metric_ids = [int(item.id) for item in metric_rows if item.id is not None]
    dimension_ids = [int(item.id) for item in dimension_rows if item.id is not None]

    if metric_ids:
        db.query(MetricDimension).filter(MetricDimension.metric_id.in_(metric_ids)).delete(
            synchronize_session=False
        )
    if dimension_ids:
        db.query(MetricDimension).filter(MetricDimension.dimension_id.in_(dimension_ids)).delete(
            synchronize_session=False
        )
    if metric_rows:
        db.query(Metric).filter(Metric.dataset_id == dataset.id).delete(synchronize_session=False)
    if dimension_rows:
        db.query(Dimension).filter(Dimension.dataset_id == dataset.id).delete(synchronize_session=False)
    db.flush()

    db.expunge_all()
    dataset = _load_dataset_or_404(db, dataset_id)
    SemanticCatalogService(db).ensure_dataset_catalog(dataset=dataset)
    db.commit()
    db.refresh(dataset)
    return _build_dataset_detail_response(db, dataset=dataset)


@router.get("/catalog/metrics", response_model=list[CatalogMetricResponse])
async def catalog_metrics(
    dataset: int = Query(..., alias="dataset"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_row = _load_dataset_or_404(db, dataset)
    ensure_dataset_view_access(dataset=dataset_row, user=current_user)
    _ensure_catalog_for_dataset(db, dataset=dataset_row)
    return [CatalogMetricResponse.model_validate(item) for item in SemanticCatalogService(db).list_metrics(dataset_id=dataset)]


@router.get("/catalog/dimensions", response_model=list[CatalogDimensionResponse])
async def catalog_dimensions(
    dataset: int = Query(..., alias="dataset"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_row = _load_dataset_or_404(db, dataset)
    ensure_dataset_view_access(dataset=dataset_row, user=current_user)
    _ensure_catalog_for_dataset(db, dataset=dataset_row)
    return [
        CatalogDimensionResponse.model_validate(item)
        for item in SemanticCatalogService(db).list_dimensions(dataset_id=dataset)
    ]


@router.post("/catalog/metrics", response_model=CatalogMetricResponse, status_code=201)
async def catalog_create_metric(
    request: CatalogMetricCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = _load_dataset_or_404(db, request.dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    service = SemanticCatalogService(db)
    metric = Metric(
        dataset_id=dataset.id,
        name=request.name.strip(),
        description=request.description.strip() if isinstance(request.description, str) else None,
        formula=request.formula.strip(),
        unit=request.unit.strip() if isinstance(request.unit, str) and request.unit.strip() else None,
        default_grain=request.default_grain.strip() if isinstance(request.default_grain, str) and request.default_grain.strip() else None,
        synonyms=_sanitize_list(request.synonyms),
        examples=_sanitize_list(request.examples),
    )
    service.validate_metric(metric)
    db.add(metric)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Metric with this name already exists for dataset") from exc

    dimensions = service.list_dimensions(dataset_id=int(dataset.id))
    if dimensions:
        db.add_all(
            [MetricDimension(metric_id=int(metric.id), dimension_id=int(dimension.id)) for dimension in dimensions]
        )
    db.commit()
    db.refresh(metric)
    return CatalogMetricResponse.model_validate(metric)


@router.patch("/catalog/metrics/{metric_id}", response_model=CatalogMetricResponse)
async def catalog_update_metric(
    metric_id: int,
    request: CatalogMetricUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    metric = _load_metric_or_404(db, metric_id)
    dataset = _load_dataset_or_404(db, int(metric.dataset_id))
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if request.name is not None:
        metric.name = request.name.strip()
    if request.description is not None:
        metric.description = request.description.strip() or None
    if request.formula is not None:
        metric.formula = request.formula.strip()
    if request.unit is not None:
        metric.unit = request.unit.strip() or None
    if request.default_grain is not None:
        metric.default_grain = request.default_grain.strip() or None
    if request.synonyms is not None:
        metric.synonyms = _sanitize_list(request.synonyms)
    if request.examples is not None:
        metric.examples = _sanitize_list(request.examples)

    SemanticCatalogService(db).validate_metric(metric)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Metric with this name already exists for dataset") from exc
    db.refresh(metric)
    return CatalogMetricResponse.model_validate(metric)


@router.delete("/catalog/metrics/{metric_id}", status_code=204)
async def catalog_delete_metric(
    metric_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    metric = _load_metric_or_404(db, metric_id)
    dataset = _load_dataset_or_404(db, int(metric.dataset_id))
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    db.delete(metric)
    db.commit()


@router.post("/catalog/dimensions", response_model=CatalogDimensionResponse, status_code=201)
async def catalog_create_dimension(
    request: CatalogDimensionCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = _load_dataset_or_404(db, request.dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    service = SemanticCatalogService(db)
    dimension = Dimension(
        dataset_id=dataset.id,
        name=request.name.strip(),
        description=request.description.strip() if isinstance(request.description, str) else None,
        type=request.type.strip().lower(),
        synonyms=_sanitize_list(request.synonyms),
    )
    service.validate_dimension(dimension)
    db.add(dimension)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Dimension with this name already exists for dataset") from exc

    metrics = service.list_metrics(dataset_id=int(dataset.id))
    if metrics:
        db.add_all(
            [MetricDimension(metric_id=int(metric.id), dimension_id=int(dimension.id)) for metric in metrics]
        )
    db.commit()
    db.refresh(dimension)
    return CatalogDimensionResponse.model_validate(dimension)


@router.patch("/catalog/dimensions/{dimension_id}", response_model=CatalogDimensionResponse)
async def catalog_update_dimension(
    dimension_id: int,
    request: CatalogDimensionUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dimension = _load_dimension_or_404(db, dimension_id)
    dataset = _load_dataset_or_404(db, int(dimension.dataset_id))
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if request.name is not None:
        dimension.name = request.name.strip()
    if request.description is not None:
        dimension.description = request.description.strip() or None
    if request.type is not None:
        dimension.type = request.type.strip().lower()
    if request.synonyms is not None:
        dimension.synonyms = _sanitize_list(request.synonyms)

    SemanticCatalogService(db).validate_dimension(dimension)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Dimension with this name already exists for dataset") from exc
    db.refresh(dimension)
    return CatalogDimensionResponse.model_validate(dimension)


@router.delete("/catalog/dimensions/{dimension_id}", status_code=204)
async def catalog_delete_dimension(
    dimension_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dimension = _load_dimension_or_404(db, dimension_id)
    dataset = _load_dataset_or_404(db, int(dimension.dataset_id))
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    db.delete(dimension)
    db.commit()


@router.post("/catalog/profile/preview", response_model=CatalogProfilePreviewResponse)
async def catalog_profile_preview(
    request: CatalogProfilePreviewRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _load_datasource_or_404(db, request.datasource_id)
    _ensure_datasource_access(datasource=datasource, current_user=current_user)
    access = resolve_datasource_access(datasource=datasource, dataset=None, current_user=current_user)
    allow_workspace_internal_resources = _base_query_spec_uses_workspace_internal_schema(
        base_query_spec=request.base_query_spec if isinstance(request.base_query_spec, dict) else None,
        workspace_id=int(datasource.created_by_id),
    )
    resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
        db=db,
        datasource_id=request.datasource_id,
        base_query_spec=request.base_query_spec,
        allow_workspace_internal_resources=allow_workspace_internal_resources,
        workspace_id=int(datasource.created_by_id),
    )
    semantic_type_by_name = {
        str(item.get("name")): str(item.get("type") or "text")
        for item in semantic_columns
        if isinstance(item, dict) and item.get("name")
    }

    profile_items: list[CatalogColumnQuickStats] = []
    correlation_id = _resolve_correlation_id(http_request)
    for column in request.columns:
        column_name = column.name.strip()
        if not column_name:
            continue
        semantic_type = (semantic_type_by_name.get(column_name) or column.type or "text").lower()

        unique_payload = await get_engine_client().execute_query(
            datasource_id=access.datasource_id,
            workspace_id=access.workspace_id,
            dataset_id=None,
            query_spec={
                "resource_id": "__dataset_base",
                "base_query": resolved_base_query_spec,
                "metrics": [{"field": column_name, "agg": "distinct_count"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 1,
                "offset": 0,
            },
            datasource_url=access.datasource_url,
            actor_user_id=access.actor_user_id,
            correlation_id=correlation_id,
        )
        unique_value = _extract_single_metric_value(unique_payload)

        min_value: float | str | None = None
        max_value: float | str | None = None
        avg_value: float | None = None

        if semantic_type == "numeric":
            min_payload = await get_engine_client().execute_query(
                datasource_id=access.datasource_id,
                workspace_id=access.workspace_id,
                dataset_id=None,
                query_spec={
                    "resource_id": "__dataset_base",
                    "base_query": resolved_base_query_spec,
                    "metrics": [{"field": column_name, "agg": "min"}],
                    "dimensions": [],
                    "filters": [],
                    "sort": [],
                    "limit": 1,
                    "offset": 0,
                },
                datasource_url=access.datasource_url,
                actor_user_id=access.actor_user_id,
                correlation_id=correlation_id,
            )
            max_payload = await get_engine_client().execute_query(
                datasource_id=access.datasource_id,
                workspace_id=access.workspace_id,
                dataset_id=None,
                query_spec={
                    "resource_id": "__dataset_base",
                    "base_query": resolved_base_query_spec,
                    "metrics": [{"field": column_name, "agg": "max"}],
                    "dimensions": [],
                    "filters": [],
                    "sort": [],
                    "limit": 1,
                    "offset": 0,
                },
                datasource_url=access.datasource_url,
                actor_user_id=access.actor_user_id,
                correlation_id=correlation_id,
            )
            avg_payload = await get_engine_client().execute_query(
                datasource_id=access.datasource_id,
                workspace_id=access.workspace_id,
                dataset_id=None,
                query_spec={
                    "resource_id": "__dataset_base",
                    "base_query": resolved_base_query_spec,
                    "metrics": [{"field": column_name, "agg": "avg"}],
                    "dimensions": [],
                    "filters": [],
                    "sort": [],
                    "limit": 1,
                    "offset": 0,
                },
                datasource_url=access.datasource_url,
                actor_user_id=access.actor_user_id,
                correlation_id=correlation_id,
            )
            min_value = _extract_single_metric_value(min_payload)
            max_value = _extract_single_metric_value(max_payload)
            avg_raw = _extract_single_metric_value(avg_payload)
            avg_value = float(avg_raw) if isinstance(avg_raw, (float, int)) else None

        unique_count = float(unique_value) if isinstance(unique_value, (float, int)) else None
        profile_items.append(
            CatalogColumnQuickStats(
                name=column_name,
                unique_count=unique_count,
                min=min_value,
                max=max_value,
                avg=avg_value,
            )
        )

    return CatalogProfilePreviewResponse(items=profile_items)


@router.post("/catalog/data/preview", response_model=CatalogDataPreviewResponse)
async def catalog_data_preview(
    request: CatalogDataPreviewRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _load_datasource_or_404(db, request.datasource_id)
    _ensure_datasource_access(datasource=datasource, current_user=current_user)
    access = resolve_datasource_access(datasource=datasource, dataset=None, current_user=current_user)
    allow_workspace_internal_resources = _base_query_spec_uses_workspace_internal_schema(
        base_query_spec=request.base_query_spec if isinstance(request.base_query_spec, dict) else None,
        workspace_id=int(datasource.created_by_id),
    )
    resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
        db=db,
        datasource_id=request.datasource_id,
        base_query_spec=request.base_query_spec,
        allow_workspace_internal_resources=allow_workspace_internal_resources,
        workspace_id=int(datasource.created_by_id),
    )

    available_dimension_names: list[str] = []
    seen_names: set[str] = set()
    for item in semantic_columns:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen_names:
            continue
        available_dimension_names.append(name)
        seen_names.add(name)

    requested_names = [str(name or "").strip() for name in request.columns]
    dimensions = [name for name in requested_names if name and name in seen_names]
    if not dimensions:
        dimensions = available_dimension_names

    if not dimensions:
        return CatalogDataPreviewResponse(columns=[], rows=[], row_count=0)

    mixed_internal_external_preview = _base_query_spec_is_mixed_internal_external(
        base_query_spec=resolved_base_query_spec if isinstance(resolved_base_query_spec, dict) else None,
        workspace_id=int(datasource.created_by_id),
    )
    if mixed_internal_external_preview:
        settings = get_settings()
        internal_url = (
            settings.analytics_db_url
            or settings.app_db_url
            or settings.database_url
        )
        if not internal_url:
            raise HTTPException(status_code=500, detail="Internal analytics datasource URL is not configured")

        target_schema = f"lens_imp_t{int(datasource.created_by_id)}"
        preview_load_table = f"preview_{uuid4().hex[:16]}"
        worker_service = DatasetSyncWorkerService(settings=settings)
        preview_dataset = Dataset(
            id=(int(uuid4().int % 1_000_000_000) + 1),
            name="preview_temp",
            base_query_spec=deepcopy(resolved_base_query_spec),
        )

        try:
            worker_service._materialize_base_query_spec_to_internal(
                dataset=preview_dataset,
                source_url=access.datasource_url,
                internal_url=internal_url,
                target_schema=target_schema,
                load_table_name=preview_load_table,
            )

            safe_internal_url = _to_psycopg_url(internal_url)
            with psycopg.connect(safe_internal_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql.SQL("SELECT COUNT(*) FROM {}.{}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(preview_load_table),
                        )
                    )
                    count_row = cur.fetchone()
                    row_count = int(count_row[0] or 0) if count_row else 0
                    cur.execute(
                        sql.SQL("SELECT * FROM {}.{} LIMIT {}").format(
                            sql.Identifier(target_schema),
                            sql.Identifier(preview_load_table),
                            sql.Literal(int(request.limit)),
                        )
                    )
                    rows_raw = cur.fetchall() or []
                    columns_raw = [str(desc[0]) for desc in (cur.description or [])]

            if dimensions:
                filtered_dimensions = [name for name in dimensions if name in columns_raw]
            else:
                filtered_dimensions = columns_raw
            if not filtered_dimensions:
                filtered_dimensions = columns_raw

            index_by_name = {name: idx for idx, name in enumerate(columns_raw)}
            filtered_indexes = [index_by_name[name] for name in filtered_dimensions if name in index_by_name]
            rows = [
                {filtered_dimensions[pos]: row[idx] for pos, idx in enumerate(filtered_indexes)}
                for row in rows_raw
            ]
            return CatalogDataPreviewResponse(columns=filtered_dimensions, rows=rows, row_count=row_count)
        finally:
            worker_service._drop_internal_tables(
                internal_url=internal_url,
                target_schema=target_schema,
                table_names=[preview_load_table],
            )

    query_spec = {
        "resource_id": "__dataset_base",
        "base_query": resolved_base_query_spec,
        "metrics": [],
        "dimensions": dimensions,
        "filters": [],
        "sort": [],
        "limit": request.limit,
        "offset": 0,
    }
    correlation_id = _resolve_correlation_id(http_request)

    try:
        payload = await get_engine_client().execute_query(
            datasource_id=access.datasource_id,
            workspace_id=access.workspace_id,
            dataset_id=None,
            query_spec=query_spec,
            datasource_url=access.datasource_url,
            actor_user_id=access.actor_user_id,
            correlation_id=correlation_id,
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        nested_error = detail.get("error") if isinstance(detail, dict) else None
        error_code = nested_error.get("code") if isinstance(nested_error, dict) else None
        should_retry = (
            exc.status_code >= 500
            and error_code == "datasource_error"
            and len(dimensions) > 1
        )
        if not should_retry:
            raise

        fallback_dimensions = [name for name in dimensions if _SAFE_ALIAS_PATTERN.match(name)]
        if not fallback_dimensions:
            fallback_dimensions = [name for name in available_dimension_names if _SAFE_ALIAS_PATTERN.match(name)]
        if not fallback_dimensions:
            raise

        payload = await get_engine_client().execute_query(
            datasource_id=access.datasource_id,
            workspace_id=access.workspace_id,
            dataset_id=None,
            query_spec={**query_spec, "dimensions": fallback_dimensions},
            datasource_url=access.datasource_url,
            actor_user_id=access.actor_user_id,
            correlation_id=correlation_id,
        )
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        rows = []
    columns = payload.get("columns") or dimensions
    if not isinstance(columns, list):
        columns = dimensions
    row_count = payload.get("row_count")
    resolved_row_count = int(row_count) if isinstance(row_count, (int, float)) else len(rows)
    return CatalogDataPreviewResponse(columns=columns, rows=rows, row_count=resolved_row_count)


@router.get("/catalog/search", response_model=CatalogSearchResponse)
async def catalog_search(
    term: str = Query(..., min_length=1),
    dataset: int | None = Query(default=None, alias="dataset"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    normalized = term.strip()
    if not normalized:
        return CatalogSearchResponse(items=[])

    if dataset is None:
        _sync_catalog_for_existing_datasets(db)
    else:
        dataset_row = (
            db.query(Dataset)
            .options(joinedload(Dataset.datasource), joinedload(Dataset.email_shares))
            .filter(Dataset.id == dataset)
            .first()
        )
        ensure_dataset_view_access(dataset=dataset_row, user=current_user)
        _ensure_catalog_for_dataset(db, dataset=dataset_row)

    term_like = f"%{normalized}%"
    dataset_scope_query = (
        db.query(Dataset)
        .options(joinedload(Dataset.datasource), joinedload(Dataset.email_shares))
        .filter(Dataset.is_active == True)  # noqa: E712
    )
    if dataset is not None:
        dataset_scope_query = dataset_scope_query.filter(Dataset.id == dataset)
    dataset_scope_rows = dataset_scope_query.all()
    if not can_view_organization_data(current_user):
        dataset_scope_rows = [item for item in dataset_scope_rows if can_view_dataset(dataset=item, user=current_user)]
    dataset_scope_ids = [int(item.id) for item in dataset_scope_rows]
    if not dataset_scope_ids:
        return CatalogSearchResponse(items=[])

    hits: list[CatalogSearchHit] = []

    dataset_rows = (
        db.query(Dataset)
        .filter(
            Dataset.id.in_(dataset_scope_ids),
            or_(
                Dataset.name.ilike(term_like),
                Dataset.description.ilike(term_like),
            ),
        )
        .order_by(Dataset.name.asc())
        .limit(20)
        .all()
    )
    for row in dataset_rows:
        hits.append(
            CatalogSearchHit(
                kind="dataset",
                dataset_id=int(row.id),
                dataset_name=row.name,
                id=int(row.id),
                name=row.name,
                description=row.description,
            )
        )

    metric_rows = (
        db.query(Metric, Dataset)
        .join(Dataset, Metric.dataset_id == Dataset.id)
        .filter(
            Dataset.id.in_(dataset_scope_ids),
            or_(
                Metric.name.ilike(term_like),
                Metric.description.ilike(term_like),
                Metric.formula.ilike(term_like),
            ),
        )
        .order_by(Dataset.name.asc(), Metric.name.asc())
        .limit(40)
        .all()
    )
    for metric, owner_dataset in metric_rows:
        hits.append(
            CatalogSearchHit(
                kind="metric",
                dataset_id=int(owner_dataset.id),
                dataset_name=owner_dataset.name,
                id=int(metric.id),
                name=metric.name,
                description=metric.description,
            )
        )

    dimension_rows = (
        db.query(Dimension, Dataset)
        .join(Dataset, Dimension.dataset_id == Dataset.id)
        .filter(
            Dataset.id.in_(dataset_scope_ids),
            or_(
                Dimension.name.ilike(term_like),
                Dimension.description.ilike(term_like),
            ),
        )
        .order_by(Dataset.name.asc(), Dimension.name.asc())
        .limit(40)
        .all()
    )
    for dimension, owner_dataset in dimension_rows:
        hits.append(
            CatalogSearchHit(
                kind="dimension",
                dataset_id=int(owner_dataset.id),
                dataset_name=owner_dataset.name,
                id=int(dimension.id),
                name=dimension.name,
                description=dimension.description,
            )
        )

    return CatalogSearchResponse(items=hits)
