from __future__ import annotations

from dataclasses import dataclass, field

from app.modules.bi_agent.agent.executor import BIExecutorState
from app.modules.bi_agent.schemas import BiEvidenceScoring


@dataclass
class BICriticResult:
    confidence: float
    has_minimum_evidence: bool
    warnings: list[str] = field(default_factory=list)
    next_best_actions: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    scoring: BiEvidenceScoring = field(default_factory=BiEvidenceScoring)


class BIAgentCritic:
    def review(self, *, state: BIExecutorState) -> BICriticResult:
        warnings: list[str] = []
        next_actions: list[str] = []
        limitations: list[str] = []

        has_context = bool(state.context_schema) and bool(state.context_semantic)
        valid_queries = [item for item in state.queries_executed if int(item.row_count) >= 0]
        non_empty_queries = [item for item in valid_queries if int(item.row_count) > 0]
        unique_candidate_ids = {item.candidate_id for item in state.queries_executed if item.candidate_id}

        valid_queries_score = min(1.0, len(non_empty_queries) / 3.0)
        diversity_score = min(1.0, len(unique_candidate_ids) / 3.0)

        alignment_score = 0.4
        if state.question_analysis:
            if state.question_analysis.expected_answer_shape == "single_best" and any(
                item.candidate_id in {"cand_top_dimension", "cand_dimension_breakdown"} for item in state.queries_executed
            ):
                alignment_score += 0.2
            if state.question_analysis.expected_answer_shape == "single_worst" and any(
                item.candidate_id in {"cand_bottom_dimension", "cand_dimension_breakdown"} for item in state.queries_executed
            ):
                alignment_score += 0.2
            if state.question_analysis.requires_temporal and any(item.candidate_id == "cand_temporal_trend" for item in state.queries_executed):
                alignment_score += 0.2
            if state.question_analysis.requires_diagnostic and any(
                item.candidate_id in {"cand_top_contributors", "cand_dimension_breakdown", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}
                for item in state.queries_executed
            ):
                alignment_score += 0.2
            if state.question_analysis.requires_visualization and state.visualization_suggestions:
                alignment_score += 0.1
            if state.question_analysis.requires_dashboard and (state.dashboard_plan or state.dashboard_plan_evidence):
                alignment_score += 0.1
        alignment_score = min(1.0, alignment_score)

        temporal_coverage_score = 1.0 if any(item.candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"} for item in state.queries_executed) else 0.0
        dimensional_coverage_score = 1.0 if any(
            item.candidate_id in {"cand_dimension_breakdown", "cand_top_contributors", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}
            for item in state.queries_executed
        ) else 0.0

        risk_penalty = 0.0
        if state.validation_errors:
            risk_penalty += min(0.4, 0.08 * len(state.validation_errors))
            warnings.append("Validation errors reduced confidence.")
            limitations.append("Existem erros de validacao pendentes nas tools executadas.")
            next_actions.append("Corrigir validation_errors e repetir a analise.")
        if state.halted:
            risk_penalty += 0.2
            warnings.append(f"Execution halted: {state.halt_reason or 'unknown'}")
            limitations.append("Fluxo interrompido antes de percorrer todo o plano planejado.")
        if not has_context:
            risk_penalty += 0.2
            warnings.append("Context loading was incomplete.")
            limitations.append("Sem contexto completo (schema/semantica), conclusoes ficam limitadas.")
            next_actions.append("Re-executar com acesso valido ao contexto do dataset.")
        if state.question_analysis and state.question_analysis.ambiguity_level in {"medium", "high"}:
            risk_penalty += 0.08 if state.question_analysis.ambiguity_level == "medium" else 0.16
            limitations.append("Pergunta contem ambiguidade semantica que reduz certeza da leitura.")
            next_actions.append("Refinar a pergunta indicando metrica e corte principal.")
        if len(non_empty_queries) == 0 and state.intent in {"kpi_summary", "exploratory_analysis", "diagnostic_analysis"}:
            risk_penalty += 0.4
            warnings.append("No non-empty analytical query result was available.")
            limitations.append("Nao houve evidencia numerica suficiente para suportar afirmacoes fortes.")
            next_actions.append("Executar novas queries com cortes alternativos para aumentar evidencia.")

        weighted_score = (
            (0.28 * valid_queries_score)
            + (0.16 * diversity_score)
            + (0.24 * alignment_score)
            + (0.14 * temporal_coverage_score)
            + (0.18 * dimensional_coverage_score)
            - risk_penalty
        )
        final_score = max(0.05, min(0.99, round(weighted_score, 2)))

        has_minimum_evidence = has_context
        if state.intent in {"kpi_summary", "exploratory_analysis", "diagnostic_analysis"}:
            has_minimum_evidence = has_minimum_evidence and len(non_empty_queries) > 0
        if state.intent == "metric_explanation":
            has_minimum_evidence = has_minimum_evidence and any(item.tool == "lens.explain_metric" for item in state.evidence)
        if state.intent == "visualization_help":
            has_minimum_evidence = has_minimum_evidence and bool(state.visualization_suggestions)
        if state.intent == "dashboard_generation":
            has_minimum_evidence = has_minimum_evidence and (bool(state.dashboard_plan) or bool(state.dashboard_plan_evidence) or len(non_empty_queries) > 0)

        if state.intent == "dashboard_generation" and not state.dashboard_plan and not state.dashboard_plan_evidence:
            warnings.append("Dashboard intent sem plano final consolidado.")
            next_actions.append("Executar modo plan para consolidar narrativa e secoes do dashboard.")
        if state.intent == "visualization_help" and not state.visualization_suggestions:
            warnings.append("Intent de visualizacao sem sugestao final.")
            next_actions.append("Executar sugestao de visual com metrica/dimensao explicitas.")
        if state.intent == "diagnostic_analysis" and temporal_coverage_score == 0:
            limitations.append("Diagnostico sem comparacao temporal reduz capacidade explicativa.")
            next_actions.append("Adicionar corte temporal explicito para diagnostico de variacao.")
        if state.intent == "diagnostic_analysis" and dimensional_coverage_score == 0:
            limitations.append("Diagnostico sem quebra dimensional reduz capacidade de identificar contribuidores.")
            next_actions.append("Adicionar dimensoes candidatas para identificar contribuidores da queda.")

        scoring = BiEvidenceScoring(
            valid_queries_score=round(valid_queries_score, 2),
            diversity_score=round(diversity_score, 2),
            question_alignment_score=round(alignment_score, 2),
            temporal_coverage_score=round(temporal_coverage_score, 2),
            dimensional_coverage_score=round(dimensional_coverage_score, 2),
            risk_penalty=round(risk_penalty, 2),
            final_score=final_score,
        )
        dedup_next = list(dict.fromkeys(next_actions))
        dedup_warnings = list(dict.fromkeys(warnings))
        dedup_limitations = list(dict.fromkeys(limitations))
        return BICriticResult(
            confidence=final_score,
            has_minimum_evidence=has_minimum_evidence,
            warnings=dedup_warnings,
            next_best_actions=dedup_next,
            limitations=dedup_limitations,
            scoring=scoring,
        )
