from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional
import secrets

from app.database import get_db, get_analytics_connection
from app.models import User, Analysis, Share
from app.schemas import ShareCreateRequest, ShareResponse, SharedAnalysisResponse, QueryPreviewResponse
from app.dependencies import get_current_user
from app.external_query_logging import log_external_query

router = APIRouter(prefix="/analyses", tags=["shares"])


@router.post("/{analysis_id}/share", response_model=ShareResponse)
async def create_share(
    analysis_id: int,
    request: ShareCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a read-only share link for analysis"""
    analysis = db.query(Analysis).filter(
        Analysis.id == analysis_id,
        Analysis.owner_id == current_user.id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    
    # Check if share already exists
    existing_share = db.query(Share).filter(Share.analysis_id == analysis_id).first()
    if existing_share:
        return existing_share
    
    # Generate unique token
    token = secrets.token_urlsafe(32)
    
    share = Share(
        analysis_id=analysis_id,
        created_by_id=current_user.id,
        token=token
    )
    
    db.add(share)
    db.commit()
    db.refresh(share)
    
    return share


# Public endpoint to access shared analysis
@router.get("/shared/{token}", response_model=SharedAnalysisResponse)
async def get_shared_analysis(
    token: str,
    db: Session = Depends(get_db)
):
    """Get shared analysis (read-only)"""
    share = db.query(Share).filter(Share.token == token, Share.is_active == True).first()
    
    if not share:
        raise HTTPException(status_code=404, detail="Share not found or expired")
    
    analysis = share.analysis
    
    # Execute query to get data
    try:
        conn = await get_analytics_connection()
        
        # Reconstruct query spec from saved config
        from app.schemas import QuerySpec
        from app.routers.queries import build_query_sql
        
        spec_dict = analysis.query_config
        spec = QuerySpec(**spec_dict)
        
        # Get view
        view = analysis.dataset
        
        query_sql, params = build_query_sql(spec, view)
        log_external_query(
            sql=query_sql,
            params=params,
            context=f"shared_analysis:{analysis.id}",
            datasource_id=view.datasource_id if view else None,
        )
        
        result = await conn.execute(query_sql, params)
        rows = await result.fetchall()
        columns = [desc[0] for desc in result.description]
        
        await conn.close()
        
        # Convert rows to dicts
        row_dicts = []
        for row in rows:
            row_dict = {}
            for i, col in enumerate(columns):
                row_dict[col] = row[i]
            row_dicts.append(row_dict)
        
        data = QueryPreviewResponse(
            columns=columns,
            rows=row_dicts,
            row_count=len(row_dicts)
        )
        
        return SharedAnalysisResponse(
            analysis=analysis,
            data=data
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load shared analysis: {str(e)}")
