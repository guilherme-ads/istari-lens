from __future__ import annotations

from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import mcp
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import Base, Dashboard, DataSource, Dataset, Dimension, Metric, User, View, ViewColumn
from app.modules.core.legacy.schemas import QueryPreviewResponse
from app.modules.mcp.tools import analysis_tools


def _create_app(*, user_role: str = "admin") -> tuple[TestClient, sessionmaker, dict[str, int]]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    owner = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
    viewer = User(email="viewer@test.com", hashed_password="x", is_admin=False, is_active=True)
    session.add_all([owner, viewer])
    session.flush()

    datasource = DataSource(
        name="Demo DS",
        description="Datasource de teste",
        database_url="postgresql://demo.local/test",
        created_by_id=owner.id,
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

    session.add(
        Metric(
            dataset_id=dataset.id,
            name="receita_total",
            description="Soma da receita",
            formula="SUM(amount)",
            synonyms=["faturamento"],
            examples=["Receita total do periodo"],
        )
    )
    session.add(
        Dimension(
            dataset_id=dataset.id,
            name="categoria",
            description="Categoria comercial",
            type="categorical",
            synonyms=["segmento"],
        )
    )
    session.commit()
    dataset_id = int(dataset.id)

    if user_role == "admin":
        current_user = SimpleNamespace(
            id=owner.id,
            email=owner.email,
            is_admin=True,
            is_active=True,
            is_owner=False,
        )
    else:
        current_user = SimpleNamespace(
            id=viewer.id,
            email=viewer.email,
            is_admin=False,
            is_active=True,
            is_owner=False,
        )
    session.close()

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(mcp.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[mcp.get_db] = _get_db
    ids = {"dataset_id": dataset_id}
    return TestClient(app), testing_session_local, ids


def _call_tool(client: TestClient, tool_name: str, arguments: dict, trace_id: str | None = None):
    payload = {"arguments": arguments}
    if trace_id:
        payload["trace_id"] = trace_id
    return client.post(f"/mcp/tools/{tool_name}", json=payload)


def test_mcp_tools_catalog_v1_contains_expected_tools_and_plan() -> None:
    client, _, _ = _create_app()
    with client:
        response = client.get("/mcp/tools")
    assert response.status_code == 200, response.text
    payload = response.json()
    names = {item["name"] for item in payload["tools"]}
    expected = {
        "lens.list_datasets",
        "lens.get_dataset_semantic_layer",
        "lens.get_dataset_catalog",
        "lens.get_dataset_schema",
        "lens.search_metrics_and_dimensions",
        "lens.profile_dataset",
        "lens.run_query",
        "lens.explain_metric",
        "lens.validate_query_inputs",
        "lens.create_dashboard_draft",
        "lens.add_dashboard_section",
        "lens.add_dashboard_widget",
        "lens.update_dashboard_widget",
        "lens.delete_dashboard_widget",
        "lens.set_dashboard_native_filters",
        "lens.save_dashboard_draft",
        "lens.validate_widget_config",
        "lens.validate_dashboard_draft",
        "lens.suggest_best_visualization",
    }
    assert expected.issubset(names)
    assert isinstance(payload["recommended_agent_flow"], list)
    assert payload["execution_plan_template"]["dataset_id"] == 1


def test_mcp_context_and_analysis_tools_execute_successfully(monkeypatch) -> None:
    async def _fake_execute_preview_query(spec, db, current_user, correlation_id=None):  # noqa: ANN001
        _ = db, current_user, correlation_id
        assert spec.datasetId > 0
        return QueryPreviewResponse(columns=["m0"], rows=[{"m0": 123}], row_count=1)

    monkeypatch.setattr(analysis_tools, "execute_preview_query", _fake_execute_preview_query)

    client, _, ids = _create_app()
    with client:
        schema_res = _call_tool(client, "lens.get_dataset_schema", {"dataset_id": ids["dataset_id"]})
        validate_res = _call_tool(
            client,
            "lens.validate_query_inputs",
            {
                "dataset_id": ids["dataset_id"],
                "metrics": [{"field": "amount", "agg": "sum"}],
                "dimensions": ["category"],
                "filters": [],
                "sort": [{"field": "m0", "dir": "desc"}],
            },
        )
        run_res = _call_tool(
            client,
            "lens.run_query",
            {
                "dataset_id": ids["dataset_id"],
                "metrics": [{"field": "amount", "agg": "sum"}],
                "dimensions": ["category"],
                "filters": [],
                "sort": [{"field": "m0", "dir": "desc"}],
                "limit": 20,
                "offset": 0,
            },
        )
    assert schema_res.status_code == 200, schema_res.text
    assert schema_res.json()["output"]["success"] is True
    assert schema_res.json()["output"]["data"]["field_count"] >= 3

    assert validate_res.status_code == 200, validate_res.text
    assert validate_res.json()["output"]["success"] is True

    assert run_res.status_code == 200, run_res.text
    run_payload = run_res.json()["output"]
    assert run_payload["success"] is True
    assert run_payload["data"]["row_count"] == 1
    assert run_payload["data"]["rows"][0]["m0"] == 123


def test_mcp_builder_workflow_create_section_widget_and_save() -> None:
    client, session_factory, ids = _create_app()
    with client:
        draft_res = _call_tool(
            client,
            "lens.create_dashboard_draft",
            {"dataset_id": ids["dataset_id"], "name": "Draft BI"},
        )
        draft_output = draft_res.json()["output"]
        dashboard_id = draft_output["data"]["dashboard"]["id"]

        section_res = _call_tool(
            client,
            "lens.add_dashboard_section",
            {
                "dataset_id": ids["dataset_id"],
                "dashboard_id": dashboard_id,
                "section_id": "sec-principal",
                "title": "Resumo",
            },
        )
        assert section_res.status_code == 200, section_res.text
        assert section_res.json()["output"]["success"] is True

        widget_res = _call_tool(
            client,
            "lens.add_dashboard_widget",
            {
                "dataset_id": ids["dataset_id"],
                "dashboard_id": dashboard_id,
                "section_id": "sec-principal",
                "widget_type": "kpi",
                "title": "Receita",
                "config": {
                    "widget_type": "kpi",
                    "view_name": "__dataset_base",
                    "metrics": [{"op": "sum", "column": "amount"}],
                },
            },
        )
        assert widget_res.status_code == 200, widget_res.text
        assert widget_res.json()["output"]["success"] is True

        filters_res = _call_tool(
            client,
            "lens.set_dashboard_native_filters",
            {
                "dataset_id": ids["dataset_id"],
                "dashboard_id": dashboard_id,
                "native_filters": [{"column": "category", "op": "eq", "value": "A", "visible": True}],
            },
        )
        assert filters_res.status_code == 200, filters_res.text
        assert filters_res.json()["output"]["success"] is True

        save_res = _call_tool(
            client,
            "lens.save_dashboard_draft",
            {
                "dataset_id": ids["dataset_id"],
                "dashboard_id": dashboard_id,
                "name": "Draft BI Atualizado",
            },
        )
        assert save_res.status_code == 200, save_res.text
        assert save_res.json()["output"]["success"] is True

        validate_draft_res = _call_tool(
            client,
            "lens.validate_dashboard_draft",
            {"dataset_id": ids["dataset_id"], "dashboard_id": dashboard_id},
        )
    assert validate_draft_res.status_code == 200, validate_draft_res.text
    assert validate_draft_res.json()["output"]["success"] is True
    assert validate_draft_res.json()["output"]["data"]["is_valid"] is True

    session: Session = session_factory()
    try:
        row = session.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
        assert row is not None
        assert row.name == "Draft BI Atualizado"
    finally:
        session.close()


def test_mcp_validation_tools_report_actionable_errors_and_suggestions() -> None:
    client, _, ids = _create_app()
    with client:
        invalid_widget = _call_tool(
            client,
            "lens.validate_widget_config",
            {
                "dataset_id": ids["dataset_id"],
                "widget_type": "bar",
                "config": {
                    "widget_type": "bar",
                    "view_name": "__dataset_base",
                    "metrics": [{"op": "sum", "column": "category"}],
                    "dimensions": ["amount"],
                },
            },
        )
        suggestion = _call_tool(
            client,
            "lens.suggest_best_visualization",
            {
                "dataset_id": ids["dataset_id"],
                "metrics": ["amount"],
                "dimensions": ["category"],
                "goal": "ranking de categorias",
            },
        )
    assert invalid_widget.status_code == 200, invalid_widget.text
    invalid_payload = invalid_widget.json()["output"]
    assert invalid_payload["success"] is False
    assert len(invalid_payload["validation_errors"]) > 0

    assert suggestion.status_code == 200, suggestion.text
    suggestion_payload = suggestion.json()["output"]
    assert suggestion_payload["success"] is True
    assert len(suggestion_payload["data"]["suggestions_ranked"]) >= 1


def test_mcp_call_unknown_tool_returns_404() -> None:
    client, _, _ = _create_app()
    with client:
        response = _call_tool(client, "lens.unknown_tool", {})
    assert response.status_code == 404


def test_mcp_invalid_input_returns_standardized_validation_output() -> None:
    client, _, ids = _create_app()
    with client:
        response = _call_tool(
            client,
            "lens.add_dashboard_section",
            {
                "dataset_id": ids["dataset_id"],
                "title": "Sem dashboard_id",
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()["output"]
    assert payload["success"] is False
    assert payload["error"] == "Tool input validation failed"
    fields = {item["field"] for item in payload["validation_errors"]}
    assert "dashboard_id" in fields


def test_mcp_permission_denied_returns_actionable_output() -> None:
    client, _, ids = _create_app(user_role="viewer")
    with client:
        response = _call_tool(client, "lens.get_dataset_schema", {"dataset_id": ids["dataset_id"]})
    assert response.status_code == 200, response.text
    payload = response.json()["output"]
    assert payload["success"] is False
    assert payload["metadata"]["http_status"] == 404
    assert "not found" in payload["error"].lower()
