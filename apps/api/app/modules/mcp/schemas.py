from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


MCPToolCategory = Literal["context", "analysis", "builder", "validation"]


class MCPToolValidationError(BaseModel):
    code: str
    field: str | None = None
    message: str


class MCPToolExecutionOutput(BaseModel):
    success: bool = True
    data: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    validation_errors: list[MCPToolValidationError] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class MCPToolDefinition(BaseModel):
    name: str
    category: MCPToolCategory
    description: str
    input_schema: dict[str, Any]
    output_contract: dict[str, Any]


class MCPToolListResponse(BaseModel):
    tools: list[MCPToolDefinition] = Field(default_factory=list)
    recommended_agent_flow: list[str] = Field(default_factory=list)
    execution_plan_template: dict[str, Any] = Field(default_factory=dict)


class MCPToolCallRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    trace_id: str | None = None


class MCPToolCallResponse(BaseModel):
    tool: str
    category: MCPToolCategory
    trace_id: str
    executed_at: datetime
    output: MCPToolExecutionOutput


class MCPToolPlanStep(BaseModel):
    step_id: str
    tool: str
    category: MCPToolCategory
    goal: str
    required: bool = True
    status: Literal["pending", "in_progress", "completed", "failed"] = "pending"


class MCPDatasetExecutionPlan(BaseModel):
    dataset_id: int
    user_question: str
    steps: list[MCPToolPlanStep] = Field(default_factory=list)
    created_at: datetime


class MCPToolHistoryEntry(BaseModel):
    call_id: str
    trace_id: str
    tool: str
    category: MCPToolCategory
    dataset_id: int | None = None
    started_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None
    success: bool | None = None
    error: str | None = None
    input_arguments: dict[str, Any] = Field(default_factory=dict)
    output_summary: dict[str, Any] = Field(default_factory=dict)
