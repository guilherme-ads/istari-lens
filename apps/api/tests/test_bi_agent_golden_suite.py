from __future__ import annotations

import pytest

from test_bi_agent import _create_app, _patch_dashboard_plan, _patch_default_query


def _assert_golden_quality(payload: dict, *, question: str) -> None:
    assert payload.get("trace_id"), f"trace_id ausente para pergunta: {question}"
    chat = payload.get("chat_presentation") or {}
    final_answer = payload.get("final_answer") or {}

    primary_message = str(chat.get("primary_message") or "").strip()
    assert primary_message, f"primary_message vazio para pergunta: {question}"
    assert "m0" not in primary_message.lower(), f"token tecnico m0 vazou para chat em pergunta: {question}"
    assert "trace_id" not in primary_message.lower(), f"jargao tecnico vazou para chat em pergunta: {question}"

    response_status = str(payload.get("response_status") or "")
    assert response_status in {"answered", "needs_clarification", "insufficient_evidence"}
    if response_status == "answered":
        direct_answer = str((chat.get("direct_answer") or final_answer.get("direct_answer") or payload.get("answer") or "")).strip()
        assert direct_answer, f"status answered sem resposta direta para pergunta: {question}"
    else:
        followups = chat.get("follow_up_questions") or payload.get("clarifying_questions") or []
        assert isinstance(followups, list) and len(followups) > 0, f"status {response_status} sem follow-up para pergunta: {question}"

    quality_trace = payload.get("quality_trace") or []
    stages = {str(item.get("stage")) for item in quality_trace if isinstance(item, dict)}
    assert "evidence_selection" in stages
    assert "answerability" in stages
    assert "finalization" in stages


@pytest.mark.parametrize(
    ("question", "mode", "expected_intent"),
    [
        ("Quais sao os principais KPIs deste dataset?", "answer", "kpi_summary"),
        ("Monte um dashboard executivo para este dataset", "plan", "dashboard_generation"),
        ("Quais dimensoes explicam a queda da receita?", "answer", "diagnostic_analysis"),
        ("Gere uma analise por periodo", "answer", "exploratory_analysis"),
        ("Qual o melhor grafico para analisar receita por categoria?", "answer", "visualization_help"),
    ],
)
def test_bi_agent_golden_suite(question: str, mode: str, expected_intent: str, monkeypatch) -> None:
    _patch_default_query(
        monkeypatch,
        row_count=2,
        rows=[{"created_at": "2026-03-01", "category": "A", "m0": 120.0}, {"created_at": "2026-03-02", "category": "B", "m0": 110.0}],
    )
    if expected_intent == "dashboard_generation":
        _patch_dashboard_plan(monkeypatch)

    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={"dataset_id": ids["dataset_id"], "question": question, "mode": mode},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get("intent") == expected_intent
    _assert_golden_quality(payload, question=question)

