from __future__ import annotations

from dataclasses import dataclass

from app.modules.bi_agent.agent.planner import PlannedToolStep
from app.modules.bi_agent.schemas import BiAgentMode, BiQueryCandidate, BiQuestionAnalysis


@dataclass
class IntentStrategy:
    strategy_name: str
    selected_candidates: list[BiQueryCandidate]
    steps: list[PlannedToolStep]


def _candidate_by_id(candidates: list[BiQueryCandidate], candidate_id: str) -> BiQueryCandidate | None:
    for item in candidates:
        if item.candidate_id == candidate_id:
            return item
    return None


def _pick_candidates_for_intent(
    *,
    analysis: BiQuestionAnalysis,
    candidates: list[BiQueryCandidate],
) -> list[BiQueryCandidate]:
    intent = analysis.intent
    if analysis.expected_answer_shape == "single_best":
        preferred = ["cand_top_dimension", "cand_dimension_breakdown", "cand_overview"]
    elif analysis.expected_answer_shape == "single_worst":
        preferred = ["cand_bottom_dimension", "cand_dimension_breakdown", "cand_overview"]
    elif intent == "kpi_summary":
        preferred = ["cand_overview", "cand_temporal_trend"]
    elif intent == "diagnostic_analysis":
        preferred = ["cand_temporal_trend", "cand_top_contributors", "cand_dimension_breakdown", "cand_temporal_dimension"]
    elif intent == "visualization_help":
        preferred = ["cand_overview", "cand_dimension_breakdown", "cand_temporal_trend"]
    elif intent == "dashboard_generation":
        preferred = ["cand_overview", "cand_temporal_trend", "cand_dimension_breakdown", "cand_top_contributors"]
    elif intent == "metric_explanation":
        preferred = ["cand_overview"]
    else:
        preferred = ["cand_overview", "cand_dimension_breakdown", "cand_temporal_trend"]

    selected: list[BiQueryCandidate] = []
    for candidate_id in preferred:
        item = _candidate_by_id(candidates, candidate_id)
        if item is not None:
            selected.append(item)
    for item in candidates:
        if item.candidate_id not in {candidate.candidate_id for candidate in selected}:
            selected.append(item)
    return selected[:4]


def build_intent_strategy(
    *,
    dataset_id: int,
    analysis: BiQuestionAnalysis,
    candidates: list[BiQueryCandidate],
    mode: BiAgentMode,
    apply_changes: bool,
) -> IntentStrategy:
    selected_candidates = _pick_candidates_for_intent(analysis=analysis, candidates=candidates)
    steps: list[PlannedToolStep] = []
    strategy_name = f"{analysis.intent}_strategy"

    if analysis.intent == "metric_explanation":
        steps.append(
            PlannedToolStep(
                step_id="analysis.explain_metric",
                tool_name="lens.explain_metric",
                purpose="Explicar metrica solicitada.",
                required=True,
                arguments={"dataset_id": int(dataset_id)},
            )
        )

    for index, candidate in enumerate(selected_candidates):
        suffix = f"{index + 1}"
        steps.append(
            PlannedToolStep(
                step_id=f"analysis.validate_query.{suffix}",
                tool_name="lens.validate_query_inputs",
                purpose=f"Validar candidate {candidate.candidate_id}.",
                required=index == 0,
                max_retries=1,
                arguments={"dataset_id": int(dataset_id), "candidate_id": candidate.candidate_id},
            )
        )
        steps.append(
            PlannedToolStep(
                step_id=f"analysis.run_query.{suffix}",
                tool_name="lens.run_query",
                purpose=f"Executar candidate {candidate.candidate_id}.",
                required=index == 0,
                max_retries=1,
                arguments={"dataset_id": int(dataset_id), "candidate_id": candidate.candidate_id},
            )
        )

    if analysis.requires_visualization or analysis.intent in {"visualization_help", "dashboard_generation"}:
        steps.append(
            PlannedToolStep(
                step_id="validation.visualization",
                tool_name="lens.suggest_best_visualization",
                purpose="Sugerir visual com base em evidencias.",
                required=False,
                arguments={"dataset_id": int(dataset_id)},
            )
        )

    if mode in {"plan", "draft"} or analysis.intent == "dashboard_generation":
        steps.append(
            PlannedToolStep(
                step_id="builder.plan",
                tool_name="lens.generate_dashboard_plan",
                purpose="Gerar plano base de dashboard.",
                required=False,
                arguments={"dataset_id": int(dataset_id)},
            )
        )

    if mode == "draft" and analysis.requires_dashboard and apply_changes:
        steps.extend(
            [
                PlannedToolStep(
                    step_id="builder.create_draft",
                    tool_name="lens.create_dashboard_draft",
                    purpose="Criar draft para aplicacao das recomendacoes.",
                    required=False,
                    mutable=True,
                    arguments={"dataset_id": int(dataset_id)},
                ),
                PlannedToolStep(
                    step_id="builder.add_section",
                    tool_name="lens.add_dashboard_section",
                    purpose="Criar secao executiva no draft.",
                    required=False,
                    mutable=True,
                    arguments={"dataset_id": int(dataset_id)},
                ),
                PlannedToolStep(
                    step_id="builder.add_widget",
                    tool_name="lens.add_dashboard_widget",
                    purpose="Adicionar widget prioritario embasado em evidencia.",
                    required=False,
                    mutable=True,
                    arguments={"dataset_id": int(dataset_id)},
                ),
                PlannedToolStep(
                    step_id="validation.draft",
                    tool_name="lens.validate_dashboard_draft",
                    purpose="Validar draft apos aplicacao.",
                    required=False,
                    arguments={"dataset_id": int(dataset_id)},
                ),
            ]
        )
    return IntentStrategy(
        strategy_name=strategy_name,
        selected_candidates=selected_candidates,
        steps=steps,
    )
