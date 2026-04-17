from __future__ import annotations

from dataclasses import dataclass, field

from app.modules.bi_agent.agent.semantic_normalization import (
    SemanticLabelIndex,
    resolve_field_label,
    resolve_field_semantic_type,
    resolve_metric_label,
    resolve_metric_unit,
)
from app.modules.bi_agent.agent.value_formatting import format_semantic_value
from app.modules.bi_agent.schemas import BiAgentIntent, BiAgentQueryEvidence, BiQueryCandidate, BiQuestionAnalysis


@dataclass
class RankedEvidence:
    query: BiAgentQueryEvidence
    score: float
    reasons: list[str] = field(default_factory=list)
    finding: str = ""


def rank_query_evidence(
    *,
    analysis: BiQuestionAnalysis | None,
    queries_executed: list[BiAgentQueryEvidence],
    query_candidates: list[BiQueryCandidate],
    label_index: SemanticLabelIndex,
    max_items: int = 5,
) -> list[RankedEvidence]:
    if len(queries_executed) == 0:
        return []

    candidate_by_id = {item.candidate_id: item for item in query_candidates}
    intent = analysis.intent if analysis is not None else "exploratory_analysis"
    seen_signatures: set[str] = set()
    ranked: list[RankedEvidence] = []

    for query in queries_executed:
        score = 0.0
        reasons: list[str] = []
        row_count = int(query.row_count)
        if row_count > 0:
            score += min(0.35, 0.12 + (0.03 * min(row_count, 8)))
            reasons.append("query_com_resultado")
        else:
            score -= 0.22
            reasons.append("query_sem_resultado")

        candidate = candidate_by_id.get(str(query.candidate_id or ""))
        if candidate is not None:
            score += max(0.0, min(0.2, float(candidate.priority) / 500.0))
            score -= max(0.0, min(0.12, float(candidate.cost_score) / 1000.0))

        if _aligns_with_intent(intent=intent, query=query):
            score += 0.2
            reasons.append("alinhada_com_intencao")

        if analysis is not None:
            alignment_bonus = _analysis_alignment_bonus(analysis=analysis, query=query)
            score += alignment_bonus
            if alignment_bonus > 0:
                reasons.append("alinhada_com_pergunta")
            answer_fit = _answer_fit_bonus(analysis=analysis, query=query)
            score += answer_fit
            if answer_fit > 0:
                reasons.append("answer_fit")
            interpretability = _interpretability_bonus(query=query)
            score += interpretability
            if interpretability > 0:
                reasons.append("interpretavel")

        signature = _query_signature(query)
        if signature in seen_signatures:
            score -= 0.22
            reasons.append("redundante")
        else:
            seen_signatures.add(signature)
            score += 0.08
            reasons.append("novidade")

        finding = _build_finding_text(query=query, label_index=label_index)
        ranked.append(RankedEvidence(query=query, score=round(score, 3), reasons=reasons, finding=finding))

    ordered = sorted(ranked, key=lambda item: (-float(item.score), -int(item.query.row_count), str(item.query.candidate_id or "")))
    return ordered[: max(1, min(10, int(max_items)))]


def _analysis_alignment_bonus(*, analysis: BiQuestionAnalysis, query: BiAgentQueryEvidence) -> float:
    bonus = 0.0
    query_dimensions = []
    query_metrics = []
    if isinstance(query.query_spec, dict):
        raw_dims = query.query_spec.get("dimensions")
        if isinstance(raw_dims, list):
            query_dimensions = [str(item).strip().lower() for item in raw_dims if isinstance(item, str) and item.strip()]
        raw_metrics = query.query_spec.get("metrics")
        if isinstance(raw_metrics, list):
            for metric in raw_metrics:
                if isinstance(metric, dict):
                    field = metric.get("field")
                    if isinstance(field, str) and field.strip():
                        query_metrics.append(field.strip().lower())

    mentioned_metrics = {item.strip().lower() for item in [*analysis.mentioned_metrics, *analysis.inferred_metrics] if item.strip()}
    mentioned_dimensions = {item.strip().lower() for item in [*analysis.mentioned_dimensions, *analysis.inferred_dimensions] if item.strip()}

    if mentioned_metrics and any(item in mentioned_metrics for item in query_metrics):
        bonus += 0.12
    if mentioned_dimensions and any(item in mentioned_dimensions for item in query_dimensions):
        bonus += 0.12
    if analysis.requires_temporal and any(_looks_temporal(item) for item in query_dimensions):
        bonus += 0.08
    if analysis.requires_comparison and len(query_dimensions) >= 2:
        bonus += 0.06
    return min(0.28, bonus)


