from __future__ import annotations

import unicodedata
from dataclasses import dataclass

from app.modules.bi_agent.schemas import BiAgentIntent


@dataclass(frozen=True)
class IntentProfile:
    intent: BiAgentIntent
    keywords: tuple[str, ...]
    requires_temporal_default: bool = False
    requires_comparison_default: bool = False
    requires_diagnostic_default: bool = False
    requires_visualization_default: bool = False
    requires_dashboard_default: bool = False


INTENT_PROFILES: tuple[IntentProfile, ...] = (
    IntentProfile(
        intent="dashboard_generation",
        keywords=("dashboard", "painel", "montar", "monte", "executivo"),
        requires_dashboard_default=True,
    ),
    IntentProfile(
        intent="visualization_help",
        keywords=("melhor grafico", "visualizacao", "gráfico", "grafico", "chart"),
        requires_visualization_default=True,
    ),
    IntentProfile(
        intent="metric_explanation",
        keywords=("explique metrica", "explicar metrica", "explicar métrica", "me explique esta metrica"),
    ),
    IntentProfile(
        intent="diagnostic_analysis",
        keywords=("queda", "causa", "diagnostic", "explicar queda", "por que caiu", "o que explica"),
        requires_diagnostic_default=True,
        requires_comparison_default=True,
    ),
    IntentProfile(
        intent="kpi_summary",
        keywords=("kpi", "principais indicadores", "principais metricas", "principais métricas"),
    ),
)

TEMPORAL_HINTS = ("periodo", "tempo", "mensal", "semanal", "diario", "timeline", "historico", "tendencia", "evolucao")
COMPARISON_HINTS = ("comparar", "vs", "versus", "queda", "crescimento", "variacao", "diferenca")
DIAGNOSTIC_HINTS = ("causa", "explicar", "diagnostico", "queda", "por que", "contribuidor", "driver")
VISUAL_HINTS = ("grafico", "visual", "chart", "visualizacao", "plot")
DASHBOARD_HINTS = ("dashboard", "painel", "monte", "montar", "executivo")


def normalize_question(text: str) -> str:
    value = unicodedata.normalize("NFKD", (text or "").strip().lower())
    return "".join(char for char in value if not unicodedata.combining(char))


def classify_intent_by_taxonomy(question: str) -> BiAgentIntent:
    normalized = normalize_question(question)
    for profile in INTENT_PROFILES:
        if any(keyword in normalized for keyword in profile.keywords):
            return profile.intent
    return "exploratory_analysis"


def profile_for(intent: BiAgentIntent) -> IntentProfile | None:
    return next((item for item in INTENT_PROFILES if item.intent == intent), None)

