from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.modules.bi_agent.agent.intent_taxonomy import (
    COMPARISON_HINTS,
    DASHBOARD_HINTS,
    DIAGNOSTIC_HINTS,
    TEMPORAL_HINTS,
    VISUAL_HINTS,
    profile_for,
)
from app.modules.bi_agent.schemas import BiAgentAmbiguityItem, BiAgentIntent, BiExpectedAnswerShape, BiQuestionAnalysis
from app.modules.bi_agent.agent.intents import classify_intent

_BEST_HINTS = ("mais ", "maior", "melhor", "preferida", "preferido", "querida", "top ")
_WORST_HINTS = ("menos ", "menor", "pior", "ultimo")


def _normalize(text: str) -> str:
    value = unicodedata.normalize("NFKD", (text or "").strip().lower())
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", value)


def _catalog_metric_names(catalog: dict[str, Any] | None) -> list[str]:
    if not isinstance(catalog, dict):
        return []
    items = catalog.get("metrics")
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
        synonyms = item.get("synonyms")
        if isinstance(synonyms, list):
            for synonym in synonyms:
                if isinstance(synonym, str) and synonym.strip():
                    names.append(synonym.strip())
    return sorted(set(names), key=lambda value: value.lower())


def _catalog_dimension_names(catalog: dict[str, Any] | None) -> list[str]:
    if not isinstance(catalog, dict):
        return []
    items = catalog.get("dimensions")
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
        synonyms = item.get("synonyms")
        if isinstance(synonyms, list):
            for synonym in synonyms:
                if isinstance(synonym, str) and synonym.strip():
                    names.append(synonym.strip())
    return sorted(set(names), key=lambda value: value.lower())


def _schema_field_names(schema: dict[str, Any] | None) -> list[str]:
    if not isinstance(schema, dict):
        return []
    items = schema.get("fields")
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return sorted(set(names), key=lambda value: value.lower())


def _extract_mentions(question: str, candidates: list[str]) -> list[str]:
    text = _normalize(question)
    hits: list[str] = []
    for item in candidates:
        token = _normalize(item)
        if token and token in text:
            hits.append(item)
    return sorted(set(hits), key=lambda value: value.lower())


def _detect_expected_answer_shape(
    *,
    normalized_question: str,
    intent: BiAgentIntent,
) -> BiExpectedAnswerShape:
    if intent == "metric_explanation":
        return "definition"
    if intent == "dashboard_generation":
        return "dashboard_plan"
    if any(token in normalized_question for token in _BEST_HINTS):
        return "single_best"
    if any(token in normalized_question for token in _WORST_HINTS):
        return "single_worst"
    if any(token in normalized_question for token in COMPARISON_HINTS):
        return "comparison"
    if any(token in normalized_question for token in DIAGNOSTIC_HINTS):
        return "drivers"
    if any(token in normalized_question for token in TEMPORAL_HINTS):
        return "trend"
    return "open_exploration"


