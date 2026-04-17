from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from app.modules.bi_agent.agent.evidence_selection import RankedEvidence
from app.modules.bi_agent.agent.semantic_normalization import (
    SemanticLabelIndex,
    resolve_field_label,
    resolve_field_semantic_type,
    resolve_metric_label,
    resolve_metric_unit,
)
from app.modules.bi_agent.agent.value_formatting import format_semantic_value
from app.modules.bi_agent.schemas import BiAgentQueryEvidence, BiInterpretedAnswer, BiQuestionAnalysis


def interpret_query_results(
    *,
    analysis: BiQuestionAnalysis | None,
    ranked_evidence: list[RankedEvidence],
    queries_executed: list[BiAgentQueryEvidence],
    label_index: SemanticLabelIndex,
) -> BiInterpretedAnswer:
    if analysis is None:
        return _insufficient("Analise da pergunta nao disponivel para interpretar resultados.")

    non_empty = [item for item in queries_executed if int(item.row_count) > 0]
    if not non_empty:
        if analysis.should_request_refinement:
            return BiInterpretedAnswer(
                answer_type="needs_clarification",
                response_status_hint="needs_clarification",
                direct_answer=None,
                supporting_facts=[],
                caveats=["A pergunta ainda esta ambigua e as consultas nao trouxeram sinal suficiente."],
                recommended_next_step="Refine a pergunta informando metrica, periodo e dimensao alvo.",
            )
        return _insufficient("As consultas executadas nao retornaram evidencias suficientes.")

    shape = analysis.expected_answer_shape
    if shape == "single_best":
        return _interpret_dimension_extreme(
            preferred_candidate_ids=["cand_top_dimension", "cand_dimension_breakdown", "cand_top_contributors"],
            ranked_evidence=ranked_evidence,
            fallback_queries=non_empty,
            label_index=label_index,
            is_best=True,
        )
    if shape == "single_worst":
        return _interpret_dimension_extreme(
            preferred_candidate_ids=["cand_bottom_dimension", "cand_dimension_breakdown", "cand_top_contributors"],
            ranked_evidence=ranked_evidence,
            fallback_queries=non_empty,
            label_index=label_index,
            is_best=False,
        )
    if shape == "trend":
        return _interpret_trend(
            preferred_candidate_ids=["cand_temporal_trend", "cand_temporal_dimension"],
            ranked_evidence=ranked_evidence,
            fallback_queries=non_empty,
            label_index=label_index,
        )
    if shape == "comparison":
        return _interpret_comparison(
            preferred_candidate_ids=["cand_temporal_dimension", "cand_dimension_breakdown"],
            ranked_evidence=ranked_evidence,
            fallback_queries=non_empty,
            label_index=label_index,
        )
    if shape == "drivers":
        return _interpret_drivers(
            preferred_candidate_ids=["cand_top_contributors", "cand_dimension_breakdown", "cand_temporal_dimension"],
            ranked_evidence=ranked_evidence,
            fallback_queries=non_empty,
            label_index=label_index,
        )
    if shape == "definition":
        top = ranked_evidence[0] if ranked_evidence else None
        if top and top.finding:
            return BiInterpretedAnswer(
                answer_type="definition",
                response_status_hint="answered",
                selected_candidate_id=top.query.candidate_id,
                direct_answer=top.finding,
                supporting_facts=_supporting_facts_from_ranked(ranked_evidence),
                caveats=[],
                recommended_next_step="Se quiser, posso trazer um exemplo por periodo ou categoria.",
            )
        return _insufficient("Nao encontrei evidencias para explicar a metrica com seguranca.")

    top_ranked = ranked_evidence[0] if ranked_evidence else None
    if top_ranked is None:
        return _insufficient("As evidencias coletadas nao foram suficientes para uma resposta objetiva.")
    return BiInterpretedAnswer(
        answer_type="comparison_summary",
        response_status_hint="answered",
        selected_candidate_id=top_ranked.query.candidate_id,
        direct_answer=top_ranked.finding or "Identifiquei um sinal inicial, mas ainda recomendo aprofundar por recorte.",
        supporting_facts=_supporting_facts_from_ranked(ranked_evidence),
        caveats=[],
        recommended_next_step="Escolha um recorte (periodo ou dimensao) para aprofundar a leitura.",
    )


