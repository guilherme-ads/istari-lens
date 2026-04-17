from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.modules.bi_agent.schemas import BiAgentMode, BiQueryCandidate, BiQuestionAnalysis


@dataclass
class PlannedToolStep:
    step_id: str
    tool_name: str
    purpose: str
    required: bool = True
    max_retries: int = 1
    mutable: bool = False
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class BIExecutionPlan:
    intent: str
    mode: BiAgentMode
    strategy_name: str
    selected_candidate_ids: list[str]
    steps: list[PlannedToolStep]


def build_context_steps(*, dataset_id: int) -> list[PlannedToolStep]:
    return [
        PlannedToolStep(
            step_id="context.semantic",
            tool_name="lens.get_dataset_semantic_layer",
            purpose="Carregar semantica do dataset.",
            arguments={"dataset_id": int(dataset_id)},
        ),
        PlannedToolStep(
            step_id="context.schema",
            tool_name="lens.get_dataset_schema",
            purpose="Carregar schema e tipos semanticos.",
            arguments={"dataset_id": int(dataset_id)},
        ),
        PlannedToolStep(
            step_id="context.catalog",
            tool_name="lens.get_dataset_catalog",
            purpose="Carregar catalogo de metricas e dimensoes.",
            required=False,
            arguments={"dataset_id": int(dataset_id)},
        ),
    ]


def build_execution_plan(
    *,
    dataset_id: int,
    analysis: BiQuestionAnalysis,
    candidates: list[BiQueryCandidate],
    mode: BiAgentMode,
    apply_changes: bool,
) -> BIExecutionPlan:
    from app.modules.bi_agent.agent.intent_strategy import build_intent_strategy

    strategy = build_intent_strategy(
        dataset_id=dataset_id,
        analysis=analysis,
        candidates=candidates,
        mode=mode,
        apply_changes=apply_changes,
    )
    context_steps = build_context_steps(dataset_id=dataset_id)
    if analysis.intent in {"kpi_summary", "exploratory_analysis", "diagnostic_analysis", "dashboard_generation"}:
        context_steps.append(
            PlannedToolStep(
                step_id="analysis.profile",
                tool_name="lens.profile_dataset",
                purpose="Mapear estrutura e qualidade para guiar query.",
                required=False,
                arguments={"dataset_id": int(dataset_id)},
            )
        )
    return BIExecutionPlan(
        intent=analysis.intent,
        mode=mode,
        strategy_name=strategy.strategy_name,
        selected_candidate_ids=[item.candidate_id for item in strategy.selected_candidates],
        steps=[*context_steps, *strategy.steps],
    )