def _answer_fit_bonus(*, analysis: BiQuestionAnalysis, query: BiAgentQueryEvidence) -> float:
    candidate_id = str(query.candidate_id or "")
    shape = analysis.expected_answer_shape
    if shape == "single_best":
        if candidate_id == "cand_top_dimension":
            return 0.24
        if candidate_id == "cand_dimension_breakdown":
            return 0.12
        return -0.04
    if shape == "single_worst":
        if candidate_id == "cand_bottom_dimension":
            return 0.24
        if candidate_id == "cand_dimension_breakdown":
            return 0.12
        return -0.04
    if shape == "trend":
        return 0.2 if candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"} else -0.04
    if shape == "comparison":
        return 0.2 if candidate_id in {"cand_temporal_dimension", "cand_dimension_breakdown"} else -0.04
    if shape == "drivers":
        return 0.2 if candidate_id in {"cand_top_contributors", "cand_dimension_breakdown", "cand_temporal_dimension"} else -0.04
    if shape == "definition":
        return 0.16 if candidate_id == "cand_overview" else 0.0
    return 0.0


def _interpretability_bonus(*, query: BiAgentQueryEvidence) -> float:
    if int(query.row_count) <= 0:
        return 0.0
    if int(query.row_count) <= 20:
        return 0.08
    if int(query.row_count) <= 80:
        return 0.04
    return 0.0


def _aligns_with_intent(*, intent: BiAgentIntent | str, query: BiAgentQueryEvidence) -> bool:
    candidate_id = str(query.candidate_id or "")
    if intent == "kpi_summary":
        return candidate_id in {"cand_overview", "cand_temporal_trend", "cand_top_dimension", "cand_bottom_dimension"}
    if intent == "diagnostic_analysis":
        return candidate_id in {"cand_temporal_trend", "cand_dimension_breakdown", "cand_top_contributors", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}
    if intent == "dashboard_generation":
        return candidate_id in {"cand_overview", "cand_temporal_trend", "cand_dimension_breakdown", "cand_top_dimension"}
    if intent == "visualization_help":
        return candidate_id in {"cand_dimension_breakdown", "cand_temporal_trend", "cand_temporal_dimension", "cand_top_dimension", "cand_bottom_dimension"}
    return candidate_id in {"cand_overview", "cand_temporal_trend", "cand_dimension_breakdown", "cand_top_dimension", "cand_bottom_dimension"}


def _query_signature(query: BiAgentQueryEvidence) -> str:
    if not isinstance(query.query_spec, dict):
        return str(query.candidate_id or "query")
    metrics = query.query_spec.get("metrics")
    dimensions = query.query_spec.get("dimensions")
    metric_sig = ",".join(
        sorted(
            f"{str(item.get('agg') or '').strip().lower()}:{str(item.get('field') or '').strip().lower()}"
            for item in metrics
            if isinstance(item, dict)
        )
    ) if isinstance(metrics, list) else ""
    dimension_sig = ",".join(sorted(str(item).strip().lower() for item in dimensions if isinstance(item, str))) if isinstance(dimensions, list) else ""
    return f"{metric_sig}|{dimension_sig}"


def _build_finding_text(*, query: BiAgentQueryEvidence, label_index: SemanticLabelIndex) -> str:
    title = str(query.candidate_title or query.candidate_id or "Analise")
    if not query.rows_preview:
        return f"{title}: consulta executada sem linhas de resultado."

    first_row = next((item for item in query.rows_preview if isinstance(item, dict)), {})
    if not first_row:
        return f"{title}: consulta executada com resultado parcial."

    metric_specs: list[tuple[str, str]] = []
    if isinstance(query.query_spec, dict):
        raw_metrics = query.query_spec.get("metrics")
        if isinstance(raw_metrics, list):
            for item in raw_metrics:
                if not isinstance(item, dict):
                    continue
                field = str(item.get("field") or "").strip()
                agg = str(item.get("agg") or "").strip().lower()
                if field:
                    metric_specs.append((field, agg))

    parts: list[str] = []
    for key, value in list(first_row.items())[:3]:
        label, semantic_type, unit = _label_and_format_context_for_row_key(
            key=str(key),
            metric_specs=metric_specs,
            label_index=label_index,
        )
        rendered_value = format_semantic_value(value, semantic_type=semantic_type, unit=unit)
        parts.append(f"{label} = {rendered_value}")
    return f"{title}: " + "; ".join(parts) + "."


def _label_and_format_context_for_row_key(
    *,
    key: str,
    metric_specs: list[tuple[str, str]],
    label_index: SemanticLabelIndex,
) -> tuple[str, str | None, str | None]:
    normalized_key = str(key or "").strip().lower()
    if normalized_key.startswith("m") and normalized_key[1:].isdigit():
        idx = int(normalized_key[1:])
        if 0 <= idx < len(metric_specs):
            field, agg = metric_specs[idx]
            return (
                resolve_metric_label(index=label_index, field_name=field, agg=agg),
                resolve_field_semantic_type(label_index, field),
                resolve_metric_unit(label_index, field),
            )
        return "Metrica agregada", None, None
    return (
        resolve_field_label(label_index, key),
        resolve_field_semantic_type(label_index, key),
        None,
    )


def _looks_temporal(field_name: str) -> bool:
    text = str(field_name or "").strip().lower()
    return any(token in text for token in ("date", "data", "tempo", "period", "month", "ano", "year"))