def _interpret_dimension_extreme(
    *,
    preferred_candidate_ids: list[str],
    ranked_evidence: list[RankedEvidence],
    fallback_queries: list[BiAgentQueryEvidence],
    label_index: SemanticLabelIndex,
    is_best: bool,
) -> BiInterpretedAnswer:
    selected = _select_query(
        preferred_candidate_ids=preferred_candidate_ids,
        ranked_evidence=ranked_evidence,
        fallback_queries=fallback_queries,
    )
    if selected is None:
        return _insufficient("Nao foi encontrada query dimensional para responder a pergunta.")

    candidate_id, query = selected
    metric_spec = _metric_spec(query)
    metric_alias = metric_spec["alias"]
    dimension_field = _primary_dimension_field(query=query, label_index=label_index)
    rows = [item for item in query.rows_preview if isinstance(item, dict)]
    if not rows:
        return _insufficient("A query dimensional retornou sem linhas para interpretar.")

    ordered_rows = sorted(rows, key=lambda row: _safe_decimal(row.get(metric_alias)), reverse=is_best)
    top_row = ordered_rows[0]
    dimension_value = _dimension_value(row=top_row, query=query, fallback_metric_alias=metric_alias)
    metric_value = _render_metric_value(metric_spec=metric_spec, value=top_row.get(metric_alias), label_index=label_index)
    metric_label = resolve_metric_label(index=label_index, field_name=metric_spec["field"], agg=metric_spec["agg"])

    if dimension_value:
        qualifier = "maior" if is_best else "menor"
        direct = f"{dimension_value} aparece com {qualifier} {metric_label}: {metric_value}."
    else:
        qualifier = "maior" if is_best else "menor"
        direct = f"O {qualifier} valor de {metric_label} observado foi {metric_value}."

    supporting = [f"Baseado em {int(query.row_count)} linhas na query '{query.candidate_title or candidate_id}'."]
    if len(ordered_rows) >= 2:
        second = ordered_rows[1]
        second_dim = _dimension_value(row=second, query=query, fallback_metric_alias=metric_alias)
        second_value = _render_metric_value(metric_spec=metric_spec, value=second.get(metric_alias), label_index=label_index)
        if second_dim:
            supporting.append(f"Na sequencia aparece {second_dim} com {metric_label} de {second_value}.")

    return BiInterpretedAnswer(
        answer_type="top_dimension" if is_best else "bottom_dimension",
        response_status_hint="answered",
        selected_candidate_id=candidate_id,
        direct_answer=direct,
        supporting_facts=supporting,
        caveats=[],
        recommended_next_step=f"Quer que eu detalhe o ranking completo por {dimension_field}?",
    )


