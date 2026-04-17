from __future__ import annotations

from app.modules.bi_agent.agent.intent_taxonomy import classify_intent_by_taxonomy, profile_for


def test_intent_taxonomy_classifies_dashboard() -> None:
    intent = classify_intent_by_taxonomy("Monte um dashboard executivo para vendas")
    assert intent == "dashboard_generation"


def test_intent_taxonomy_classifies_visualization() -> None:
    intent = classify_intent_by_taxonomy("Qual o melhor grafico para receita por categoria?")
    assert intent == "visualization_help"


def test_intent_profile_defaults_are_available() -> None:
    profile = profile_for("diagnostic_analysis")
    assert profile is not None
    assert profile.requires_diagnostic_default is True
    assert profile.requires_comparison_default is True

