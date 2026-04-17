from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.bi_agent.bi_agent_orchestrator import BIAgentOrchestrator
from app.modules.bi_agent.schemas import BiAgentRunRequest, BiAgentRunResponse
from app.modules.core.legacy.models import User
from app.shared.infrastructure.database import get_db

router = APIRouter(prefix="/bi-agent", tags=["bi-agent"])
_orchestrator = BIAgentOrchestrator()


@router.post("/run", response_model=BiAgentRunResponse)
async def run_bi_agent(
    request: BiAgentRunRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _orchestrator.run(
        request=request,
        db=db,
        current_user=current_user,
    )

