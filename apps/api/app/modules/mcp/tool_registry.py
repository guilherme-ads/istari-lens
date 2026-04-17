from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import User
from app.modules.mcp.history import tool_history_store
from app.modules.mcp.plans import build_default_dataset_execution_plan
from app.modules.mcp.runtime import MCPToolRuntimeContext
from app.modules.mcp.schemas import (
    MCPToolCallResponse,
    MCPToolCategory,
    MCPToolDefinition,
    MCPToolExecutionOutput,
    MCPToolHistoryEntry,
    MCPToolListResponse,
    MCPToolValidationError,
)
from app.modules.mcp.tools.analysis_tools import ANALYSIS_TOOL_SPECS
from app.modules.mcp.tools.builder_tools import BUILDER_TOOL_SPECS
from app.modules.mcp.tools.context_tools import CONTEXT_TOOL_SPECS
from app.modules.mcp.tools.validation_tools import VALIDATION_TOOL_SPECS

ToolHandler = Callable[[Any, "MCPToolRuntimeContext"], Awaitable[MCPToolExecutionOutput]]


@dataclass(frozen=True)
class MCPToolSpec:
    name: str
    category: MCPToolCategory
    description: str
    input_model: type[BaseModel]
    handler: ToolHandler
    output_contract: dict[str, Any]


class MCPToolRegistry:
    def __init__(self, specs: list[MCPToolSpec]) -> None:
        by_name: dict[str, MCPToolSpec] = {}
        for item in specs:
            by_name[item.name] = item
        self._by_name = by_name
        self._ordered = list(specs)

    def get(self, tool_name: str) -> MCPToolSpec | None:
        return self._by_name.get(tool_name)

    def list_catalog(self) -> MCPToolListResponse:
        plan_template = build_default_dataset_execution_plan(dataset_id=1, user_question="Pergunta de negocio").model_dump(mode="json")
        return MCPToolListResponse(
            tools=[
                MCPToolDefinition(
                    name=item.name,
                    category=item.category,
                    description=item.description,
                    input_schema=item.input_model.model_json_schema(),
                    output_contract=item.output_contract,
                )
                for item in self._ordered
            ],
            recommended_agent_flow=[
                "Receber pergunta e dataset_id.",
                "Ler semantica/schema/catalogo do dataset.",
                "Validar inputs analiticos.",
                "Executar analises iterativas (run_query/profile).",
                "Se necessario, montar draft de dashboard via tools builder.",
                "Validar draft e retornar/aplicar resultado.",
            ],
            execution_plan_template=plan_template,
        )

    async def execute(
        self,
        *,
        tool_name: str,
        raw_arguments: dict[str, Any],
        db: Session,
        current_user: User,
        trace_id: str | None = None,
    ) -> MCPToolCallResponse:
        spec = self._by_name.get(tool_name)
        if spec is None:
            raise HTTPException(status_code=404, detail=f"MCP tool not found: {tool_name}")
        resolved_trace_id = trace_id.strip() if isinstance(trace_id, str) and trace_id.strip() else uuid4().hex

        dataset_id_raw = raw_arguments.get("dataset_id")
        dataset_id = int(dataset_id_raw) if isinstance(dataset_id_raw, int) else None
        history = tool_history_store.start(
            trace_id=resolved_trace_id,
            tool=spec.name,
            category=spec.category,
            input_arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
            dataset_id=dataset_id,
        )
        runtime_context = MCPToolRuntimeContext(
            db=db,
            current_user=current_user,
            trace_id=resolved_trace_id,
            tool_name=spec.name,
            category=spec.category,
            started_at=history.started_at,
            call_history=history,
        )

        output: MCPToolExecutionOutput
        try:
            parsed_args = spec.input_model.model_validate(raw_arguments or {})
        except ValidationError as exc:
            output = MCPToolExecutionOutput(
                success=False,
                error="Tool input validation failed",
                validation_errors=[
                    MCPToolValidationError(
                        code="invalid_input",
                        field=".".join(str(part) for part in error.get("loc", [])) or None,
                        message=error.get("msg", "Invalid input"),
                    )
                    for error in exc.errors()
                ],
                metadata={"trace_id": resolved_trace_id, "tool": spec.name},
            )
            tool_history_store.finish(
                history,
                success=False,
                error=output.error,
                output_summary={"validation_errors": len(output.validation_errors)},
            )
            return MCPToolCallResponse(
                tool=spec.name,
                category=spec.category,
                trace_id=resolved_trace_id,
                executed_at=datetime.utcnow(),
                output=output,
            )

        try:
            output = await spec.handler(parsed_args, runtime_context)
        except HTTPException as exc:
            output = MCPToolExecutionOutput(
                success=False,
                error=str(exc.detail),
                metadata={
                    "trace_id": resolved_trace_id,
                    "tool": spec.name,
                    "http_status": int(exc.status_code),
                },
            )
        except Exception as exc:
            output = MCPToolExecutionOutput(
                success=False,
                error="Unhandled MCP tool execution error",
                warnings=[str(exc)],
                metadata={"trace_id": resolved_trace_id, "tool": spec.name},
            )

        summary: dict[str, Any] = {
            "success": output.success,
            "warnings": len(output.warnings),
            "validation_errors": len(output.validation_errors),
            "data_keys": sorted(output.data.keys())[:20] if isinstance(output.data, dict) else [],
        }
        finished = tool_history_store.finish(
            history,
            success=output.success,
            error=output.error,
            output_summary=summary,
        )
        output.metadata = {
            **(output.metadata or {}),
            "trace_id": resolved_trace_id,
            "tool": spec.name,
            "category": spec.category,
            "call_id": finished.call_id,
            "duration_ms": finished.duration_ms,
        }
        return MCPToolCallResponse(
            tool=spec.name,
            category=spec.category,
            trace_id=resolved_trace_id,
            executed_at=datetime.utcnow(),
            output=output,
        )


def _output_contract_template() -> dict[str, Any]:
    return MCPToolExecutionOutput.model_json_schema()


def _all_specs() -> list[MCPToolSpec]:
    output_contract = _output_contract_template()
    specs = []
    for item in CONTEXT_TOOL_SPECS + ANALYSIS_TOOL_SPECS + BUILDER_TOOL_SPECS + VALIDATION_TOOL_SPECS:
        specs.append(
            MCPToolSpec(
                name=item["name"],
                category=item["category"],
                description=item["description"],
                input_model=item["input_model"],
                handler=item["handler"],
                output_contract=output_contract,
            )
        )
    return specs


tool_registry = MCPToolRegistry(_all_specs())
