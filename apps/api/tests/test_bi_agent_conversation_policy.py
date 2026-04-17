from __future__ import annotations

from app.modules.bi_agent.agent.answerability import decide_answerability
from app.modules.bi_agent.agent.confidence_style import build_confidence_style
from app.modules.bi_agent.agent.followups import build_followup_questions
from app.modules.bi_agent.schemas import BiAgentAmbiguityItem, BiQuestionAnalysis


def test_answerability_answers_when_ambiguity_is_not_blocking() -> None:
    decision = decide_answerability(
        success=True,
        confidence=0.58,
        has_minimum_evidence=True,
        ambiguity_level="medium",
        ambiguity_count=1,
        should_request_refinement=False,
        non_empty_query_count=2,
        validation_errors_count=0,
    )
    assert decision.status == "answered"


def test_answerability_requests_clarification_on_high_ambiguity() -> None:
    decision = decide_answerability(
        success=True,
        confidence=0.52,
        has_minimum_evidence=True,
        ambiguity_level="high",
        ambiguity_count=2,
        should_request_refinement=True,
        non_empty_query_count=1,
        validation_errors_count=0,
    )
    assert decision.status == "needs_clarification"
    assert decision.should_ask_clarification is True


def test_followup_library_prioritizes_clarification_questions() -> None:
    analysis = BiQuestionAnalysis(intent="diagnostic_analysis")
    questions = build_followup_questions(
        intent="diagnostic_analysis",
        response_status="needs_clarification",
        question_analysis=analysis,
        ambiguities=[
            BiAgentAmbiguityItem(
                code="missing_dimension_reference",
                description="Sem dimensao explicita",
                alternatives=["canal", "produto"],
                suggested_refinement="Qual dimensao devo usar",
            )
        ],
        next_best_actions=[],
    )
    assert any("dimensao" in item.lower() for item in questions)
    assert len(questions) >= 1


def test_confidence_style_is_conversational_and_non_technical() -> None:
    low = build_confidence_style(confidence=0.22, response_status="insufficient_evidence")
    high = build_confidence_style(confidence=0.91, response_status="answered")
    assert "baixa confianca" in low.confidence_explanation.lower()
    assert "confiante" in high.confidence_explanation.lower()