def _interpret_trend(
    *,
    preferred_candidate_ids: list[str],
    ranked_evidence: list[RankedEvidence],
    fallback_queries: list[BiAgentQueryEvidence],
    label_index: SemanticLabelIndex,
) -> BiInterpretedAnswer:
    selected = _select_query(
        preferred_candidate_ids=preferred_candidate_ids,
        ranked_evidence=ranked_evidence,
        fallback_queries=fallback_queries,
    )
    if selected is None:
        return _insufficient("Nao foi encontrada query temporal para avaliar tendencia.")

    candidate_id, query = selected
    rows = [item for item in query.rows_preview if isinstance(item, dict)]
    if len(rows) < 2:
        return _insufficient("A serie temporal retornou poucas linhas para inferir tendencia.")

    metric_spec = _metric_spec(query)
    metric_alias = metric_spec["alias"]
    temporal_field = _temporal_dimension_field(query=query, label_index=label_index)
    first_row = rows[0]
    last_row = rows[-1]

    start_value_raw = _safe_decimal(first_row.get(metric_alias))
    end_value_raw = _safe_decimal(last_row.get(metric_alias))

    start_value = _render_metric_value(metric_spec=metric_spec, value=first_row.get(metric_alias), label_index=label_index)
    end_value = _render_metric_value(metric_spec=metric_spec, value=last_row.get(metric_alias), label_index=label_index)
    metric_label = resolve_metric_label(index=label_index, field_name=metric_spec["field"], agg=metric_spec["agg"])
    start_period = _render_dimension_value(first_row.get(temporal_field), field_name=temporal_field, label_index=label_index)
    end_period = _render_dimension_value(last_row.get(temporal_field), field_name=temporal_field, label_index=label_index)

    if start_value_raw == 0:
        change_pct = None
    else:
        change_pct = ((end_value_raw - start_value_raw) / abs(start_value_raw)) * Decimal("100")

    if change_pct is None:
        trend_label = "variacao"
    elif change_pct >= Decimal("3"):
        trend_label = "alta"
    elif change_pct <= Decimal("-3"):
        trend_label = "queda"
    else:
        trend_label = "estabilidade"

    direct = (
        f"A tendencia observada e de {trend_label}: {metric_label} foi de {start_value} "
        f"para {end_value} entre {start_period} e {end_period}."
    )
    supporting = [f"Serie analisada com {len(rows)} pontos temporais."]
    if change_pct is not None:
        pct_rendered = format_semantic_value(change_pct, semantic_type="percent", unit="%")
        supporting.append(f"Variacao aproximada no periodo: {pct_rendered}.")

    return BiInterpretedAnswer(
        answer_type="trend_summary",
        response_status_hint="answered",
        selected_candidate_id=candidate_id,
        direct_answer=direct,
        supporting_facts=supporting,
        caveats=[],
        recommended_next_step="Quer que eu destaque os periodos com maior variacao?",
    )


def _interpret_comparison(
    *,
    preferred_candidate_ids: list[str],
    ranked_evidence: list[RankedEvidence],
    fallback_queries: list[BiAgentQueryEvidence],
    label_index: SemanticLabelIndex,
) -> BiInterpretedAnswer:
    selected = _select_query(
        preferred_candidate_ids=preferred_candidate_ids,
        ranked_evidence=ranked_evidence,
        fallback_queries=fallback_queries,
    )
    if selected is None:
        return _insufficient("Nao foi encontrada query de comparacao com qualidade suficiente.")

    candidate_id, query = selected
    rows = [item for item in query.rows_preview if isinstance(item, dict)]
    metric_spec = _metric_spec(query)
    metric_alias = metric_spec["alias"]
    if len(rows) < 2:
        return _insufficient("A comparacao retornou menos de duas linhas validas.")

    ordered_rows = sorted(rows, key=lambda row: _safe_decimal(row.get(metric_alias)), reverse=True)
    first = ordered_rows[0]
    second = ordered_rows[1]
    dimension_field = _primary_dimension_field(query=query, label_index=label_index)
    metric_label = resolve_metric_label(index=label_index, field_name=metric_spec["field"], agg=metric_spec["agg"])
    first_name = _dimension_value(row=first, query=query, fallback_metric_alias=metric_alias) or "primeiro grupo"
    second_name = _dimension_value(row=second, query=query, fallback_metric_alias=metric_alias) or "segundo grupo"

    first_raw = _safe_decimal(first.get(metric_alias)) or Decimal("0")
    second_raw = _safe_decimal(second.get(metric_alias)) or Decimal("0")
    delta_raw = first_raw - second_raw
    if second_raw == 0:
        delta_pct = None
    else:
        delta_pct = (delta_raw / abs(second_raw)) * Decimal("100")

    first_value = _render_metric_value(metric_spec=metric_spec, value=first.get(metric_alias), label_index=label_index)
    second_value = _render_metric_value(metric_spec=metric_spec, value=second.get(metric_alias), label_index=label_index)
    delta_value = _render_metric_value(metric_spec=metric_spec, value=delta_raw, label_index=label_index)

    if delta_pct is None:
        direct = f"{first_name} supera {second_name} em {metric_label}: {first_value} contra {second_value}."
    else:
        delta_pct_rendered = format_semantic_value(delta_pct, semantic_type="percent", unit="%")
        direct = (
            f"{first_name} supera {second_name} em {metric_label}: {first_value} contra {second_value} "
            f"(diferenca de {delta_value}, {delta_pct_rendered})."
        )

    return BiInterpretedAnswer(
        answer_type="comparison_summary",
        response_status_hint="answered",
        selected_candidate_id=candidate_id,
        direct_answer=direct,
        supporting_facts=[
            f"Comparacao baseada na dimensao {dimension_field}.",
            f"Query utilizada: '{query.candidate_title or candidate_id}' com {int(query.row_count)} linhas.",
        ],
        caveats=[],
        recommended_next_step=f"Quer comparar mais grupos dentro de {dimension_field}?",
    )


