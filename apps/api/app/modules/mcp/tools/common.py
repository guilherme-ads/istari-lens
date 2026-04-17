from __future__ import annotations

from typing import Any

from app.modules.mcp.schemas import MCPToolExecutionOutput, MCPToolValidationError


def ok(
    *,
    data: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    validation_errors: list[MCPToolValidationError] | None = None,
    suggestions: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> MCPToolExecutionOutput:
    return MCPToolExecutionOutput(
        success=True,
        data=data or {},
        warnings=warnings or [],
        validation_errors=validation_errors or [],
        suggestions=suggestions or [],
        metadata=metadata or {},
    )


def fail(
    *,
    error: str,
    data: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    validation_errors: list[MCPToolValidationError] | None = None,
    suggestions: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> MCPToolExecutionOutput:
    return MCPToolExecutionOutput(
        success=False,
        error=error,
        data=data or {},
        warnings=warnings or [],
        validation_errors=validation_errors or [],
        suggestions=suggestions or [],
        metadata=metadata or {},
    )
