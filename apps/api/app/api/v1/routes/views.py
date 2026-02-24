from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, View, ViewColumn, Analysis
from app.modules.core.legacy.schemas import ViewResponse, ViewCreateRequest, ViewUpdateRequest
from app.modules.auth.adapters.api.dependencies import get_current_admin_user, get_current_user
from app.shared.infrastructure.settings import get_settings
from app.modules.engine.client import get_engine_client
from app.modules.engine.access import resolve_datasource_access

router = APIRouter(prefix="/admin/views", tags=["admin"])
settings = get_settings()


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


@router.post("", response_model=ViewResponse)
async def create_view(
    request: ViewCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user)
):
    """Register a new view/dataset"""
    view = View(
        schema_name=request.schema_name,
        view_name=request.view_name,
        description=request.description
    )
    
    db.add(view)
    db.commit()
    db.refresh(view)
    
    return view


@router.post("/{view_id}/sync", response_model=ViewResponse)
async def sync_view_metadata(
    view_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user)
):
    """Sync view metadata from analytics database"""
    view = db.query(View).filter(View.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    
    # Get columns from engine
    try:
        payload = await get_engine_client().get_schema(
            datasource_id=int(view.datasource_id),
            workspace_id=int(view.datasource.created_by_id),
            resource_id=f"{view.schema_name}.{view.view_name}",
            datasource_url=resolve_datasource_access(
                datasource=view.datasource,
                dataset=None,
                current_user=current_user,
            ).datasource_url,
            actor_user_id=current_user.id,
            correlation_id=_resolve_correlation_id(request),
        )
        columns = payload.get("fields", [])
        
        if not columns:
            raise HTTPException(
                status_code=400,
                detail=f"View {view.schema_name}.{view.view_name} not found in analytics database"
            )
        
        # Clear existing columns
        db.query(ViewColumn).filter(ViewColumn.view_id == view_id).delete()
        
        # Add new columns
        for item in columns:
            col_name = str(item["name"])
            col_type = str(item["data_type"])
            # Determine column properties based on type
            is_numeric = col_type in ['integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision']
            is_temporal = col_type in ['date', 'timestamp', 'timestamp with time zone']
            is_text = col_type in ['text', 'varchar', 'character']
            
            column = ViewColumn(
                view_id=view_id,
                column_name=col_name,
                column_type=col_type,
                is_aggregatable=is_numeric,
                is_filterable=True,
                is_groupable=is_text or is_temporal or col_type == 'boolean'
            )
            db.add(column)
        
        db.commit()
        db.refresh(view)
        
        return ViewResponse.model_validate(view)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sync metadata: {str(e)}")


@router.get("", response_model=List[ViewResponse])
async def list_views(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List all registered views available to authenticated users."""
    views = db.query(View).all()
    return views


@router.patch("/{view_id}", response_model=ViewResponse)
async def update_view(
    view_id: int,
    request: ViewUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user)
):
    """Update view metadata"""
    view = db.query(View).filter(View.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    
    if request.description is not None:
        view.description = request.description
    if request.is_active is not None:
        view.is_active = request.is_active
    
    db.commit()
    db.refresh(view)
    
    return view


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(
    view_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    """Delete a view only when inactive and not used by analyses."""
    view = db.query(View).filter(View.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    if view.is_active:
        raise HTTPException(
            status_code=400,
            detail="View must be deactivated before deletion",
        )

    usage_count = db.query(func.count(Analysis.id)).filter(
        Analysis.dataset_id == view_id
    ).scalar()
    if usage_count and usage_count > 0:
        raise HTTPException(
            status_code=409,
            detail="View cannot be deleted because it is used in analyses",
        )

    db.delete(view)
    db.commit()


