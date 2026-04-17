from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.modules.bi_agent.agent.planner import BIExecutionPlan, PlannedToolStep
from app.modules.bi_agent.schemas import (
    BiAgentEvidenceItem,
    BiAgentQueryEvidence,
    BiAgentToolCallItem,
    BiQueryCandidate,
    BiQuestionAnalysis,
)
from app.modules.core.legacy.models import User
from app.modules.mcp.schemas import MCPToolCallResponse, MCPToolValidationError
from app.modules.mcp.tool_registry import tool_registry


@dataclass
class BIExecutorState:
    trace_id: str
    dataset_id: int
    question: str
    intent: str
    mode: str
    dry_run: bool
    apply_changes: bool
    dashboard_id: int | None = None
    question_analysis: BiQuestionAnalysis | None = None
    query_candidates: list[BiQueryCandidate] = field(default_factory=list)
    tool_calls: list[BiAgentToolCallItem] = field(default_factory=list)
    evidence: list[BiAgentEvidenceItem] = field(default_factory=list)
    queries_executed: list[BiAgentQueryEvidence] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    validation_errors: list[MCPToolValidationError] = field(default_factory=list)
    context_semantic: dict[str, Any] | None = None
    context_schema: dict[str, Any] | None = None
    context_catalog: dict[str, Any] | None = None
    dashboard_plan: dict[str, Any] | None = None
    dashboard_plan_evidence: dict[str, Any] | None = None
    visualization_suggestions: list[dict[str, Any]] = field(default_factory=list)
    dashboard_draft_snapshot: dict[str, Any] | None = None
    last_query_data: dict[str, Any] | None = None
    candidate_result_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    halted: bool = False
    halt_reason: str | None = None

    def candidate_by_id(self, candidate_id: str) -> BiQueryCandidate | None:
        for item in self.query_candidates:
            if item.candidate_id == candidate_id:
                return item
        return None


