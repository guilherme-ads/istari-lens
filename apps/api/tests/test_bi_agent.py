from __future__ import annotations

from collections.abc import Generator
from datetime import datetime
from types import MethodType, SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import bi_agent
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.bi_agent.bi_agent_orchestrator import BIAgentOrchestrator
from app.modules.bi_agent.agent.reasoning_adapter import AdapterNextActionSuggestion, DefaultReasoningAdapter
from app.modules.bi_agent.schemas import BiAgentRunRequest
from app.modules.core.legacy.models import Base, DataSource, Dataset, Dimension, Metric, User, View, ViewColumn
from app.modules.core.legacy.schemas import QueryPreviewResponse
from app.modules.mcp.schemas import MCPToolCallResponse, MCPToolExecutionOutput, MCPToolValidationError
from app.modules.mcp.tool_registry import tool_registry
from app.modules.mcp.tools import analysis_tools, builder_tools
from app.modules.openai_adapter.schemas import OpenAITraceMetadata


def _create_app(*, include_metric: bool = True) -> tuple[TestClient, sessionmaker, dict[str, int]]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="agent@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="Demo DS",
        description="Datasource de teste",
        database_url="postgresql://demo.local/test",
        created_by_id=user.id,
        is_active=True,
    )
    session.add(datasource)
    session.flush()

    view = View(
        datasource_id=datasource.id,
        schema_name="public",
        view_name="sales",
        is_active=True,
    )
    session.add(view)
    session.flush()

    session.add_all(
        [
            ViewColumn(view_id=view.id, column_name="amount", column_type="numeric", description="Valor"),
            ViewColumn(view_id=view.id, column_name="category", column_type="text", description="Categoria"),
            ViewColumn(view_id=view.id, column_name="created_at", column_type="timestamp", description="Data"),
        ]
    )

    dataset = Dataset(
        datasource_id=datasource.id,
        view_id=view.id,
        name="Sales Dataset",
        description="Dataset de vendas",
        access_mode="direct",
        data_status="ready",
        semantic_columns=[
            {"name": "amount", "type": "numeric", "description": "Receita em BRL"},
            {"name": "category", "type": "text", "description": "Categoria comercial"},
            {"name": "created_at", "type": "temporal", "description": "Data da venda"},
        ],
        is_active=True,
    )
    session.add(dataset)
    session.flush()

    if include_metric:
        session.add(
            Metric(
                dataset_id=dataset.id,
                name="receita_total",
                description="Soma da receita",
                formula="SUM(amount)",
            )
        )
    session.add(
        Dimension(
            dataset_id=dataset.id,
            name="categoria",
            description="Categoria comercial",
            type="categorical",
        )
    )
    session.commit()
    dataset_id = int(dataset.id)
    current_user_stub = SimpleNamespace(id=user.id, email=user.email, is_admin=True, is_active=True, is_owner=False)
    session.close()

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(bi_agent.router)
    app.dependency_overrides[get_current_user] = lambda: current_user_stub
    app.dependency_overrides[bi_agent.get_db] = _get_db

    return TestClient(app), testing_session_local, {"dataset_id": dataset_id}


def _patch_default_query(monkeypatch, *, row_count: int = 1, rows: list[dict] | None = None) -> None:
    async def _fake_execute_preview_query(spec, db, current_user, correlation_id=None):  # noqa: ANN001
        _ = spec, db, current_user, correlation_id
        payload_rows = rows if rows is not None else [{"m0": 123, "category": "A"}]
        return QueryPreviewResponse(columns=list(payload_rows[0].keys()) if payload_rows else ["m0"], rows=payload_rows, row_count=row_count)

    monkeypatch.setattr(analysis_tools, "execute_preview_query", _fake_execute_preview_query)


def _patch_dashboard_plan(monkeypatch) -> None:
    async def _fake_generate_dashboard_with_ai_service(**kwargs):  # noqa: ANN003
        _ = kwargs
        return {
            "title": "Plano Executivo",
            "explanation": "Plano sugerido",
            "planning_steps": ["Visao geral", "Evolucao temporal"],
            "native_filters": [],
            "sections": [{"title": "Resumo", "columns": 2, "widgets": []}],
        }

    monkeypatch.setattr(builder_tools, "generate_dashboard_with_ai_service", _fake_generate_dashboard_with_ai_service)


