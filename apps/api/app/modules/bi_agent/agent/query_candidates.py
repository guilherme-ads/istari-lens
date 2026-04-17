from __future__ import annotations

from typing import Any

from app.modules.bi_agent.schemas import BiQueryCandidate, BiQueryFilterSpec, BiQueryMetricSpec, BiQuerySortSpec, BiQuestionAnalysis


def _schema_fields(schema: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(schema, dict):
        return []
    fields = schema.get("fields")
    if not isinstance(fields, list):
        return []
    return [item for item in fields if isinstance(item, dict)]


def _pick_fields_by_type(schema_fields: list[dict[str, Any]], semantic_type: str) -> list[str]:
    items: list[str] = []
    for item in schema_fields:
        if str(item.get("semantic_type") or "").strip().lower() == semantic_type:
            name = item.get("name")
            if isinstance(name, str) and name.strip():
                items.append(name.strip())
    return items


def _semantic_columns(semantic_layer: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(semantic_layer, dict):
        return []
    columns = semantic_layer.get("semantic_columns")
    if not isinstance(columns, list):
        return []
    return [item for item in columns if isinstance(item, dict)]


def _unique_preserve(items: list[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = item.strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(item)
    return output


def _resolve_primary_metric(analysis: BiQuestionAnalysis, numeric_fields: list[str], metric_catalog: list[str]) -> str | None:
    for name in analysis.mentioned_metrics:
        if name in numeric_fields:
            return name
    for name in analysis.inferred_metrics:
        if name in numeric_fields:
            return name
    for name in metric_catalog:
        if name in numeric_fields:
            return name
    if numeric_fields:
        return numeric_fields[0]
    return None


def _resolve_primary_dimension(analysis: BiQuestionAnalysis, categorical_fields: list[str]) -> str | None:
    candidates = _unique_preserve([*analysis.mentioned_dimensions, *analysis.inferred_dimensions])
    for name in candidates:
        if name in categorical_fields:
            return name
    if categorical_fields:
        return categorical_fields[0]
    return None


def _resolve_temporal_field(temporal_fields: list[str], analysis: BiQuestionAnalysis) -> str | None:
    for name in _unique_preserve([*analysis.mentioned_dimensions, *analysis.inferred_dimensions]):
        if name in temporal_fields:
            return name
    if temporal_fields:
        return temporal_fields[0]
    return None


def generate_query_candidates(
    *,
    question_analysis: BiQuestionAnalysis,
    semantic_layer: dict[str, Any] | None,
    schema: dict[str, Any] | None,
    catalog: dict[str, Any] | None,
    max_candidates: int = 5,
) -> list[BiQueryCandidate]:
    schema_fields = _schema_fields(schema)
    semantic_columns = _semantic_columns(semantic_layer)
    numeric_fields = _unique_preserve(_pick_fields_by_type(schema_fields, "numeric") + _pick_fields_by_type(semantic_columns, "numeric"))
    temporal_fields = _unique_preserve(_pick_fields_by_type(schema_fields, "temporal") + _pick_fields_by_type(semantic_columns, "temporal"))
    categorical_fields = _unique_preserve(
        _pick_fields_by_type(schema_fields, "text")
        + _pick_fields_by_type(schema_fields, "boolean")
        + _pick_fields_by_type(semantic_columns, "text")
        + _pick_fields_by_type(semantic_columns, "boolean")
    )

    metric_catalog = []
    if isinstance(catalog, dict) and isinstance(catalog.get("metrics"), list):
        metric_catalog = [str(item.get("name")) for item in catalog["metrics"] if isinstance(item, dict) and isinstance(item.get("name"), str)]

    primary_metric = _resolve_primary_metric(question_analysis, numeric_fields=numeric_fields, metric_catalog=metric_catalog)
    primary_dimension = _resolve_primary_dimension(question_analysis, categorical_fields=categorical_fields)
    temporal_field = _resolve_temporal_field(temporal_fields=temporal_fields, analysis=question_analysis)

    agg = "sum" if primary_metric else "count"
    metric_field = primary_metric or (numeric_fields[0] if numeric_fields else (schema_fields[0]["name"] if schema_fields else "id"))
    candidates: list[BiQueryCandidate] = []
    shape = question_analysis.expected_answer_shape

    candidates.append(
        BiQueryCandidate(
            candidate_id="cand_overview",
            title="Visao Geral Agregada",
            hypothesis="A metrica principal resume o estado geral do dataset.",
            metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
            dimensions=[],
            filters=[],
            sort=[],
            limit=1,
            offset=0,
            priority=95 if shape in {"open_exploration", "dashboard_plan"} else 75,
            cost_score=15,
            tags=["overview", "cheap"],
        )
    )

    if primary_dimension and shape in {"single_best", "single_worst"}:
        direction = "desc" if shape == "single_best" else "asc"
        candidate_id = "cand_top_dimension" if shape == "single_best" else "cand_bottom_dimension"
        title = "Melhor Dimensao" if shape == "single_best" else "Pior Dimensao"
        hypothesis = (
            "Ranking dimensional identifica o melhor desempenho para a metrica alvo."
            if shape == "single_best"
            else "Ranking dimensional identifica o pior desempenho para a metrica alvo."
        )
        candidates.append(
            BiQueryCandidate(
                candidate_id=candidate_id,
                title=title,
                hypothesis=hypothesis,
                metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
                dimensions=[primary_dimension],
                filters=[],
                sort=[BiQuerySortSpec(field="m0", dir=direction)],
                limit=5,
                offset=0,
                priority=98,
                cost_score=18,
                tags=["ranking", "dimension", "answer_fit"],
            )
        )

    if temporal_field and (question_analysis.requires_temporal or question_analysis.intent in {"diagnostic_analysis", "dashboard_generation", "exploratory_analysis"}):
        candidates.append(
            BiQueryCandidate(
                candidate_id="cand_temporal_trend",
                title="Evolucao Temporal",
                hypothesis="A tendencia temporal ajuda a confirmar variacao ao longo do periodo.",
                metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
                dimensions=[temporal_field],
                filters=[],
                sort=[BiQuerySortSpec(field=temporal_field, dir="asc")],
                limit=50,
                offset=0,
                priority=92 if shape == "trend" else 90,
                cost_score=35,
                tags=["temporal", "trend"],
            )
        )

    if primary_dimension:
        candidates.append(
            BiQueryCandidate(
                candidate_id="cand_dimension_breakdown",
                title="Quebra por Dimensao",
                hypothesis="A dimensao principal pode explicar heterogeneidade dos resultados.",
                metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
                dimensions=[primary_dimension],
                filters=[],
                sort=[BiQuerySortSpec(field="m0", dir="desc")],
                limit=25,
                offset=0,
                priority=90 if shape in {"single_best", "single_worst", "drivers"} else 85,
                cost_score=30,
                tags=["dimension", "breakdown"],
            )
        )

    if temporal_field and primary_dimension and question_analysis.requires_comparison:
        candidates.append(
            BiQueryCandidate(
                candidate_id="cand_temporal_dimension",
                title="Comparacao Tempo x Dimensao",
                hypothesis="Comparar tempo e dimensao evidencia onde a variacao e mais intensa.",
                metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
                dimensions=[temporal_field, primary_dimension],
                filters=[],
                sort=[BiQuerySortSpec(field=temporal_field, dir="asc")],
                limit=80,
                offset=0,
                priority=93 if shape in {"comparison", "drivers"} else 82,
                cost_score=55,
                tags=["temporal", "comparison", "dimension"],
            )
        )

    if primary_dimension and question_analysis.requires_diagnostic:
        candidates.append(
            BiQueryCandidate(
                candidate_id="cand_top_contributors",
                title="Top Contribuidores",
                hypothesis="Ranking dimensional aponta contribuidores de queda/crescimento.",
                metrics=[BiQueryMetricSpec(field=metric_field, agg=agg)],
                dimensions=[primary_dimension],
                filters=[BiQueryFilterSpec(field=primary_dimension, op="not_null", value=None)],
                sort=[BiQuerySortSpec(field="m0", dir="desc")],
                limit=15,
                offset=0,
                priority=88,
                cost_score=28,
                tags=["diagnostic", "ranking"],
            )
        )

    ordered = sorted(candidates, key=lambda item: (-int(item.priority), int(item.cost_score), item.candidate_id))
    return ordered[: max(1, min(12, int(max_candidates)))]
