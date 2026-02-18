from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
import secrets

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Analysis, Share
from app.modules.core.legacy.schemas import ShareCreateRequest, ShareResponse, SharedAnalysisResponse, QueryPreviewResponse
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.engine import get_engine_client, resolve_datasource_access, to_engine_query_spec

router = APIRouter(prefix="/analyses", tags=["shares"])


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


@router.post("/{analysis_id}/share", response_model=ShareResponse)
async def create_share(
    analysis_id: int,
    request: ShareCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a read-only share link for analysis"""
    _ = request
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
    request: Request,
    db: Session = Depends(get_db)
):
    """Get shared analysis (read-only)"""
    share = db.query(Share).filter(Share.token == token, Share.is_active == True).first()
    
    if not share:
        raise HTTPException(status_code=404, detail="Share not found or expired")
    
    analysis = share.analysis
    
    # Execute query via engine
    try:
        from app.modules.core.legacy.schemas import QuerySpec

        spec = QuerySpec(**analysis.query_config)
        view = analysis.dataset
        if view is None:
            raise HTTPException(status_code=400, detail="Analysis dataset view not found")
        access = resolve_datasource_access(
            datasource=analysis.datasource,
            dataset=None,
            current_user=None,
        )

        payload = await get_engine_client().execute_query(
            datasource_id=access.datasource_id,
            workspace_id=access.workspace_id,
            dataset_id=None,
            query_spec=to_engine_query_spec(spec, view=view),
            datasource_url=access.datasource_url,
            actor_user_id=analysis.owner_id,
            correlation_id=_resolve_correlation_id(request),
        )
        data = QueryPreviewResponse(
            columns=payload.get("columns", []),
            rows=payload.get("rows", []),
            row_count=int(payload.get("row_count", 0)),
        )
        return SharedAnalysisResponse(analysis=analysis, data=data)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load shared analysis: {str(e)}")


