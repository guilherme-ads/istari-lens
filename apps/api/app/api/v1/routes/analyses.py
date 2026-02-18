from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User, Analysis, View
from app.modules.core.legacy.schemas import AnalysisCreateRequest, AnalysisResponse, AnalysisUpdateRequest
from app.modules.auth.adapters.api.dependencies import get_current_user

router = APIRouter(prefix="/analyses", tags=["analyses"])


@router.post("", response_model=AnalysisResponse)
async def create_analysis(
    request: AnalysisCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Create a new analysis"""
    view = db.query(View).filter(View.id == request.dataset_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found for analysis")

    analysis = Analysis(
        owner_id=current_user.id,
        dataset_id=request.dataset_id,
        datasource_id=request.datasource_id or view.datasource_id,
        name=request.name,
        description=request.description,
        query_config=request.query_config.model_dump(),
        visualization_config=request.visualization_config.model_dump() if request.visualization_config else None
    )
    
    db.add(analysis)
    db.commit()
    db.refresh(analysis)
    
    return analysis


@router.get("", response_model=List[AnalysisResponse])
async def list_analyses(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List user's analyses"""
    analyses = db.query(Analysis).filter(Analysis.owner_id == current_user.id).all()
    return analyses


@router.get("/{analysis_id}", response_model=AnalysisResponse)
async def get_analysis(
    analysis_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get analysis by ID"""
    analysis = db.query(Analysis).filter(
        Analysis.id == analysis_id,
        Analysis.owner_id == current_user.id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    
    return analysis


@router.patch("/{analysis_id}", response_model=AnalysisResponse)
async def update_analysis(
    analysis_id: int,
    request: AnalysisUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update analysis"""
    analysis = db.query(Analysis).filter(
        Analysis.id == analysis_id,
        Analysis.owner_id == current_user.id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    
    if request.name is not None:
        analysis.name = request.name
    if request.description is not None:
        analysis.description = request.description
    if request.query_config is not None:
        analysis.query_config = request.query_config.model_dump()
    if request.visualization_config is not None:
        analysis.visualization_config = request.visualization_config.model_dump()
    
    db.commit()
    db.refresh(analysis)
    
    return analysis


@router.delete("/{analysis_id}")
async def delete_analysis(
    analysis_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Delete analysis"""
    analysis = db.query(Analysis).filter(
        Analysis.id == analysis_id,
        Analysis.owner_id == current_user.id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    
    db.delete(analysis)
    db.commit()
    
    return {"message": "Analysis deleted"}