def _interpret_drivers(
    *,
    preferred_candidate_ids: list[str],
    ranked_evidence: list[RankedEvidence],
    fallback_queries: list[BiAgentQueryEvidence],
    label_index: SemanticLabelIndex,
) -> BiInterpretedAnswer:
    selected = _select_query(
        preferred_candidate_ids=preferred_candidate_ids,
        ranked_evidence=ranked_evidence,
        fallback_queries=fallback_queries,
    )
    if selected is None:
        return _insufficient("Nao foi encontrada evidencia dimensional para identificar drivers.")

    candidate_id, query = selected
    rows = [item for item in query.rows_preview if isinstance(item, dict)]
    metric_spec = _metric_spec(query)
    metric_alias = metric_spec["alias"]
    if not rows:
        return _insufficient("A query de drivers retornou sem linhas para interpretacao.")

    ordered_rows = sorted(rows, key=lambda row: _safe_decimal(row.get(metric_alias)), reverse=True)
    top_names: list[str] = []
    top_points: list[str] = []
    for row in ordered_rows[:2]:
        name = _dimension_value(row=row, query=query, fallback_metric_alias=metric_alias)
        if not name:
            continue
        value = _render_metric_value(metric_spec=metric_spec, value=row.get(metric_alias), label_index=label_index)
        top_names.append(name)
        top_points.append(f"{name}: {value}")

    metric_label = resolve_metric_label(index=label_index, field_name=metric_spec["field"], agg=metric_spec["agg"])
    if top_names:
        drivers_text = " e ".join(top_names[:2]) if len(top_names) >= 2 else top_names[0]
        direct = f"Os principais drivers observados foram {drivers_text}, considerando {metric_label}."
    else:
        direct = f"Foi observada concentracao em poucos grupos para {metric_label}."

    caveats = ["Leitura diagnostica e correlacional; nao implica causalidade direta."]
    return BiInterpretedAnswer(
        answer_type="drivers_summary",
        response_status_hint="answered",
        selected_candidate_id=candidate_id,
        direct_answer=direct,
        supporting_facts=top_points[:2] or [f"Query '{query.candidate_title or candidate_id}' com {int(query.row_count)} linhas."],
        caveats=caveats,
        recommended_next_step="Quer que eu detalhe os drivers por periodo para validar consistencia?",
    )


def _insufficient(message: str) -> BiInterpretedAnswer:
    return BiInterpretedAnswer(
        answer_type="insufficient_evidence",
        response_status_hint="insufficient_evidence",
        direct_answer=None,
        supporting_facts=[],
        caveats=[message],
        recommended_next_step="Refine o recorte da pergunta para coletarmos evidencia suficiente.",
    )