class BIPlanExecutor:
    def __init__(self, *, max_steps: int, max_retries: int) -> None:
        self.max_steps = int(max_steps)
        self.max_retries = int(max_retries)

    async def execute(
        self,
        *,
        plan: BIExecutionPlan,
        state: BIExecutorState,
        db: Session,
        current_user: User,
    ) -> BIExecutorState:
        useful_progress = 0
        executed_query_candidates: set[str] = set()
        for index, step in enumerate(plan.steps):
            if index >= self.max_steps:
                state.halted = True
                state.halt_reason = "max_steps_reached"
                state.warnings.append("Agent stopped because max_steps was reached.")
                break
            if state.halted:
                break

            if step.mutable and state.dry_run:
                self._record_skipped_step(state=state, step=step, reason="dry_run")
                continue
            if step.tool_name == "lens.create_dashboard_draft" and state.dashboard_id is not None:
                self._record_skipped_step(state=state, step=step, reason="dashboard_id_already_provided")
                continue

            resolved_args, resolve_errors = self._resolve_arguments(step=step, state=state)
            if resolve_errors:
                state.validation_errors.extend(resolve_errors)
                if step.required:
                    state.halted = True
                    state.halt_reason = f"argument_resolution_failed:{step.step_id}"
                continue

            max_attempts = min(self.max_retries, int(step.max_retries)) + 1
            attempt = 1
            while attempt <= max_attempts:
                response = await tool_registry.execute(
                    tool_name=step.tool_name,
                    raw_arguments=resolved_args,
                    db=db,
                    current_user=current_user,
                    trace_id=state.trace_id,
                )
                self._record_call(state=state, step=step, response=response, attempt=attempt)
                self._ingest_output(state=state, step=step, response=response)

                if response.output.success:
                    if step.tool_name == "lens.run_query":
                        candidate_id = str(step.arguments.get("candidate_id") or "")
                        if candidate_id:
                            executed_query_candidates.add(candidate_id)
                        query_row_count = int((response.output.data or {}).get("row_count", 0))
                        if query_row_count > 0:
                            useful_progress += 1
                    else:
                        useful_progress += 1
                    break

                if attempt >= max_attempts:
                    if step.required:
                        state.halted = True
                        state.halt_reason = response.output.error or f"step_failed:{step.step_id}"
                    break
                if not self._is_recoverable_failure(step=step, response=response):
                    if step.required:
                        state.halted = True
                        state.halt_reason = response.output.error or f"step_failed:{step.step_id}"
                    break

                fallback = self._fallback_arguments(step=step, state=state, current_args=resolved_args)
                if fallback is None:
                    if step.required:
                        state.halted = True
                        state.halt_reason = response.output.error or f"step_failed:{step.step_id}"
                    break
                resolved_args = fallback
                attempt += 1

            if step.tool_name == "lens.run_query" and useful_progress == 0 and len(executed_query_candidates) >= 3:
                state.warnings.append("No useful progress after multiple query candidates.")
                if state.intent in {"kpi_summary", "exploratory_analysis", "diagnostic_analysis"}:
                    state.halted = True
                    state.halt_reason = "insufficient_progress"
                    break

        return state

    def _record_skipped_step(self, *, state: BIExecutorState, step: PlannedToolStep, reason: str) -> None:
        spec = tool_registry.get(step.tool_name)
        category = spec.category if spec is not None else "context"
        state.tool_calls.append(
            BiAgentToolCallItem(
                step_id=step.step_id,
                tool=step.tool_name,
                category=category,
                success=True,
                skipped=True,
                error=None,
                warnings=[f"Skipped: {reason}"],
                validation_errors_count=0,
                metadata={"reason": reason, "dry_run": state.dry_run},
                executed_at=datetime.utcnow(),
            )
        )

    def _record_call(
        self,
        *,
        state: BIExecutorState,
        step: PlannedToolStep,
        response: MCPToolCallResponse,
        attempt: int,
    ) -> None:
        state.tool_calls.append(
            BiAgentToolCallItem(
                step_id=step.step_id,
                tool=response.tool,
                category=response.category,
                success=bool(response.output.success),
                attempt=int(attempt),
                skipped=False,
                error=response.output.error,
                warnings=list(response.output.warnings or []),
                validation_errors_count=len(response.output.validation_errors or []),
                metadata=response.output.metadata or {},
                executed_at=response.executed_at,
            )
        )

    def _resolve_arguments(
        self,
        *,
        step: PlannedToolStep,
        state: BIExecutorState,
    ) -> tuple[dict[str, Any], list[MCPToolValidationError]]:
        args = dict(step.arguments or {})
        args["dataset_id"] = int(state.dataset_id)
        errors: list[MCPToolValidationError] = []

        if step.tool_name in {"lens.validate_query_inputs", "lens.run_query"}:
            candidate_id = str(args.get("candidate_id") or "")
            candidate = state.candidate_by_id(candidate_id) if candidate_id else None
            if candidate is None:
                candidate = state.query_candidates[0] if state.query_candidates else None
            if candidate is None:
                errors.append(
                    MCPToolValidationError(
                        code="missing_query_candidate",
                        field="candidate_id",
                        message="No query candidate available for analytical step",
                    )
                )
            else:
                args.update(
                    {
                        "metrics": [item.model_dump(mode="json") for item in candidate.metrics],
                        "dimensions": list(candidate.dimensions),
                        "filters": [item.model_dump(mode="json") for item in candidate.filters],
                        "sort": [item.model_dump(mode="json") for item in candidate.sort],
                        "limit": int(candidate.limit),
                        "offset": int(candidate.offset),
                    }
                )
                args["candidate_id"] = candidate.candidate_id
        elif step.tool_name == "lens.explain_metric":
            explain_args = self._build_explain_metric_arguments(state=state)
            if explain_args is None:
                errors.append(
                    MCPToolValidationError(
                        code="metric_not_resolved",
                        field="question",
                        message="Could not resolve target metric from question/catalog",
                    )
                )
            else:
                args.update(explain_args)
        elif step.tool_name == "lens.suggest_best_visualization":
            args.update(self._build_visualization_suggestion_arguments(state=state))
        elif step.tool_name == "lens.generate_dashboard_plan":
            args["prompt"] = state.question
            args["title"] = "Plano orientado por evidencia"
        elif step.tool_name == "lens.create_dashboard_draft":
            args["name"] = f"Draft BI Agent - {state.question[:48].strip() or 'Novo dashboard'}"
        elif step.tool_name == "lens.add_dashboard_section":
            if state.dashboard_id is None:
                errors.append(
                    MCPToolValidationError(
                        code="missing_dashboard_context",
                        field="dashboard_id",
                        message="Dashboard id is required to add section",
                    )
                )
            else:
                args["dashboard_id"] = int(state.dashboard_id)
                args["section_id"] = "sec-evidence"
                args["title"] = "Achados Principais"
        elif step.tool_name == "lens.add_dashboard_widget":
            if state.dashboard_id is None:
                errors.append(
                    MCPToolValidationError(
                        code="missing_dashboard_context",
                        field="dashboard_id",
                        message="Dashboard id is required to add widget",
                    )
                )
            else:
                args.update(self._build_add_widget_arguments(state=state))
        elif step.tool_name == "lens.validate_dashboard_draft":
            if state.dashboard_id is None:
                errors.append(
                    MCPToolValidationError(
                        code="missing_dashboard_context",
                        field="dashboard_id",
                        message="Dashboard id is required to validate draft",
                    )
                )
            else:
                args["dashboard_id"] = int(state.dashboard_id)
        return args, errors

    def _build_explain_metric_arguments(self, *, state: BIExecutorState) -> dict[str, Any] | None:
        metrics = []
        if state.context_catalog and isinstance(state.context_catalog.get("metrics"), list):
            metrics = [item for item in state.context_catalog["metrics"] if isinstance(item, dict)]
        if not metrics:
            return None
        mentions = state.question_analysis.mentioned_metrics if state.question_analysis else []
        target_mentions = [item.strip().lower() for item in mentions]
        for metric in metrics:
            name = str(metric.get("name") or "").strip().lower()
            if name and name in target_mentions:
                return {"metric_id": int(metric["id"])}
        return {"metric_id": int(metrics[0]["id"])}

    def _build_visualization_suggestion_arguments(self, *, state: BIExecutorState) -> dict[str, Any]:
        first_candidate = state.query_candidates[0] if state.query_candidates else None
        metrics = [item.field for item in (first_candidate.metrics if first_candidate else [])]
        dimensions = list(first_candidate.dimensions if first_candidate else [])
        time_column = dimensions[0] if (state.question_analysis and state.question_analysis.requires_temporal and dimensions) else None
        return {
            "metrics": metrics,
            "dimensions": dimensions,
            "time_column": time_column,
            "goal": state.question,
            "max_suggestions": 4,
        }

    def _build_add_widget_arguments(self, *, state: BIExecutorState) -> dict[str, Any]:
        widget_type = "kpi"
        config: dict[str, Any] | None = None
        if state.visualization_suggestions:
            top = state.visualization_suggestions[0]
            widget_type = str(top.get("widget_type") or "kpi")
            if isinstance(top.get("recommended_config"), dict):
                config = dict(top["recommended_config"])

        if config is None:
            candidate = state.query_candidates[0] if state.query_candidates else None
            metric_field = "id"
            if candidate and candidate.metrics:
                metric_field = candidate.metrics[0].field
            config = {
                "widget_type": "kpi",
                "view_name": "__dataset_base",
                "metrics": [{"op": "sum", "column": metric_field}],
            }
            widget_type = "kpi"

        return {
            "dashboard_id": int(state.dashboard_id),
            "section_id": "sec-evidence",
            "widget_type": widget_type,
            "title": "Indicador Prioritario",
            "config": config,
        }

    def _is_recoverable_failure(self, *, step: PlannedToolStep, response: MCPToolCallResponse) -> bool:
        if step.tool_name in {"lens.validate_query_inputs", "lens.run_query", "lens.explain_metric"}:
            return True
        return False

    def _fallback_arguments(
        self,
        *,
        step: PlannedToolStep,
        state: BIExecutorState,
        current_args: dict[str, Any],
    ) -> dict[str, Any] | None:
        if step.tool_name in {"lens.validate_query_inputs", "lens.run_query"}:
            candidate_id = str(current_args.get("candidate_id") or "")
            if candidate_id:
                state.warnings.append(f"Candidate '{candidate_id}' failed validation/execution. Applying fallback aggregate query.")
            fallback_column = "id"
            if state.context_schema and isinstance(state.context_schema.get("fields"), list):
                fields = [item for item in state.context_schema["fields"] if isinstance(item, dict)]
                if fields and isinstance(fields[0].get("name"), str):
                    fallback_column = fields[0]["name"]
            return {
                **current_args,
                "metrics": [{"field": fallback_column, "agg": "count"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 10,
                "offset": 0,
            }
        if step.tool_name == "lens.explain_metric":
            if state.context_catalog and isinstance(state.context_catalog.get("metrics"), list):
                metrics = [item for item in state.context_catalog["metrics"] if isinstance(item, dict)]
                if metrics:
                    return {
                        **current_args,
                        "metric_id": int(metrics[0]["id"]),
                        "metric_name": None,
                    }
        return None

    def _ingest_output(self, *, state: BIExecutorState, step: PlannedToolStep, response: MCPToolCallResponse) -> None:
        output = response.output
        if output.warnings:
            state.warnings.extend(output.warnings)
        if output.validation_errors:
            state.validation_errors.extend(output.validation_errors)

        if not output.success:
            return

        data = output.data or {}
        timestamp = response.executed_at
        if step.tool_name == "lens.get_dataset_semantic_layer":
            state.context_semantic = data
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=f"Loaded semantic layer with {len(data.get('semantic_columns', []))} semantic columns.",
                    timestamp=timestamp,
                    data={"metrics_count": len(data.get("metrics", [])), "dimensions_count": len(data.get("dimensions", []))},
                )
            )
        elif step.tool_name == "lens.get_dataset_schema":
            state.context_schema = data
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=f"Loaded schema with {int(data.get('field_count', 0))} fields.",
                    timestamp=timestamp,
                    data={"field_count": int(data.get("field_count", 0))},
                )
            )
        elif step.tool_name == "lens.get_dataset_catalog":
            state.context_catalog = data
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=f"Loaded semantic catalog with {len(data.get('metrics', []))} metrics and {len(data.get('dimensions', []))} dimensions.",
                    timestamp=timestamp,
                    data={"metrics": len(data.get("metrics", [])), "dimensions": len(data.get("dimensions", []))},
                )
            )
        elif step.tool_name == "lens.run_query":
            row_count = int(data.get("row_count", 0))
            query_spec = data.get("query_spec") if isinstance(data.get("query_spec"), dict) else {}
            columns = data.get("columns") if isinstance(data.get("columns"), list) else []
            rows = data.get("rows") if isinstance(data.get("rows"), list) else []
            candidate_id = str(step.arguments.get("candidate_id") or "")
            candidate = state.candidate_by_id(candidate_id) if candidate_id else None
            state.last_query_data = data
            query_evidence = BiAgentQueryEvidence(
                candidate_id=candidate_id or None,
                candidate_title=candidate.title if candidate else None,
                query_spec=query_spec,
                row_count=row_count,
                columns=[str(item) for item in columns],
                rows_preview=[item for item in rows[:5] if isinstance(item, dict)],
            )
            state.queries_executed.append(query_evidence)
            if candidate_id:
                state.candidate_result_by_id[candidate_id] = {
                    "row_count": row_count,
                    "columns": query_evidence.columns,
                    "rows_preview": query_evidence.rows_preview,
                }
            summary = f"Executed candidate '{candidate_id}' with row_count={row_count}." if candidate_id else f"Executed analytical query with row_count={row_count}."
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=summary,
                    timestamp=timestamp,
                    data={"candidate_id": candidate_id or None, "row_count": row_count, "columns": columns[:8]},
                )
            )
            if row_count == 0:
                state.warnings.append("Analytical query returned zero rows; confidence may be reduced.")
        elif step.tool_name == "lens.explain_metric":
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=str(data.get("explanation") or "Metric explanation generated."),
                    timestamp=timestamp,
                    data={"metric": data.get("metric") if isinstance(data.get("metric"), dict) else {}},
                )
            )
        elif step.tool_name == "lens.suggest_best_visualization":
            suggestions = data.get("suggestions_ranked")
            if isinstance(suggestions, list):
                state.visualization_suggestions = [item for item in suggestions if isinstance(item, dict)]
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=f"Generated {len(state.visualization_suggestions)} visualization suggestions.",
                    timestamp=timestamp,
                    data={"top_widget": state.visualization_suggestions[0]["widget_type"] if state.visualization_suggestions else None},
                )
            )
        elif step.tool_name == "lens.generate_dashboard_plan":
            state.dashboard_plan = data
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool=step.tool_name,
                    summary=f"Generated dashboard plan with {len(data.get('sections', []))} sections.",
                    timestamp=timestamp,
                    data={"sections": len(data.get("sections", []))},
                )
            )
        elif step.tool_name == "lens.create_dashboard_draft":
            dashboard = data.get("dashboard") if isinstance(data.get("dashboard"), dict) else {}
            resolved_id = dashboard.get("id") if isinstance(dashboard.get("id"), int) else None
            if resolved_id is not None:
                state.dashboard_id = int(resolved_id)
            state.dashboard_draft_snapshot = data
        elif step.tool_name in {
            "lens.add_dashboard_section",
            "lens.add_dashboard_widget",
            "lens.update_dashboard_widget",
            "lens.delete_dashboard_widget",
            "lens.set_dashboard_native_filters",
            "lens.save_dashboard_draft",
        }:
            dashboard = data.get("dashboard") if isinstance(data.get("dashboard"), dict) else {}
            resolved_id = dashboard.get("id") if isinstance(dashboard.get("id"), int) else None
            if resolved_id is not None:
                state.dashboard_id = int(resolved_id)
            state.dashboard_draft_snapshot = data
        elif step.tool_name == "lens.validate_dashboard_draft":
            if not bool(data.get("is_valid", True)):
                state.warnings.append("Dashboard draft validation reported issues.")

