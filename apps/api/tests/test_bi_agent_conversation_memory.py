from __future__ import annotations

from app.modules.bi_agent.agent.conversation_memory import resolve_question_with_memory
from app.modules.bi_agent.schemas import BiConversationTurn


def test_conversation_memory_not_applied_without_history() -> None:
    memory = resolve_question_with_memory(
        question="Quais sao os principais KPIs?",
        conversation_history=[],
        catalog=None,
    )
    assert memory.applied is False
    assert memory.original_question == "Quais sao os principais KPIs?"
    assert memory.resolved_question == "Quais sao os principais KPIs?"


def test_conversation_memory_applies_referential_context() -> None:
    memory = resolve_question_with_memory(
        question="E por periodo?",
        conversation_history=[
            BiConversationTurn(role="user", content="Quais sao os principais KPIs deste dataset?"),
            BiConversationTurn(role="assistant", content="Os principais KPIs sao Receita Total e Volume."),
        ],
        catalog={"metrics": [{"name": "receita_total"}], "dimensions": [{"name": "periodo"}]},
    )
    assert memory.applied is True
    assert "Contexto de memoria curta" in memory.resolved_question
    assert "previous_user_question" in memory.references_used


def test_conversation_memory_infers_metric_reference() -> None:
    memory = resolve_question_with_memory(
        question="Essa metrica caiu?",
        conversation_history=[
            BiConversationTurn(role="user", content="Analise receita_total por categoria"),
            BiConversationTurn(role="assistant", content="Receita Total caiu no segmento B."),
        ],
        catalog={"metrics": [{"name": "receita_total"}], "dimensions": [{"name": "categoria"}]},
    )
    assert memory.applied is True
    assert memory.inferred_metric is not None
    assert "Metrica de referencia" in memory.resolved_question