def test_bi_agent_kpi_intent(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Quais sao os principais KPIs deste dataset?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "kpi_summary"
    assert payload["success"] is True
    assert len(payload["queries_executed"]) >= 1
    assert payload["question_analysis"] is not None
    assert len(payload["query_candidates"]) >= 1
    assert payload["analysis_state"] is not None
    assert payload["stopping_reason"] is not None
    assert payload["response_status"] == "answered"
    assert "principais kpis" in payload["answer"].lower()
    assert payload["chat_presentation"] is not None
    assert payload["chat_presentation"]["primary_message"] != ""


def test_bi_agent_dashboard_intent(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    _patch_dashboard_plan(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={"dataset_id": ids["dataset_id"], "question": "Monte um dashboard executivo para este dataset", "mode": "plan"},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "dashboard_generation"
    assert payload["dashboard_plan"] is not None
    assert payload["executive_summary"] is not None
    assert len(payload["key_findings"]) >= 1
    assert payload["analysis_state"] is not None


def test_bi_agent_diagnostic_intent(monkeypatch) -> None:
    _patch_default_query(monkeypatch, rows=[{"category": "Canal A", "m0": 90}, {"category": "Canal B", "m0": 45}], row_count=2)
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={"dataset_id": ids["dataset_id"], "question": "Quais dimensoes podem explicar a queda da receita?"},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "diagnostic_analysis"
    assert payload["success"] is True
    assert any("nao implica causalidade" in item.lower() for item in payload["key_findings"])
    assert payload["analysis_state"]["temporal_coverage"] is True
    assert payload["analysis_state"]["dimensional_coverage"] is True


def test_bi_agent_ambiguous_question(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Como foi?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["question_analysis"]["ambiguity_level"] in {"medium", "high"}
    assert len(payload["ambiguities"]) >= 1
    assert len(payload["assumptions"]) >= 1
    assert payload["analysis_state"] is not None
    assert payload["response_status"] == "needs_clarification"


def test_bi_agent_temporal_question(monkeypatch) -> None:
    _patch_default_query(monkeypatch, rows=[{"created_at": "2026-01-01", "m0": 100}], row_count=1)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Gere uma analise por periodo"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["question_analysis"]["requires_temporal"] is True
    assert any(item["candidate_id"] == "cand_temporal_trend" for item in payload["query_candidates"])


def test_bi_agent_visualization_question(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={"dataset_id": ids["dataset_id"], "question": "Qual o melhor grafico para analisar receita por categoria?"},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "visualization_help"
    assert "recomendacao principal" in payload["answer"].lower() or len(payload["warnings"]) > 0


def test_bi_agent_intent_evidence_conflict(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    original_execute = tool_registry.execute

    async def _execute_with_visualization_failure(self, *, tool_name, raw_arguments, db, current_user, trace_id=None):  # noqa: ANN001
        if tool_name == "lens.suggest_best_visualization":
            return MCPToolCallResponse(
                tool=tool_name,
                category="validation",
                trace_id=trace_id or "trace-test",
                executed_at=datetime.utcnow(),
                output=MCPToolExecutionOutput(
                    success=False,
                    error="Visualization suggestion failed for test",
                ),
            )
        return await original_execute(
            tool_name=tool_name,
            raw_arguments=raw_arguments,
            db=db,
            current_user=current_user,
            trace_id=trace_id,
        )

    monkeypatch.setattr(tool_registry, "execute", MethodType(_execute_with_visualization_failure, tool_registry))
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={"dataset_id": ids["dataset_id"], "question": "Qual o melhor grafico para receita por categoria?"},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "visualization_help"
    assert any("visualizacao sem sugestao final" in item.lower() for item in payload["warnings"])


def test_bi_agent_invalid_dataset(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, _ = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": 99999, "question": "Teste dataset invalido"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["success"] is False
    assert payload["error"] is not None


def test_bi_agent_empty_question(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "   "})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["success"] is False
    assert payload["error"] == "Question cannot be empty"


def test_bi_agent_low_confidence_fallback(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=0, rows=[])
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Gere uma analise por periodo"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["success"] is False
    assert payload["answer_confidence"] <= 0.35
    assert "evidencia insuficiente" in payload["answer"].lower()
    assert payload["stopping_reason"] in {"low_marginal_gain", "evidence_step_budget_exhausted", "high_ambiguity_insufficient_signal"}


def test_bi_agent_stop_by_confidence_sufficient(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=2, rows=[{"created_at": "2026-01-01", "category": "A", "m0": 100}])
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "O que explica a queda da receita?",
                "adaptive_mode": True,
                "max_evidence_steps": 8,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "diagnostic_analysis"
    assert payload["stopping_reason"] == "confidence_sufficient"
    assert payload["answer_confidence"] >= 0.78


def test_bi_agent_stop_by_low_marginal_gain(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=0, rows=[])
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "Analise receita por periodo e categoria",
                "adaptive_mode": True,
                "max_evidence_steps": 6,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["stopping_reason"] in {"low_marginal_gain", "high_ambiguity_insufficient_signal"}


def test_bi_agent_adaptive_reduces_redundancy(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=1, rows=[{"created_at": "2026-01-01", "category": "A", "m0": 100}])
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "Quais dimensoes podem explicar a queda da receita?",
                "adaptive_mode": True,
                "max_evidence_steps": 5,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    executed = [item["selected_candidate_id"] for item in payload["adaptive_decisions"] if item["status"] == "executed"]
    assert len(executed) == len(set(executed))
    assert all(item["blocked"] is True for item in payload["next_query_candidates"] if item["candidate_id"] in executed)


def test_bi_agent_ambiguity_persistent(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=0, rows=[])
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "E agora?",
                "adaptive_mode": True,
                "max_evidence_steps": 4,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["question_analysis"]["ambiguity_level"] == "high"
    assert payload["stopping_reason"] == "high_ambiguity_insufficient_signal"


def test_bi_agent_reasoning_adapter_rerank(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=2, rows=[{"created_at": "2026-01-01", "category": "A", "m0": 100}])

    class StubAdapter(DefaultReasoningAdapter):
        async def rerank_query_candidates(self, *, analysis, candidates, trace_id):  # noqa: ANN001
            _ = analysis, trace_id
            return list(reversed(candidates))

        async def suggest_next_candidate(self, *, analysis, ranked_candidates, execution_context, trace_id):  # noqa: ANN001
            _ = analysis, execution_context, trace_id
            target = next((item for item in ranked_candidates if item.candidate_id == "cand_temporal_dimension"), None)
            if target is None:
                target = ranked_candidates[0]
            return AdapterNextActionSuggestion(
                candidate_id=target.candidate_id,
                reason="Preferir comparacao temporal x dimensao para ganho diagnostico.",
                confidence=0.8,
            )

    original_orchestrator = bi_agent._orchestrator
    bi_agent._orchestrator = BIAgentOrchestrator(reasoning_adapter=StubAdapter())
    client, _, ids = _create_app()
    try:
        with client:
            response = client.post(
                "/bi-agent/run",
                json={
                    "dataset_id": ids["dataset_id"],
                    "question": "O que explica a queda da receita?",
                    "adaptive_mode": True,
                    "enable_reasoning_adapter": True,
                },
            )
    finally:
        bi_agent._orchestrator = original_orchestrator
    assert response.status_code == 200, response.text
    payload = response.json()
    assert any(
        item["contribution_type"] in {"candidate_rerank", "rerank"} and item["applied"]
        for item in payload["reasoning_adapter_contributions"]
    )
    assert any(item["contribution_type"] == "next_action" for item in payload["reasoning_adapter_contributions"])


def test_bi_agent_reasoning_adapter_disabled(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=1, rows=[{"m0": 100, "category": "A"}])

    class StubAdapter(DefaultReasoningAdapter):
        async def rerank_query_candidates(self, *, analysis, candidates, trace_id):  # noqa: ANN001
            _ = analysis, trace_id
            return list(reversed(candidates))

    original_orchestrator = bi_agent._orchestrator
    bi_agent._orchestrator = BIAgentOrchestrator(reasoning_adapter=StubAdapter())
    client, _, ids = _create_app()
    try:
        with client:
            response = client.post(
                "/bi-agent/run",
                json={
                    "dataset_id": ids["dataset_id"],
                    "question": "Quais sao os principais KPIs deste dataset?",
                    "adaptive_mode": True,
                    "enable_reasoning_adapter": False,
                },
            )
    finally:
        bi_agent._orchestrator = original_orchestrator
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["reasoning_adapter_contributions"] == []


def test_bi_agent_reasoning_suggestion_rejected_by_guardrail(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=1, rows=[{"created_at": "2026-01-01", "category": "A", "m0": 100}])

    class StubAdapter(DefaultReasoningAdapter):
        async def suggest_next_candidate(self, *, analysis, ranked_candidates, execution_context, trace_id):  # noqa: ANN001
            _ = analysis, ranked_candidates, execution_context, trace_id
            return AdapterNextActionSuggestion(
                candidate_id="cand_temporal_dimension",
                tool_name="lens.add_dashboard_widget",
                reason="Tool mutavel sugerida por teste.",
                confidence=0.9,
            )

    original_orchestrator = bi_agent._orchestrator
    bi_agent._orchestrator = BIAgentOrchestrator(reasoning_adapter=StubAdapter())
    client, _, ids = _create_app()
    try:
        with client:
            response = client.post(
                "/bi-agent/run",
                json={
                    "dataset_id": ids["dataset_id"],
                    "question": "Analise receita por periodo e categoria",
                    "adaptive_mode": True,
                    "enable_reasoning_adapter": True,
                },
            )
    finally:
        bi_agent._orchestrator = original_orchestrator

    assert response.status_code == 200, response.text
    payload = response.json()
    assert any(
        item["contribution_type"] == "next_action"
        and item["applied"] is False
        and "suggested_tool_name" in item["payload"]
        for item in payload["reasoning_adapter_contributions"]
    )


def test_bi_agent_reasoning_trace_correlation(monkeypatch) -> None:
    _patch_default_query(monkeypatch, row_count=1, rows=[{"m0": 100, "category": "A"}])

    class StubAdapter(DefaultReasoningAdapter):
        def __init__(self) -> None:
            self._traces: list[OpenAITraceMetadata] = []

        async def classify_intent(self, *, question, allowed_intents, trace_id):  # noqa: ANN001
            _ = question, allowed_intents
            self._traces.append(
                OpenAITraceMetadata(
                    call_id="stub-call-1",
                    lens_trace_id=trace_id,
                    task="intent_classification",
                    model="stub-model",
                    schema_name="intent_classification",
                )
            )
            return "kpi_summary"

        def consume_openai_trace_events(self):  # noqa: ANN201
            items = list(self._traces)
            self._traces.clear()
            return items

    original_orchestrator = bi_agent._orchestrator
    bi_agent._orchestrator = BIAgentOrchestrator(reasoning_adapter=StubAdapter())
    client, _, ids = _create_app()
    try:
        with client:
            response = client.post(
                "/bi-agent/run",
                json={
                    "dataset_id": ids["dataset_id"],
                    "question": "Quais sao os principais KPIs deste dataset?",
                    "enable_reasoning_adapter": True,
                    "trace_id": "trace-openai-correlation",
                },
            )
    finally:
        bi_agent._orchestrator = original_orchestrator

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["trace_id"] == "trace-openai-correlation"
    assert any(item["lens_trace_id"] == payload["trace_id"] for item in payload["openai_trace"])


def test_bi_agent_validation_failure_flow(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    original_execute = tool_registry.execute

    async def _execute_with_validation_failure(self, *, tool_name, raw_arguments, db, current_user, trace_id=None):  # noqa: ANN001
        if tool_name == "lens.validate_query_inputs":
            return MCPToolCallResponse(
                tool=tool_name,
                category="analysis",
                trace_id=trace_id or "trace-test",
                executed_at=datetime.utcnow(),
                output=MCPToolExecutionOutput(
                    success=False,
                    error="Query input validation failed",
                    validation_errors=[
                        MCPToolValidationError(
                            code="invalid_filter_value",
                            field="filters[0].value",
                            message="Invalid filter for test",
                        )
                    ],
                ),
            )
        return await original_execute(
            tool_name=tool_name,
            raw_arguments=raw_arguments,
            db=db,
            current_user=current_user,
            trace_id=trace_id,
        )

    monkeypatch.setattr(tool_registry, "execute", MethodType(_execute_with_validation_failure, tool_registry))
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Quais sao os principais KPIs?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["success"] is False
    assert len(payload["validation_errors"]) > 0


def test_bi_agent_metric_not_found_clearly(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app(include_metric=False)
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Me explique esta metrica"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["intent"] == "metric_explanation"
    assert payload["success"] is False
    assert len(payload["validation_errors"]) > 0


def test_bi_agent_draft_without_apply_changes(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    _patch_dashboard_plan(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "Monte um dashboard executivo para este dataset",
                "mode": "draft",
                "apply_changes": False,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["dry_run"] is True
    assert payload["dashboard_draft"] is not None
    assert payload["dashboard_draft"]["applied"] is False


def test_bi_agent_endpoint_contract(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    request = BiAgentRunRequest(dataset_id=ids["dataset_id"], question="Me explique esta metrica", mode="answer")
    with client:
        response = client.post("/bi-agent/run", json=request.model_dump(mode="json"))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "trace_id" in payload
    assert "tool_calls" in payload
    assert "answer_confidence" in payload
    assert "executive_summary" in payload
    assert "key_findings" in payload
    assert "question_analysis" in payload
    assert "query_candidates" in payload
    assert "evidence_scoring" in payload
    assert "analysis_state" in payload
    assert "hypotheses" in payload
    assert "evidence_gaps" in payload
    assert "adaptive_decisions" in payload
    assert "stopping_reason" in payload
    assert "human_review_summary" in payload
    assert "openai_trace" in payload
    assert "final_answer" in payload
    assert "chat_presentation" in payload
    assert "conversation_memory" in payload
    assert "response_status" in payload
    assert "short_chat_message" in payload
    assert "clarifying_questions" in payload
    assert "recommended_next_step" in payload
    assert "confidence_explanation" in payload
    assert "user_friendly_findings" in payload
    assert "answer_synthesis_trace" in payload
    assert "quality_trace" in payload
    assert isinstance(payload["quality_trace"], list)


def test_bi_agent_quality_trace_has_core_stages(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Quais sao os principais KPIs deste dataset?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    stages = {item["stage"] for item in payload.get("quality_trace", [])}
    assert "memory" in stages
    assert "answerability" in stages
    assert "evidence_selection" in stages
    assert "finalization" in stages


def test_bi_agent_chat_presentation_is_user_facing(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post("/bi-agent/run", json={"dataset_id": ids["dataset_id"], "question": "Quais sao os principais KPIs deste dataset?"})
    assert response.status_code == 200, response.text
    payload = response.json()
    chat = payload.get("chat_presentation") or {}
    assert isinstance(chat.get("primary_message"), str) and chat["primary_message"].strip() != ""
    assert isinstance(chat.get("follow_up_questions"), list)
    assert "trace_id" not in chat["primary_message"].lower()


def test_bi_agent_conversation_memory_applied(monkeypatch) -> None:
    _patch_default_query(monkeypatch)
    client, _, ids = _create_app()
    with client:
        response = client.post(
            "/bi-agent/run",
            json={
                "dataset_id": ids["dataset_id"],
                "question": "E por periodo?",
                "conversation_history": [
                    {"role": "user", "content": "Quais sao os principais KPIs deste dataset?"},
                    {"role": "assistant", "content": "Os principais KPIs sao Receita Total e Volume."},
                ],
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    memory = payload.get("conversation_memory") or {}
    assert memory.get("applied") is True
    assert memory.get("source_turns_count", 0) > 0
