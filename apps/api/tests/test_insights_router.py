from collections.abc import Generator
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.crypto import credential_encryptor
from app.dependencies import get_current_admin_user, get_current_user
from app.models import Base, DataSource, Dataset, LLMIntegration, User, View, ViewColumn
from app.routers import insights
from app.schemas import QueryPreviewResponse


def _create_app(with_integration: bool = True) -> tuple[TestClient, sessionmaker]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = TestingSessionLocal()
    user = User(email="insights@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://x",
        created_by_id=user.id,
        is_active=True,
    )
    session.add(datasource)
    session.flush()

    view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
    session.add(view)
    session.flush()
    session.add_all(
        [
            ViewColumn(view_id=view.id, column_name="amount", column_type="numeric", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view.id, column_name="country", column_type="text", is_aggregatable=False, is_groupable=True),
        ]
    )
    dataset = Dataset(datasource_id=datasource.id, view_id=view.id, name="Sales", is_active=True)
    session.add(dataset)

    if with_integration:
        session.add(
            LLMIntegration(
                provider="openai",
                encrypted_api_key=credential_encryptor.encrypt("sk-test-1234567890"),
                model="gpt-4o-mini",
                is_active=True,
                created_by_id=user.id,
                updated_by_id=user.id,
            )
        )

    session.commit()
    session.close()

    def _get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(insights.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_current_admin_user] = lambda: user
    app.dependency_overrides[insights.get_db] = _get_db

    return TestClient(app), TestingSessionLocal


def test_chat_without_integration_returns_clear_error() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=False)
    with client:
        response = client.post("/insights/chat", json={"dataset_id": 1, "question": "qual a receita total?"})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "error"
    assert payload["error_code"] == "llm_not_configured"


def test_chat_empty_question_returns_controlled_error() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    with client:
        response = client.post("/insights/chat", json={"dataset_id": 1, "question": " "})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "error"
    assert payload["error_code"] == "invalid_question"


def test_chat_ambiguous_question_returns_clarification() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages, response_format
        return {
            "content": json.dumps(
                {
                    "action": "clarification",
                    "clarification_question": "Voce quer receita por pais ou total?",
                    "interpreted_question": "",
                    "query_plan": {},
                }
            )
        }

    insights._openai_chat_completion = _fake_openai
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "me fale de vendas"})
    finally:
        insights._openai_chat_completion = original_openai

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "clarification"
    assert "receita" in payload["clarification_question"].lower() or "pais" in payload["clarification_question"].lower()


def test_chat_invalid_column_returns_clarification() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages, response_format
        return {
            "content": json.dumps(
                {
                    "action": "query",
                    "clarification_question": "",
                    "interpreted_question": "total de amunt",
                    "query_plan": {
                        "metrics": [{"field": "amunt", "agg": "sum"}],
                        "dimensions": [],
                        "filters": [],
                        "sort": [],
                        "limit": 100,
                        "assumptions": [],
                    },
                }
            )
        }

    insights._openai_chat_completion = _fake_openai
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "total de amunt"})
    finally:
        insights._openai_chat_completion = original_openai

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "clarification"


