from collections.abc import Generator
import asyncio
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.dependencies import get_current_admin_user, get_current_user
from app.dashboard_execution import get_dashboard_widget_executor
from app.models import Base, Dashboard, Dataset, DataSource, User, View, ViewColumn
from app.routers import dashboards
import app.dashboard_execution as dashboard_execution


class _FakeResult:
    def __init__(self, rows: list[tuple], columns: list[str]) -> None:
        self._rows = rows
        self.description = [(column,) for column in columns]

    async def fetchall(self) -> list[tuple]:
        return self._rows


class _FakeConn:
    last_params: list | None = None
    execute_count: int = 0
    last_sql: str | None = None

    async def execute(self, _sql: str, _params: list) -> _FakeResult:
        _FakeConn.execute_count += 1
        _FakeConn.last_sql = _sql
        _FakeConn.last_params = _params
        aliases = re.findall(r'AS\\s+\"(m\\d+)\"', _sql, re.IGNORECASE)
        if aliases:
            values = tuple([42 + i for i, _ in enumerate(aliases)])
            return _FakeResult(rows=[values], columns=aliases)
        return _FakeResult(rows=[(42,)], columns=["m0"])

    async def close(self) -> None:
        return None


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = TestingSessionLocal()
    user = User(email="widget@test.com", hashed_password="x", is_admin=True, is_active=True)
    datasource = DataSource(
        name="analytics",
        description="",
        database_url="",
        created_by_id=1,
        is_active=True,
    )
    session.add(user)
    session.flush()
    datasource.created_by_id = user.id
    session.add(datasource)
    session.flush()

    view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_recargas", is_active=True)
    session.add(view)
    session.flush()
    session.add_all(
        [
            ViewColumn(view_id=view.id, column_name="id_recarga", column_type="bigint", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view.id, column_name="estacao", column_type="text", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="data", column_type="timestamp", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="kwh", column_type="numeric", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view.id, column_name="valor", column_type="numeric", is_aggregatable=True, is_groupable=False),
        ]
    )
    dataset = Dataset(datasource_id=datasource.id, view_id=view.id, name="vw_recargas", is_active=True)
    session.add(dataset)
    session.flush()
    dashboard = Dashboard(dataset_id=dataset.id, name="Main", layout_config=[])
    session.add(dashboard)
    session.commit()

    def _get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(dashboards.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_current_admin_user] = lambda: user
    app.dependency_overrides[dashboards.get_db] = _get_db

    async def _fake_get_analytics_connection() -> _FakeConn:
        return _FakeConn()

    _FakeConn.last_params = None
    _FakeConn.execute_count = 0
    _FakeConn.last_sql = None
    original_conn = dashboard_execution.get_analytics_connection
    dashboard_execution.get_analytics_connection = _fake_get_analytics_connection
    asyncio.run(get_dashboard_widget_executor().reset_state_for_tests())
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        dashboard_execution.get_analytics_connection = original_conn
        asyncio.run(get_dashboard_widget_executor().reset_state_for_tests())
        session.close()


def test_create_widget_and_fetch_renderable_data(client: TestClient) -> None:
    create_response = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Total recargas",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            },
        },
    )
    assert create_response.status_code == 200, create_response.text
    widget_id = create_response.json()["id"]

    data_response = client.get(f"/dashboards/1/widgets/{widget_id}/data")
    assert data_response.status_code == 200, data_response.text
    payload = data_response.json()
    assert payload["columns"] == ["m0"]
    assert payload["rows"] == [{"m0": 42}]
    assert payload["row_count"] == 1


def test_invalid_widget_config_returns_400_with_field_errors(client: TestClient) -> None:
    response = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Invalido",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "estacao"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            },
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "field_errors" in detail
    assert "metrics[0].column" in detail["field_errors"]


def test_text_widget_returns_empty_data_payload(client: TestClient) -> None:
    create_response = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "text",
            "title": "Cabecalho",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "text",
                "view_name": "public.vw_recargas",
                "text_style": {"content": "Resumo", "font_size": 22, "align": "center"},
                "metrics": [],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            },
        },
    )
    assert create_response.status_code == 200, create_response.text
    widget_id = create_response.json()["id"]

    data_response = client.get(f"/dashboards/1/widgets/{widget_id}/data")
    assert data_response.status_code == 200, data_response.text
    payload = data_response.json()
    assert payload["columns"] == []
    assert payload["rows"] == []
    assert payload["row_count"] == 0


def test_batch_data_accepts_global_filters(client: TestClient) -> None:
    create_response = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Total recargas",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            },
        },
    )
    widget_id = create_response.json()["id"]

    data_response = client.post(
        "/dashboards/1/widgets/data",
        json={
            "widget_ids": [widget_id],
            "global_filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
        },
    )
    assert data_response.status_code == 200, data_response.text
    assert _FakeConn.last_params == ["SP"]