def analyze_question(
    *,
    question: str,
    semantic_layer: dict[str, Any] | None,
    schema: dict[str, Any] | None,
    catalog: dict[str, Any] | None,
    intent_override: BiAgentIntent | None = None,
) -> BiQuestionAnalysis:
    normalized_question = _normalize(question)
    intent = intent_override or classify_intent(question)
    metric_candidates = _catalog_metric_names(catalog)
    dimension_candidates = _catalog_dimension_names(catalog)
    schema_fields = _schema_field_names(schema)

    mentioned_metrics = _extract_mentions(question, metric_candidates + schema_fields)
    mentioned_dimensions = _extract_mentions(question, dimension_candidates + schema_fields)

    intent_profile = profile_for(intent)
    requires_temporal = any(token in normalized_question for token in TEMPORAL_HINTS) or bool(intent_profile and intent_profile.requires_temporal_default)
    requires_comparison = any(token in normalized_question for token in COMPARISON_HINTS) or bool(intent_profile and intent_profile.requires_comparison_default)
    requires_diagnostic = any(token in normalized_question for token in DIAGNOSTIC_HINTS) or bool(intent_profile and intent_profile.requires_diagnostic_default)
    requires_visualization = any(token in normalized_question for token in VISUAL_HINTS) or bool(intent_profile and intent_profile.requires_visualization_default)
    requires_dashboard = any(token in normalized_question for token in DASHBOARD_HINTS) or bool(intent_profile and intent_profile.requires_dashboard_default)
    expected_answer_shape = _detect_expected_answer_shape(
        normalized_question=normalized_question,
        intent=intent,
    )

    inferred_metrics: list[str] = []
    inferred_dimensions: list[str] = []
    assumptions: list[str] = []
    ambiguities: list[BiAgentAmbiguityItem] = []
    low_resolution_shapes: set[BiExpectedAnswerShape] = {"single_best", "single_worst", "comparison", "drivers"}

    if len(mentioned_metrics) == 0 and metric_candidates:
        if expected_answer_shape in low_resolution_shapes:
            ambiguities.append(
                BiAgentAmbiguityItem(
                    code="missing_metric_reference",
                    description="Pergunta nao cita metrica explicitamente para responder com confianca.",
                    alternatives=metric_candidates[:5],
                    suggested_refinement="Indique qual metrica deseja analisar (ex.: receita_total, margem, volume).",
                )
            )
        else:
            inferred_metrics.append(metric_candidates[0])
            assumptions.append(f"Metrica principal inferida como '{metric_candidates[0]}' por ausencia de metrica explicita.")

    requires_dimension_for_shape = expected_answer_shape in {"single_best", "single_worst", "comparison", "drivers"}
    if (requires_diagnostic or requires_dimension_for_shape) and len(mentioned_dimensions) == 0 and dimension_candidates:
        inferred_dimensions.extend(dimension_candidates[:2])
        assumptions.append("Dimensoes inferidas por ausencia de eixo explicativo explicito.")
        ambiguities.append(
            BiAgentAmbiguityItem(
                code="missing_dimension_reference",
                description="Pergunta sem dimensao explicita pode gerar leituras alternativas.",
                alternatives=dimension_candidates[:5],
                suggested_refinement="Informe qual eixo deseja investigar (ex.: canal, produto, regiao).",
            )
        )

    schema_has_temporal = any(
        "temporal" == str(item.get("semantic_type", "")).lower()
        for item in (schema or {}).get("fields", [])
        if isinstance(item, dict)
    )
    semantic_has_temporal = any(
        "temporal" == str(item.get("type", "")).lower()
        for item in (semantic_layer or {}).get("semantic_columns", [])
        if isinstance(item, dict)
    )
    if requires_temporal and not (schema_has_temporal or semantic_has_temporal):
        ambiguities.append(
            BiAgentAmbiguityItem(
                code="temporal_signal_without_temporal_field",
                description="Pergunta sugere analise temporal, mas schema pode nao conter campo temporal valido.",
                alternatives=[],
                suggested_refinement="Confirme qual coluna representa tempo para a analise.",
            )
        )

    word_count = len([token for token in normalized_question.split(" ") if token])
    if word_count <= 3:
        ambiguities.append(
            BiAgentAmbiguityItem(
                code="underspecified_question",
                description="Pergunta curta demais para identificar objetivo analitico com seguranca.",
                alternatives=[],
                suggested_refinement="Descreva metrica, periodo ou dimensao desejada para direcionar a analise.",
            )
        )

    ambiguity_level = "low"
    if len(ambiguities) > 1 or word_count <= 3:
        ambiguity_level = "high"
    elif len(ambiguities) == 1 or word_count <= 5:
        ambiguity_level = "medium"

    if len(mentioned_metrics) == 0 and len(mentioned_dimensions) == 0 and len(metric_candidates) == 0 and len(dimension_candidates) == 0:
        ambiguities.append(
            BiAgentAmbiguityItem(
                code="low_semantic_signal",
                description="Nao foi possivel mapear metricas/dimensoes pela pergunta e catalogo.",
                alternatives=[],
                suggested_refinement="Descreva metrica e dimensao desejadas para direcionar a analise.",
            )
        )
        ambiguity_level = "high"

    should_request_refinement = ambiguity_level == "high"
    return BiQuestionAnalysis(
        intent=intent,
        expected_answer_shape=expected_answer_shape,
        mentioned_metrics=mentioned_metrics,
        inferred_metrics=inferred_metrics,
        mentioned_dimensions=mentioned_dimensions,
        inferred_dimensions=inferred_dimensions,
        requires_temporal=requires_temporal,
        requires_comparison=requires_comparison,
        requires_diagnostic=requires_diagnostic,
        requires_visualization=requires_visualization,
        requires_dashboard=requires_dashboard,
        ambiguity_level=ambiguity_level,  # type: ignore[arg-type]
        should_request_refinement=should_request_refinement,
        assumptions=assumptions,
        ambiguities=ambiguities,
    )
