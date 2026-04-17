from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.modules.core.legacy.models import User
from app.modules.mcp.schemas import MCPToolCategory, MCPToolHistoryEntry

if TYPE_CHECKING:
    from typing import Any


@dataclass
class MCPToolRuntimeContext:
    db: Session
    current_user: User
    trace_id: str
    tool_name: str
    category: MCPToolCategory
    started_at: datetime
    call_history: MCPToolHistoryEntry | None = None