def test_batch_data_uses_cache_within_ttl(client: TestClient) -> None:
    create_response = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Total recargas",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            },
        },
    )
    widget_id = create_response.json()["id"]

    first = client.post("/dashboards/1/widgets/data", json={"widget_ids": [widget_id], "global_filters": []})
    assert first.status_code == 200, first.text
    assert first.json()["results"][0]["cache_hit"] is False

    second = client.post("/dashboards/1/widgets/data", json={"widget_ids": [widget_id], "global_filters": []})
    assert second.status_code == 200, second.text
    assert second.json()["results"][0]["cache_hit"] is True
    assert _FakeConn.execute_count == 1


def test_single_flight_deduplicates_identical_non_kpi_widgets(client: TestClient) -> None:
    payload = {
        "widget_type": "table",
        "title": "Tabela",
        "position": 0,
        "config_version": 1,
        "config": {
            "widget_type": "table",
            "view_name": "public.vw_recargas",
            "metrics": [],
            "dimensions": [],
            "columns": ["id_recarga", "estacao"],
            "filters": [],
            "order_by": [],
            "limit": 10,
        },
    }
    w1 = client.post("/dashboards/1/widgets", json=payload).json()["id"]
    w2 = client.post("/dashboards/1/widgets", json={**payload, "position": 1, "title": "Tabela 2"}).json()["id"]

    response = client.post("/dashboards/1/widgets/data", json={"widget_ids": [w1, w2], "global_filters": []})
    assert response.status_code == 200, response.text
    items = response.json()["results"]
    assert any(item["deduped"] for item in items)
    assert _FakeConn.execute_count == 1


def test_kpi_batch_fusion_executes_single_query(client: TestClient) -> None:
    kpi_count = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Total",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]
    kpi_sum = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Energia",
            "position": 1,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "kwh"}],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]

    response = client.post("/dashboards/1/widgets/data", json={"widget_ids": [kpi_count, kpi_sum], "global_filters": []})
    assert response.status_code == 200, response.text
    items = response.json()["results"]
    assert len(items) == 2
    assert all(item["batched"] for item in items)
    assert _FakeConn.execute_count == 1


def test_kpi_composite_batch_fusion_executes_single_query(client: TestClient) -> None:
    kpi_avg_recargas_dia = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Avg recargas por dia",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "count",
                    "outer_agg": "avg",
                    "value_column": "id_recarga",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]
    kpi_avg_kwh_dia = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Avg kwh por dia",
            "position": 1,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "sum",
                    "outer_agg": "avg",
                    "value_column": "kwh",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]

    response = client.post(
        "/dashboards/1/widgets/data",
        json={"widget_ids": [kpi_avg_recargas_dia, kpi_avg_kwh_dia], "global_filters": []},
    )
    assert response.status_code == 200, response.text
    items = response.json()["results"]
    assert len(items) == 2
    assert all(item["batched"] for item in items)
    assert _FakeConn.execute_count == 1
    assert _FakeConn.last_sql is not None
    assert 'DATE_TRUNC(\'day\', "data") AS "time_bucket"' in _FakeConn.last_sql
    assert 'COUNT("id_recarga") AS "bucket_0"' in _FakeConn.last_sql
    assert 'SUM("kwh") AS "bucket_1"' in _FakeConn.last_sql
    assert 'SELECT AVG("bucket_0") AS "m0", AVG("bucket_1") AS "m1"' in _FakeConn.last_sql


def test_debug_queries_dashboard_mode_returns_final_execution_units(client: TestClient) -> None:
    kpi_1 = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Total",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]
    kpi_2 = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Energia",
            "position": 1,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "kwh"}],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]

    response = client.post(
        "/dashboards/1/debug/queries",
        json={"mode": "dashboard", "native_filters_override": [], "global_filters": []},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["mode"] == "dashboard"
    assert len(payload["final_items"]) >= 1
    first = payload["final_items"][0]
    assert first["execution_kind"] == "kpi_batched"
    assert sorted(first["widget_ids"]) == sorted([kpi_1, kpi_2])


def test_debug_queries_dashboard_mode_batches_composite_kpis(client: TestClient) -> None:
    kpi_1 = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Avg recargas por dia",
            "position": 0,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "count",
                    "outer_agg": "avg",
                    "value_column": "id_recarga",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]
    kpi_2 = client.post(
        "/dashboards/1/widgets",
        json={
            "widget_type": "kpi",
            "title": "Avg kwh por dia",
            "position": 1,
            "config_version": 1,
            "config": {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "sum",
                    "outer_agg": "avg",
                    "value_column": "kwh",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [{"column": "estacao", "op": "eq", "value": "SP"}],
                "order_by": [],
            },
        },
    ).json()["id"]

    response = client.post(
        "/dashboards/1/debug/queries",
        json={"mode": "dashboard", "native_filters_override": [], "global_filters": []},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    units = payload["final_items"]
    assert len(units) >= 1
    first = units[0]
    assert first["execution_kind"] == "kpi_batched"
    assert sorted(first["widget_ids"]) == sorted([kpi_1, kpi_2])
    assert 'DATE_TRUNC(\'day\', "data") AS "time_bucket"' in first["sql"]
    assert 'COUNT("id_recarga") AS "bucket_0"' in first["sql"]
    assert 'SUM("kwh") AS "bucket_1"' in first["sql"]
