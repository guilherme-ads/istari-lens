from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import DataSource, User
from app.modules.engine import get_engine_client, resolve_datasource_access
from app.shared.infrastructure.database import get_db

router = APIRouter(tags=["catalog"])


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


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _load_datasource_or_404(db: Session, datasource_id: int) -> DataSource:
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if datasource is None:
        raise HTTPException(status_code=404, detail="Datasource not found")
    return datasource


@router.get("/catalog/resources", response_model=CatalogResourcesResponse)
async def catalog_resources(
    request: Request,
    datasource_id: int = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _load_datasource_or_404(db, datasource_id)
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