def test_chat_repeated_question_uses_short_cache() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion
    original_execute = insights._execute_query_with_optimizations
    call_count = {"openai": 0, "query": 0}

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages
        call_count["openai"] += 1
        if response_format:
            return {
                "content": json.dumps(
                    {
                        "action": "query",
                        "clarification_question": "",
                        "interpreted_question": "contagem total",
                        "query_plan": {
                            "metrics": [{"field": "*", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 100,
                            "assumptions": [],
                        },
                    }
                )
            }
        return {"content": "Total de registros: 42."}

    async def _fake_execute(dataset, sql, params):
        _ = dataset, sql, params
        call_count["query"] += 1
        return insights.QueryExecutionResult(
            payload=QueryPreviewResponse(columns=["m0"], rows=[{"m0": 42}], row_count=1),
            sql='SELECT COUNT(*) AS "m0" FROM "public"."vw_sales"',
            params=[],
            execution_time_ms=2,
            cache_hit=False,
            deduped=False,
        )

    insights._openai_chat_completion = _fake_openai
    insights._execute_query_with_optimizations = _fake_execute
    try:
        with client:
            first = client.post("/insights/chat", json={"dataset_id": 1, "question": "quantos registros?"})
            second = client.post("/insights/chat", json={"dataset_id": 1, "question": "quantos registros?"})
    finally:
        insights._openai_chat_completion = original_openai
        insights._execute_query_with_optimizations = original_execute

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_payload = first.json()
    second_payload = second.json()
    assert first_payload["type"] == "answer"
    assert second_payload["type"] == "answer"
    assert first_payload["cache_hit"] is False
    assert second_payload["cache_hit"] is True
    assert "query_plan" in first_payload
    assert "calculation" in first_payload
    assert call_count["query"] == 1
    assert call_count["openai"] == 2


def test_chat_planner_shape_with_dimension_objects_and_empty_period_is_normalized() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion
    original_execute = insights._execute_query_with_optimizations

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages
        if response_format:
            return {
                "content": json.dumps(
                    {
                        "action": "query",
                        "clarification_question": "",
                        "interpreted_question": "Top 3 clientes que mais gastam",
                        "query_plan": {
                            "metrics": [{"field": "amount", "agg": "sum"}],
                            "dimensions": [{"field": "country"}],
                            "filters": [],
                            "period": {"field": "", "start": "", "end": "", "granularity": "", "preset": ""},
                            "sort": [{"field": "amount", "dir": "desc"}],
                            "limit": 3,
                            "assumptions": [],
                        },
                    }
                )
            }
        return {"content": "Top 3 clientes por gasto retornados."}

    async def _fake_execute(dataset, sql, params):
        _ = dataset, params
        assert "GROUP BY" in sql
        return insights.QueryExecutionResult(
            payload=QueryPreviewResponse(columns=["country", "m0"], rows=[{"country": "BR", "m0": 1200}], row_count=1),
            sql=sql,
            params=[],
            execution_time_ms=2,
            cache_hit=False,
            deduped=False,
        )

    insights._openai_chat_completion = _fake_openai
    insights._execute_query_with_optimizations = _fake_execute
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "Top 3 clientes que mais gastam"})
    finally:
        insights._openai_chat_completion = original_openai
        insights._execute_query_with_optimizations = original_execute

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "answer"


def test_chat_missing_relation_is_not_misclassified_as_missing_column() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion
    original_execute = insights._execute_query_with_optimizations

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages
        if response_format:
            return {
                "content": json.dumps(
                    {
                        "action": "query",
                        "clarification_question": "",
                        "interpreted_question": "Top 3 clientes que mais gastam",
                        "query_plan": {
                            "metrics": [{"field": "amount", "agg": "sum"}],
                            "dimensions": [{"field": "country"}],
                            "filters": [],
                            "sort": [{"field": "amount", "dir": "desc"}],
                            "limit": 3,
                            "assumptions": [],
                        },
                    }
                )
            }
        return {"content": "ok"}

    async def _fake_execute(dataset, sql, params):
        _ = dataset, sql, params
        raise insights.HTTPException(
            status_code=500,
            detail='Insight query execution failed: UndefinedTable(\'relation "analytics.vw_clientes" does not exist\')',
        )

    insights._openai_chat_completion = _fake_openai
    insights._execute_query_with_optimizations = _fake_execute
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "Top 3 clientes que mais gastam"})
    finally:
        insights._openai_chat_completion = original_openai
        insights._execute_query_with_optimizations = original_execute

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "error"
    assert payload["error_code"] == "dataset_unavailable"