def _select_query(
    *,
    preferred_candidate_ids: list[str],
    ranked_evidence: list[RankedEvidence],
    fallback_queries: list[BiAgentQueryEvidence],
) -> tuple[str, BiAgentQueryEvidence] | None:
    for candidate_id in preferred_candidate_ids:
        ranked = next(
            (
                item
                for item in ranked_evidence
                if str(item.query.candidate_id or "") == candidate_id and int(item.query.row_count) > 0
            ),
            None,
        )
        if ranked is not None:
            return candidate_id, ranked.query
    for query in fallback_queries:
        candidate_id = str(query.candidate_id or "")
        if candidate_id in preferred_candidate_ids:
            return candidate_id, query
    if fallback_queries:
        first = fallback_queries[0]
        return str(first.candidate_id or "query"), first
    return None


def _metric_spec(query: BiAgentQueryEvidence) -> dict[str, str]:
    metrics = query.query_spec.get("metrics") if isinstance(query.query_spec, dict) else None
    if isinstance(metrics, list):
        for index, item in enumerate(metrics):
            if not isinstance(item, dict):
                continue
            field = str(item.get("field") or "").strip()
            if not field:
                continue
            agg = str(item.get("agg") or "sum").strip().lower() or "sum"
            alias = str(item.get("alias") or "").strip() or f"m{index}"
            return {"field": field, "agg": agg, "alias": alias}
    return {"field": "valor", "agg": "sum", "alias": "m0"}


def _primary_dimension_field(*, query: BiAgentQueryEvidence, label_index: SemanticLabelIndex) -> str:
    dimensions = query.query_spec.get("dimensions") if isinstance(query.query_spec, dict) else None
    if isinstance(dimensions, list):
        for dim in dimensions:
            if isinstance(dim, str) and dim.strip() and resolve_field_semantic_type(label_index, dim) != "temporal":
                return resolve_field_label(label_index, dim)
        for dim in dimensions:
            if isinstance(dim, str) and dim.strip():
                return resolve_field_label(label_index, dim)
    return "dimensao"


def _temporal_dimension_field(*, query: BiAgentQueryEvidence, label_index: SemanticLabelIndex) -> str:
    dimensions = query.query_spec.get("dimensions") if isinstance(query.query_spec, dict) else None
    if isinstance(dimensions, list):
        for dim in dimensions:
            if isinstance(dim, str) and dim.strip() and resolve_field_semantic_type(label_index, dim) == "temporal":
                return dim
        for dim in dimensions:
            if isinstance(dim, str) and dim.strip():
                return dim
    return "periodo"


def _dimension_value(*, row: dict[str, Any], query: BiAgentQueryEvidence, fallback_metric_alias: str) -> str | None:
    dimensions = query.query_spec.get("dimensions") if isinstance(query.query_spec, dict) else None
    if isinstance(dimensions, list):
        for dim in dimensions:
            if not isinstance(dim, str) or not dim.strip():
                continue
            value = row.get(dim)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
    for key, value in row.items():
        if str(key).lower() == str(fallback_metric_alias).lower():
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _render_metric_value(*, metric_spec: dict[str, str], value: Any, label_index: SemanticLabelIndex) -> str:
    semantic_type = resolve_field_semantic_type(label_index, metric_spec["field"])
    unit = resolve_metric_unit(label_index, metric_spec["field"])
    return format_semantic_value(value, semantic_type=semantic_type, unit=unit)


def _render_dimension_value(*, value: Any, field_name: str, label_index: SemanticLabelIndex) -> str:
    semantic_type = resolve_field_semantic_type(label_index, field_name)
    return format_semantic_value(value, semantic_type=semantic_type, unit=None)


def _safe_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _supporting_facts_from_ranked(ranked_evidence: list[RankedEvidence]) -> list[str]:
    facts: list[str] = []
    for item in ranked_evidence[:2]:
        finding = str(item.finding or "").strip()
        if finding:
            facts.append(finding)
    return facts
