from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from app.database import get_db, get_analytics_connection
from app.models import User, View, ViewColumn, Analysis
from app.schemas import ViewResponse, ViewCreateRequest, ViewUpdateRequest
from app.dependencies import get_current_admin_user
from app.settings import get_settings
from app.external_query_logging import log_external_query

router = APIRouter(prefix="/admin/views", tags=["admin"])
settings = get_settings()


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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user)
):
    """Sync view metadata from analytics database"""
    view = db.query(View).filter(View.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    
    # Get columns from analytics DB
    try:
        conn = await get_analytics_connection()
        # Query information_schema to get columns
        query = """
        SELECT 
            column_name,
            data_type,
            is_nullable
        FROM information_schema.columns
        WHERE table_schema = %s 
            AND table_name = %s
        ORDER BY ordinal_position
        """
        log_external_query(
            sql=query,
            params=(view.schema_name, view.view_name),
            context=f"view_metadata_sync:view:{view_id}",
            datasource_id=view.datasource_id,
        )
        
        result = await conn.execute(query, (view.schema_name, view.view_name))
        columns = await result.fetchall()
        await conn.close()
        
        if not columns:
            raise HTTPException(
                status_code=400,
                detail=f"View {view.schema_name}.{view.view_name} not found in analytics database"
            )
        
        # Clear existing columns
        db.query(ViewColumn).filter(ViewColumn.view_id == view_id).delete()
        
        # Add new columns
        for col_name, col_type, is_nullable in columns:
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
    current_user: User = Depends(get_current_admin_user)
):
    """List all registered views"""
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
