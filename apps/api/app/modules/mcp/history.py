from __future__ import annotations

from collections import deque
from datetime import datetime
from threading import Lock
from typing import Any
from uuid import uuid4

from app.modules.mcp.schemas import MCPToolCategory, MCPToolHistoryEntry


class MCPToolHistoryStore:
    def __init__(self, *, max_entries: int = 1000) -> None:
        self._max_entries = max(100, int(max_entries))
        self._lock = Lock()
        self._entries: deque[MCPToolHistoryEntry] = deque(maxlen=self._max_entries)

    def start(
        self,
        *,
        trace_id: str,
        tool: str,
        category: MCPToolCategory,
        input_arguments: dict[str, Any],
        dataset_id: int | None = None,
    ) -> MCPToolHistoryEntry:
        entry = MCPToolHistoryEntry(
            call_id=uuid4().hex,
            trace_id=trace_id,
            tool=tool,
            category=category,
            dataset_id=dataset_id,
            started_at=datetime.utcnow(),
            input_arguments=input_arguments,
        )
        with self._lock:
            self._entries.append(entry)
        return entry

    def finish(
        self,
        entry: MCPToolHistoryEntry,
        *,
        success: bool,
        error: str | None = None,
        output_summary: dict[str, Any] | None = None,
    ) -> MCPToolHistoryEntry:
        now = datetime.utcnow()
        entry.finished_at = now
        entry.duration_ms = max(0, int((now - entry.started_at).total_seconds() * 1000))
        entry.success = bool(success)
        entry.error = error
        if isinstance(output_summary, dict):
            entry.output_summary = output_summary
        return entry

    def recent(self, *, limit: int = 50, trace_id: str | None = None) -> list[MCPToolHistoryEntry]:
        size = max(1, min(500, int(limit)))
        with self._lock:
            items = list(self._entries)
        if trace_id:
            items = [item for item in items if item.trace_id == trace_id]
        return items[-size:]


tool_history_store = MCPToolHistoryStore()
