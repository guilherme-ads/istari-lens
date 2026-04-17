from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.modules.bi_agent.agent.critic import BIAgentCritic
from app.modules.bi_agent.agent.executor import BIExecutorState, BIPlanExecutor
from app.modules.bi_agent.agent.planner import BIExecutionPlan, PlannedToolStep
from app.modules.bi_agent.agent.reasoning_adapter import ReasoningAdapter
from app.modules.bi_agent.schemas import (
    BiAdaptiveDecision,
    BiAgentHypothesis,
    BiAnalysisState,
    BiEvidenceGap,
    BiNextQueryCandidate,
    BiQueryCandidate,
    BiQuestionAnalysis,
    BiReasoningAdapterContribution,
)
from app.modules.core.legacy.models import User


@dataclass
class AdaptiveLoopOutcome:
    state: BIExecutorState
    analysis_state: BiAnalysisState
    hypotheses: list[BiAgentHypothesis]
    evidence_gaps: list[BiEvidenceGap]
    stopping_reason: str
    next_query_candidates: list[BiNextQueryCandidate]
    adaptive_decisions: list[BiAdaptiveDecision]
    reasoning_adapter_contributions: list[BiReasoningAdapterContribution]


class AdaptiveEvidenceLoop:
    def __init__(
        self,
        *,
        max_evidence_steps: int,
        confidence_threshold: float = 0.78,
        min_marginal_gain: float = 0.03,
        max_low_gain_iterations: int = 2,
    ) -> None:
        self.max_evidence_steps = int(max_evidence_steps)
        self.confidence_threshold = float(confidence_threshold)
        self.min_marginal_gain = float(min_marginal_gain)
        self.max_low_gain_iterations = int(max_low_gain_iterations)

    async def run(
        self,
        *,
        state: BIExecutorState,
        analysis: BiQuestionAnalysis,
        candidates: list[BiQueryCandidate],
        executor: BIPlanExecutor,
        db: Session,
        current_user: User,
        reasoning_adapter: ReasoningAdapter,
        enable_reasoning_adapter: bool,
        trace_id: str,
    ) -> AdaptiveLoopOutcome:
        hypotheses, evidence_gaps = self._initialize_hypotheses_and_gaps(analysis=analysis)
        contributions: list[BiReasoningAdapterContribution] = []

        if enable_reasoning_adapter:
            base_hypothesis_snapshot = [item.model_dump(mode="json") for item in hypotheses]
            base_gap_snapshot = [item.model_dump(mode="json") for item in evidence_gaps]
            adapted_hypotheses, adapted_gaps = await reasoning_adapter.refine_hypotheses(
                analysis=analysis,
                hypotheses=hypotheses,
                evidence_gaps=evidence_gaps,
                trace_id=trace_id,
            )
            hypotheses = adapted_hypotheses
            evidence_gaps = adapted_gaps
            changed = (
                [item.model_dump(mode="json") for item in hypotheses] != base_hypothesis_snapshot
                or [item.model_dump(mode="json") for item in evidence_gaps] != base_gap_snapshot
            )
            contributions.append(
                BiReasoningAdapterContribution(
                    contribution_type="hypothesis_refinement",
                    applied=changed,
                    summary=(
                        "Reasoning adapter refined hypotheses/gaps."
                        if changed
                        else "Reasoning adapter reviewed hypotheses/gaps with no structural changes."
                    ),
                    payload={
                        "hypotheses_count": len(hypotheses),
                        "evidence_gaps_count": len(evidence_gaps),
                    },
                )
            )

        adaptive_decisions: list[BiAdaptiveDecision] = []
        low_gain_streak = 0
        stopping_reason = "evidence_step_budget_exhausted"
        latest_ranked: list[BiNextQueryCandidate] = []

        for iteration in range(1, self.max_evidence_steps + 1):
            critic_before = BIAgentCritic().review(state=state)
            coverage = self._coverage_snapshot(state=state)
            latest_ranked = self._rank_next_candidates(
                analysis=analysis,
                candidates=candidates,
                state=state,
                coverage=coverage,
                evidence_gaps=evidence_gaps,
            )
            selected, selection_reason, adapter_contribution = await self._select_candidate(
                analysis=analysis,
                ranked_candidates=latest_ranked,
                reasoning_adapter=reasoning_adapter,
                enable_reasoning_adapter=enable_reasoning_adapter,
                trace_id=trace_id,
                execution_context={
                    "iteration": iteration,
                    "current_confidence": critic_before.confidence,
                    "covered_candidates": coverage["covered_candidate_ids"],
                    "open_gaps": [item.code for item in evidence_gaps if not item.resolved],
                },
            )
            if adapter_contribution is not None:
                contributions.append(adapter_contribution)

            if selected is None:
                stopping_reason = "no_remaining_candidates"
                adaptive_decisions.append(
                    BiAdaptiveDecision(
                        iteration=iteration,
                        status="stopped",
                        reason="No candidate available with non-blocked score.",
                        confidence_before=critic_before.confidence,
                        confidence_after=critic_before.confidence,
                        marginal_gain=0.0,
                    )
                )
                break

            query_count_before = len(state.queries_executed)
            step_plan = BIExecutionPlan(
                intent=analysis.intent,
                mode=state.mode,  # type: ignore[arg-type]
                strategy_name="adaptive_loop",
                selected_candidate_ids=[selected.candidate_id],
                steps=[
                    PlannedToolStep(
                        step_id=f"adaptive.validate.{selected.candidate_id}",
                        tool_name="lens.validate_query_inputs",
                        purpose=f"Validate adaptive candidate {selected.candidate_id}.",
                        required=False,
                        max_retries=1,
                        arguments={"dataset_id": int(state.dataset_id), "candidate_id": selected.candidate_id},
                    ),
                    PlannedToolStep(
                        step_id=f"adaptive.run_query.{selected.candidate_id}",
                        tool_name="lens.run_query",
                        purpose=f"Run adaptive candidate {selected.candidate_id}.",
                        required=False,
                        max_retries=1,
                        arguments={"dataset_id": int(state.dataset_id), "candidate_id": selected.candidate_id},
                    ),
                ],
            )
            state = await executor.execute(plan=step_plan, state=state, db=db, current_user=current_user)
            query_count_after = len(state.queries_executed)
            new_query = state.queries_executed[-1] if query_count_after > query_count_before else None

            self._update_hypotheses_and_gaps(
                selected_candidate=selected,
                hypotheses=hypotheses,
                evidence_gaps=evidence_gaps,
                new_query_row_count=int(new_query.row_count) if new_query is not None else 0,
            )

            critic_after = BIAgentCritic().review(state=state)
            marginal_gain = round(float(critic_after.confidence - critic_before.confidence), 3)
            if marginal_gain < self.min_marginal_gain:
                low_gain_streak += 1
            else:
                low_gain_streak = 0

            adaptive_decisions.append(
                BiAdaptiveDecision(
                    iteration=iteration,
                    selected_candidate_id=selected.candidate_id,
                    status="executed",
                    reason=selection_reason,
                    estimated_gain=selected.estimated_gain,
                    estimated_cost=selected.estimated_cost,
                    novelty_score=selected.novelty_score,
                    score_breakdown={"rank_score": round(selected.score, 3)},
                    confidence_before=critic_before.confidence,
                    confidence_after=critic_after.confidence,
                    marginal_gain=marginal_gain,
                )
            )

            if self._is_confidence_sufficient(
                confidence=critic_after.confidence,
                analysis=analysis,
                evidence_gaps=evidence_gaps,
            ):
                stopping_reason = "confidence_sufficient"
                break
            if analysis.ambiguity_level == "high" and len([item for item in state.queries_executed if item.row_count > 0]) == 0 and iteration >= 2:
                stopping_reason = "high_ambiguity_insufficient_signal"
                break
            if low_gain_streak >= self.max_low_gain_iterations:
                stopping_reason = "low_marginal_gain"
                break
            if state.halted:
                stopping_reason = state.halt_reason or "execution_halted"
                break
        else:
            stopping_reason = "evidence_step_budget_exhausted"

        if stopping_reason != "confidence_sufficient":
            latest_ranked = self._rank_next_candidates(
                analysis=analysis,
                candidates=candidates,
                state=state,
                coverage=self._coverage_snapshot(state=state),
                evidence_gaps=evidence_gaps,
            )

        analysis_state = self._build_analysis_state(
            state=state,
            analysis=analysis,
            hypotheses=hypotheses,
            evidence_gaps=evidence_gaps,
            stopping_reason=stopping_reason,
            latest_decision=adaptive_decisions[-1].reason if adaptive_decisions else None,
        )
        return AdaptiveLoopOutcome(
            state=state,
            analysis_state=analysis_state,
            hypotheses=hypotheses,
            evidence_gaps=evidence_gaps,
            stopping_reason=stopping_reason,
            next_query_candidates=latest_ranked[:5],
            adaptive_decisions=adaptive_decisions,
            reasoning_adapter_contributions=contributions,
        )

    def _initialize_hypotheses_and_gaps(self, *, analysis: BiQuestionAnalysis) -> tuple[list[BiAgentHypothesis], list[BiEvidenceGap]]:
        hypotheses = [
            BiAgentHypothesis(
                hypothesis_id="hyp_overview_signal",
                statement="Existe sinal agregado suficiente para explicar o comportamento da metrica principal.",
                status="open",
                confidence=0.3,
            )
        ]
        gaps = [
            BiEvidenceGap(
                code="gap_overview",
                description="Ainda nao foi executada consulta agregada de visao geral.",
                priority="high",
            )
        ]
        if analysis.requires_temporal or analysis.intent in {"diagnostic_analysis", "dashboard_generation", "exploratory_analysis"}:
            hypotheses.append(
                BiAgentHypothesis(
                    hypothesis_id="hyp_temporal_shift",
                    statement="A variacao principal esta concentrada em um periodo especifico.",
                    status="open",
                    confidence=0.25,
                )
            )
            gaps.append(
                BiEvidenceGap(
                    code="gap_temporal_coverage",
                    description="Falta evidencia temporal para confirmar tendencia/queda.",
                    priority="high",
                )
            )
        if analysis.requires_diagnostic or analysis.intent in {"diagnostic_analysis", "dashboard_generation"}:
            hypotheses.append(
                BiAgentHypothesis(
                    hypothesis_id="hyp_dimension_driver",
                    statement="Uma dimensao relevante concentra contribuidores positivos/negativos.",
                    status="open",
                    confidence=0.25,
                )
            )
            gaps.append(
                BiEvidenceGap(
                    code="gap_dimensional_coverage",
                    description="Falta quebra por dimensao para identificar contribuidores.",
                    priority="high",
                )
            )
            gaps.append(
                BiEvidenceGap(
                    code="gap_before_after_comparison",
                    description="Falta comparacao temporal x dimensao para diagnostico.",
                    priority="medium",
                )
            )
        if analysis.ambiguity_level in {"medium", "high"}:
            gaps.append(
                BiEvidenceGap(
                    code="gap_ambiguity_resolution",
                    description="Pergunta ainda apresenta ambiguidade semantica relevante.",
                    priority="medium",
                )
            )
        return hypotheses, gaps

    def _coverage_snapshot(self, *, state: BIExecutorState) -> dict[str, Any]:
        covered_candidates = [item.candidate_id for item in state.queries_executed if item.candidate_id]
        covered_dimensions: list[str] = []
        for item in state.queries_executed:
            query_dimensions = item.query_spec.get("dimensions", []) if isinstance(item.query_spec, dict) else []
            if isinstance(query_dimensions, list):
                for dim in query_dimensions:
                    if isinstance(dim, str) and dim not in covered_dimensions:
                        covered_dimensions.append(dim)
        temporal_fields = [
            str(item.get("name"))
            for item in (state.context_schema or {}).get("fields", [])
            if isinstance(item, dict) and str(item.get("semantic_type", "")).lower() == "temporal"
        ]
        temporal_coverage = any(dim in temporal_fields for dim in covered_dimensions) or any(
            item.candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"} for item in state.queries_executed
        )
        dimensional_coverage = any(
            item.candidate_id in {"cand_dimension_breakdown", "cand_top_contributors", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}
            for item in state.queries_executed
        )
        return {
            "covered_candidate_ids": covered_candidates,
            "covered_dimensions": covered_dimensions,
            "temporal_coverage": temporal_coverage,
            "dimensional_coverage": dimensional_coverage,
        }

    def _rank_next_candidates(
        self,
        *,
        analysis: BiQuestionAnalysis,
        candidates: list[BiQueryCandidate],
        state: BIExecutorState,
        coverage: dict[str, Any],
        evidence_gaps: list[BiEvidenceGap],
    ) -> list[BiNextQueryCandidate]:
        covered_candidate_ids = {str(item) for item in coverage.get("covered_candidate_ids", [])}
        temporal_covered = bool(coverage.get("temporal_coverage"))
        dimensional_covered = bool(coverage.get("dimensional_coverage"))
        unresolved_gap_codes = {item.code for item in evidence_gaps if not item.resolved}

        ranked: list[BiNextQueryCandidate] = []
        for candidate in candidates:
            already_executed = candidate.candidate_id in covered_candidate_ids
            blocked = already_executed

            alignment = 0.3
            if analysis.intent == "kpi_summary" and candidate.candidate_id == "cand_overview":
                alignment += 0.35
            if analysis.expected_answer_shape == "single_best" and candidate.candidate_id in {"cand_top_dimension", "cand_dimension_breakdown"}:
                alignment += 0.35
            if analysis.expected_answer_shape == "single_worst" and candidate.candidate_id in {"cand_bottom_dimension", "cand_dimension_breakdown"}:
                alignment += 0.35
            if analysis.intent == "diagnostic_analysis" and candidate.candidate_id in {"cand_top_contributors", "cand_temporal_dimension"}:
                alignment += 0.35
            if analysis.intent == "dashboard_generation" and candidate.candidate_id in {"cand_overview", "cand_temporal_trend", "cand_dimension_breakdown"}:
                alignment += 0.2
            if analysis.intent == "visualization_help" and candidate.candidate_id in {"cand_temporal_trend", "cand_dimension_breakdown"}:
                alignment += 0.2

            metric_alignment = 0.0
            mentioned_metric_tokens = {item.lower() for item in [*analysis.mentioned_metrics, *analysis.inferred_metrics]}
            candidate_metric_tokens = {item.field.lower() for item in candidate.metrics}
            if len(mentioned_metric_tokens.intersection(candidate_metric_tokens)) > 0:
                metric_alignment = 0.25
            elif len(candidate.metrics) > 0:
                metric_alignment = 0.1

            temporal_gain = 0.25 if (not temporal_covered and any(tag in {"temporal", "trend"} for tag in candidate.tags)) else 0.0
            dimensional_gain = 0.25 if (not dimensional_covered and any(tag in {"dimension", "diagnostic", "ranking"} for tag in candidate.tags)) else 0.0
            diagnostic_gain = 0.2 if (
                analysis.intent == "diagnostic_analysis" and any(tag in {"diagnostic", "comparison", "ranking"} for tag in candidate.tags)
            ) else 0.0

            novelty_score = 1.0 if not already_executed else 0.0
            cost_efficiency = max(0.0, min(1.0, 1.0 - (float(candidate.cost_score) / 100.0)))

            gap_bonus = 0.0
            if "gap_temporal_coverage" in unresolved_gap_codes and candidate.candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"}:
                gap_bonus += 0.15
            if "gap_dimensional_coverage" in unresolved_gap_codes and candidate.candidate_id in {"cand_dimension_breakdown", "cand_top_contributors", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}:
                gap_bonus += 0.15
            if "gap_before_after_comparison" in unresolved_gap_codes and candidate.candidate_id == "cand_temporal_dimension":
                gap_bonus += 0.1

            total_score = (
                (0.24 * alignment)
                + (0.16 * metric_alignment)
                + (0.16 * temporal_gain)
                + (0.16 * dimensional_gain)
                + (0.12 * diagnostic_gain)
                + (0.10 * novelty_score)
                + (0.06 * cost_efficiency)
                + gap_bonus
            )
            if blocked:
                total_score *= 0.05
            total_score = round(max(0.0, min(1.0, total_score)), 3)
            reason = (
                f"alignment={round(alignment, 2)}, metric={round(metric_alignment, 2)}, temporal_gain={round(temporal_gain, 2)}, "
                f"dimensional_gain={round(dimensional_gain, 2)}, novelty={round(novelty_score, 2)}, cost_eff={round(cost_efficiency, 2)}"
            )
            ranked.append(
                BiNextQueryCandidate(
                    candidate_id=candidate.candidate_id,
                    title=candidate.title,
                    score=total_score,
                    reason=reason,
                    estimated_gain=round(min(1.0, temporal_gain + dimensional_gain + diagnostic_gain + gap_bonus + (0.4 * metric_alignment)), 3),
                    estimated_cost=round(float(candidate.cost_score) / 100.0, 3),
                    novelty_score=round(novelty_score, 3),
                    blocked=blocked,
                )
            )
        return sorted(ranked, key=lambda item: (-float(item.score), float(item.estimated_cost), item.candidate_id))

    async def _select_candidate(
        self,
        *,
        analysis: BiQuestionAnalysis,
        ranked_candidates: list[BiNextQueryCandidate],
        reasoning_adapter: ReasoningAdapter,
        enable_reasoning_adapter: bool,
        trace_id: str,
        execution_context: dict[str, Any],
    ) -> tuple[BiNextQueryCandidate | None, str, BiReasoningAdapterContribution | None]:
        available = [item for item in ranked_candidates if not item.blocked]
        if len(available) == 0:
            return None, "No available candidate after redundancy filtering.", None

        default_choice = available[0]
        if not enable_reasoning_adapter:
            return default_choice, f"Selected top ranked candidate by evidence gain score ({default_choice.score}).", None

        suggestion = await reasoning_adapter.suggest_next_candidate(
            analysis=analysis,
            ranked_candidates=available,
            execution_context=execution_context,
            trace_id=trace_id,
        )
        if suggestion is None:
            return default_choice, f"Selected top ranked candidate by evidence gain score ({default_choice.score}).", None

        if suggestion.tool_name != "lens.run_query":
            contribution = BiReasoningAdapterContribution(
                contribution_type="next_action",
                applied=False,
                summary="Adapter suggested tool is not allowed in adaptive query selection.",
                payload={
                    "suggested_candidate_id": suggestion.candidate_id,
                    "suggested_tool_name": suggestion.tool_name,
                    "fallback_to_candidate": default_choice.candidate_id,
                },
            )
            return default_choice, f"Fallback to ranked top candidate ({default_choice.score}).", contribution

        selected = next((item for item in available if item.candidate_id == suggestion.candidate_id), None)
        if selected is None:
            contribution = BiReasoningAdapterContribution(
                contribution_type="next_action",
                applied=False,
                summary="Adapter suggested candidate not available; default ranking kept.",
                payload={"suggested_candidate_id": suggestion.candidate_id},
            )
            return default_choice, f"Fallback to ranked top candidate ({default_choice.score}).", contribution

        contribution = BiReasoningAdapterContribution(
            contribution_type="next_action",
            applied=True,
            summary="Adapter suggestion accepted under guardrails.",
            payload={
                "suggested_candidate_id": suggestion.candidate_id,
                "suggested_tool_name": suggestion.tool_name,
                "suggested_arguments": suggestion.arguments or {},
                "hypothesis_to_test": suggestion.hypothesis_to_test,
                "reason": suggestion.reason,
                "confidence": suggestion.confidence,
                "metadata": suggestion.metadata or {},
            },
        )
        return selected, f"Adapter-selected candidate: {selected.candidate_id}. {suggestion.reason}", contribution

    def _update_hypotheses_and_gaps(
        self,
        *,
        selected_candidate: BiNextQueryCandidate,
        hypotheses: list[BiAgentHypothesis],
        evidence_gaps: list[BiEvidenceGap],
        new_query_row_count: int,
    ) -> None:
        is_positive_signal = new_query_row_count > 0
        if selected_candidate.candidate_id == "cand_overview":
            self._resolve_gap(evidence_gaps, "gap_overview", selected_candidate.candidate_id)
            self._update_hypothesis(hypotheses, "hyp_overview_signal", is_positive_signal, selected_candidate.candidate_id)
        if selected_candidate.candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"}:
            self._resolve_gap(evidence_gaps, "gap_temporal_coverage", selected_candidate.candidate_id)
            self._update_hypothesis(hypotheses, "hyp_temporal_shift", is_positive_signal, selected_candidate.candidate_id)
        if selected_candidate.candidate_id in {"cand_dimension_breakdown", "cand_top_contributors", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}:
            self._resolve_gap(evidence_gaps, "gap_dimensional_coverage", selected_candidate.candidate_id)
            self._update_hypothesis(hypotheses, "hyp_dimension_driver", is_positive_signal, selected_candidate.candidate_id)
        if selected_candidate.candidate_id == "cand_temporal_dimension":
            self._resolve_gap(evidence_gaps, "gap_before_after_comparison", selected_candidate.candidate_id)
        if is_positive_signal:
            self._resolve_gap(evidence_gaps, "gap_ambiguity_resolution", selected_candidate.candidate_id)

    def _update_hypothesis(
        self,
        hypotheses: list[BiAgentHypothesis],
        hypothesis_id: str,
        is_positive_signal: bool,
        evidence_candidate_id: str,
    ) -> None:
        target = next((item for item in hypotheses if item.hypothesis_id == hypothesis_id), None)
        if target is None:
            return
        target.evidence_query_ids = list(dict.fromkeys([*target.evidence_query_ids, evidence_candidate_id]))
        if is_positive_signal:
            target.status = "supported"
            target.confidence = min(0.95, round(max(target.confidence, 0.7), 2))
        elif target.status == "open":
            target.status = "inconclusive"
            target.confidence = min(0.6, round(max(target.confidence, 0.4), 2))

    def _resolve_gap(self, gaps: list[BiEvidenceGap], code: str, candidate_id: str) -> None:
        target = next((item for item in gaps if item.code == code), None)
        if target is None:
            return
        target.resolved = True
        target.resolved_by_candidate_ids = list(dict.fromkeys([*target.resolved_by_candidate_ids, candidate_id]))

    def _is_confidence_sufficient(
        self,
        *,
        confidence: float,
        analysis: BiQuestionAnalysis,
        evidence_gaps: list[BiEvidenceGap],
    ) -> bool:
        if confidence < self.confidence_threshold:
            return False
        unresolved_high = [item for item in evidence_gaps if (not item.resolved and item.priority == "high")]
        if len(unresolved_high) == 0:
            return True
        if analysis.intent in {"kpi_summary", "exploratory_analysis"} and len(unresolved_high) <= 1:
            return True
        return False

    def _build_analysis_state(
        self,
        *,
        state: BIExecutorState,
        analysis: BiQuestionAnalysis,
        hypotheses: list[BiAgentHypothesis],
        evidence_gaps: list[BiEvidenceGap],
        stopping_reason: str,
        latest_decision: str | None,
    ) -> BiAnalysisState:
        coverage = self._coverage_snapshot(state=state)
        critic = BIAgentCritic().review(state=state)
        return BiAnalysisState(
            question=state.question,
            intent=analysis.intent,
            ambiguity_level=analysis.ambiguity_level,
            covered_candidate_ids=[str(item) for item in coverage["covered_candidate_ids"]],
            covered_dimensions=[str(item) for item in coverage["covered_dimensions"]],
            temporal_coverage=bool(coverage["temporal_coverage"]),
            dimensional_coverage=bool(coverage["dimensional_coverage"]),
            hypotheses=hypotheses,
            evidence_gaps=evidence_gaps,
            current_confidence=critic.confidence,
            last_decision_reason=latest_decision or stopping_reason,
            open_ambiguities_count=len(analysis.ambiguities),
        )
