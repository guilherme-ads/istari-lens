from __future__ import annotations

import uuid

class EngineError(Exception):
    def __init__(self, *, status_code: int, code: str, message: str, error_id: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.error_id = error_id or str(uuid.uuid4())
