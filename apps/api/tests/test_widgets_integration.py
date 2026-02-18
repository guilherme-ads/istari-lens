from collections.abc import Generator
import hashlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.modules.auth.adapters.api.dependencies import get_current_admin_user, get_current_user
from app.modules.core.legacy.models import Base, Dashboard, Dataset, DataSource, User, View, ViewColumn
from app.api.v1.routes import dashboards
import app.modules.widgets.application.execution_coordinator as dashboard_execution


class _FakeEngineClient:
    execute_count: int = 0
    last_specs: list[dict] = []
    _seen: dict[str, int] = {}

    @classmethod
    def reset(cls) -> None:
        cls.execute_count = 0
        cls.last_specs = []
        cls._seen = {}

    async def execute_query(
        self,
        *,
        query_spec: dict,
        datasource_id: int | None = None,
        workspace_id: int | None = None,
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict:
        _ = datasource_id
        _ = workspace_id
        _ = dataset_id
        _ = datasource_url
        _ = actor_user_id
        _ = correlation_id
        self.__class__.execute_count += 1
        self.__class__.last_specs.append(query_spec)

        canonical = json.dumps(query_spec, sort_keys=True, separators=(",", ":"), default=str)
        seen = self.__class__._seen.get(canonical, 0)
        self.__class__._seen[canonical] = seen + 1

        widget_type = query_spec.get("widget_type")
        if widget_type == "table":
            columns = query_spec.get("columns") or ["c0"]
            rows = [{column: (42 if idx == 0 else f"v{idx}") for idx, column in enumerate(columns)}]
        else:
            rows = [{"m0": 42}]
            columns = ["m0"]

        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "execution_time_ms": 7,
            "sql_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "cache_hit": seen > 0,
            "deduped": False,
        }

    async def execute_query_batch(
        self,
        *,
        queries: list[dict],
        datasource_id: int | None = None,
        workspace_id: int | None = None,
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict:
        _ = datasource_id
        _ = workspace_id
        _ = dataset_id
        _ = datasource_url
        _ = actor_user_id
        _ = correlation_id
        results: list[dict] = []
        grouped: dict[str, dict] = {}
        for item in queries:
            request_id = item.get("request_id")
            spec = item.get("spec", {})
            canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"), default=str)
            if canonical not in grouped:
                grouped[canonical] = {
                    "request_ids": [request_id],
                    "spec": spec,
                }
            else:
                grouped[canonical]["request_ids"].append(request_id)

        for canonical, group in grouped.items():
            base = await self.execute_query(query_spec=group["spec"])
            base["deduped"] = len(group["request_ids"]) > 1
            for request_id in group["request_ids"]:
                results.append({"request_id": request_id, "result": dict(base)})

        ordered = sorted(results, key=lambda item: int(item["request_id"]))
        return {
            "results": ordered,
            "batch_size": len(queries),
            "deduped_count": max(0, len(queries) - len(grouped)),
            "executed_count": len(grouped),
            "cache_hit_count": 0,
        }


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
        database_url="postgresql://fake",
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

    original_get_engine_client = dashboard_execution.get_engine_client
    dashboard_execution.get_engine_client = lambda: _FakeEngineClient()
    _FakeEngineClient.reset()
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        dashboard_execution.get_engine_client = original_get_engine_client
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


def test_non_table_widget_omits_limit_in_engine_payload(client: TestClient) -> None:
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
    assert _FakeEngineClient.last_specs
    assert "limit" not in _FakeEngineClient.last_specs[-1]


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
    assert _FakeEngineClient.last_specs
    assert _FakeEngineClient.last_specs[-1]["filters"][-1]["value"] == "SP"


def test_batch_data_uses_engine_cache(client: TestClient) -> None:
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
    assert _FakeEngineClient.execute_count == 2


def test_identical_non_kpi_widgets_do_not_dedupe_in_monolith(client: TestClient) -> None:
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
    assert all(item["deduped"] is True for item in items)
    assert _FakeEngineClient.execute_count == 1


def test_kpis_are_batched_by_engine_pipeline(client: TestClient) -> None:
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
    assert all(item["batched"] is True for item in items)
    assert _FakeEngineClient.execute_count == 2


def test_debug_queries_dashboard_mode_returns_single_execution_units(client: TestClient) -> None:
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
    assert len(payload["final_items"]) == 2
    ids = sorted([item["widget_ids"][0] for item in payload["final_items"]])
    assert ids == sorted([kpi_1, kpi_2])
    assert all(item["execution_kind"] == "single" for item in payload["final_items"])
    assert all(isinstance(item.get("query_spec"), dict) for item in payload["final_items"])