def test_chat_answer_retries_when_llm_claims_missing_data_with_metrics_present() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion
    original_execute = insights._execute_query_with_optimizations
    state = {"answer_calls": 0}

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model, messages
        if response_format:
            return {
                "content": json.dumps(
                    {
                        "action": "query",
                        "clarification_question": "",
                        "interpreted_question": "Top 3 clientes que mais gastam",
                        "query_plan": {
                            "metrics": [{"field": "amount", "agg": "sum"}],
                            "dimensions": [{"field": "country"}],
                            "filters": [],
                            "sort": [{"field": "amount", "dir": "desc"}],
                            "limit": 3,
                            "assumptions": [],
                        },
                    }
                )
            }
        state["answer_calls"] += 1
        if state["answer_calls"] == 1:
            return {"content": "Nao ha dados suficientes para responder."}
        return {"content": "Top 3 clientes: BR (1200)."}

    async def _fake_execute(dataset, sql, params):
        _ = dataset, sql, params
        return insights.QueryExecutionResult(
            payload=QueryPreviewResponse(columns=["country", "m0"], rows=[{"country": "BR", "m0": 1200}], row_count=1),
            sql='SELECT "country", SUM("amount") AS "m0" FROM "public"."vw_sales" GROUP BY "country" ORDER BY "m0" DESC LIMIT 3',
            params=[],
            execution_time_ms=2,
            cache_hit=False,
            deduped=False,
        )

    insights._openai_chat_completion = _fake_openai
    insights._execute_query_with_optimizations = _fake_execute
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "Top 3 clientes que mais gastam"})
    finally:
        insights._openai_chat_completion = original_openai
        insights._execute_query_with_optimizations = original_execute

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["type"] == "answer"
    assert "Top 3 clientes" in payload["answer"]
    assert state["answer_calls"] == 2


def test_chat_answer_prompt_avoids_metric_alias_names() -> None:
    insights._chat_cache.clear()
    client, _session_factory = _create_app(with_integration=True)
    original_openai = insights._openai_chat_completion
    original_execute = insights._execute_query_with_optimizations
    captured_answer_prompt = {"content": ""}

    async def _fake_openai(*, api_key: str, model: str, messages: list[dict], response_format: dict | None = None) -> dict:
        _ = api_key, model
        if response_format:
            return {
                "content": json.dumps(
                    {
                        "action": "query",
                        "clarification_question": "",
                        "interpreted_question": "Top 3 clientes que mais gastam",
                        "query_plan": {
                            "metrics": [{"field": "amount", "agg": "sum"}],
                            "dimensions": [{"field": "country"}],
                            "filters": [],
                            "sort": [{"field": "amount", "dir": "desc"}],
                            "limit": 3,
                            "assumptions": [],
                        },
                    }
                )
            }
        if messages and messages[0].get("role") == "system":
            captured_answer_prompt["content"] = str(messages[1].get("content", ""))
        return {"content": "Top 3 clientes: BR (1200)."}

    async def _fake_execute(dataset, sql, params):
        _ = dataset, sql, params
        return insights.QueryExecutionResult(
            payload=QueryPreviewResponse(columns=["country", "m0"], rows=[{"country": "BR", "m0": 1200}], row_count=1),
            sql='SELECT "country", SUM("amount") AS "m0" FROM "public"."vw_sales" GROUP BY "country" ORDER BY "m0" DESC LIMIT 3',
            params=[],
            execution_time_ms=2,
            cache_hit=False,
            deduped=False,
        )

    insights._openai_chat_completion = _fake_openai
    insights._execute_query_with_optimizations = _fake_execute
    try:
        with client:
            response = client.post("/insights/chat", json={"dataset_id": 1, "question": "Top 3 clientes que mais gastam"})
    finally:
        insights._openai_chat_completion = original_openai
        insights._execute_query_with_optimizations = original_execute

    assert response.status_code == 200, response.text
    assert '"m0"' not in captured_answer_prompt["content"]
