from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import User
from app.modules.mcp.schemas import MCPToolCallRequest, MCPToolCallResponse, MCPToolListResponse
from app.modules.mcp.tool_registry import tool_registry
from app.shared.infrastructure.database import get_db

router = APIRouter(prefix="/mcp", tags=["mcp"])


@router.get("/tools", response_model=MCPToolListResponse)
async def list_mcp_tools(
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    return tool_registry.list_catalog()


@router.post("/tools/{tool_name}", response_model=MCPToolCallResponse)
async def call_mcp_tool(
    tool_name: str,
    request: MCPToolCallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await tool_registry.execute(
        tool_name=tool_name,
        raw_arguments=request.arguments,
        db=db,
        current_user=current_user,
        trace_id=request.trace_id,
    )

