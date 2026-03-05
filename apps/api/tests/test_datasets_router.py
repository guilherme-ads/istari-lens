from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import datasets
from app.modules.auth.adapters.api.dependencies import get_current_admin_user, get_current_user
from app.modules.core.legacy.models import Base, Dashboard, DashboardWidget, Dataset, DataSource, User, View, ViewColumn


def _create_app() -> tuple[TestClient, sessionmaker, int, int, int]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="datasets@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
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
            ViewColumn(view_id=view.id, column_name="id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="created_at", column_type="timestamp", is_aggregatable=False, is_groupable=True),
        ]
    )

    dataset = Dataset(datasource_id=datasource.id, view_id=view.id, name="Sales", description="", is_active=True)
    session.add(dataset)
    session.flush()

    dashboard = Dashboard(dataset_id=dataset.id, name="Main", layout_config=[], created_by_id=user.id)
    session.add(dashboard)
    session.flush()

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type="kpi",
        title="Total",
        position=0,
        query_config={"widget_type": "kpi", "metrics": [{"op": "count", "column": "id"}]},
        config_version=1,
    )
    session.add(widget)
    session.commit()

    current_user = SimpleNamespace(id=user.id, email=user.email, is_admin=True, is_active=True)

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(datasets.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_current_admin_user] = lambda: current_user
    app.dependency_overrides[datasets.get_db] = _get_db

    return TestClient(app), testing_session_local, dataset.id, dashboard.id, widget.id


def test_delete_dataset_removes_related_dashboards_and_widgets() -> None:
    client, session_factory, dataset_id, dashboard_id, widget_id = _create_app()

    with client:
        response = client.delete(f"/datasets/{dataset_id}")
    assert response.status_code == 204, response.text

    session: Session = session_factory()
    try:
        assert session.get(Dataset, dataset_id) is None
        assert session.get(Dashboard, dashboard_id) is None
        assert session.get(DashboardWidget, widget_id) is None
    finally:
        session.close()


def test_update_dataset_allows_authenticated_user() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id = _create_app()

    with client:
        response = client.patch(
            f"/datasets/{dataset_id}",
            json={
                "name": "Sales Updated",
                "description": "updated description",
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["name"] == "Sales Updated"
    assert payload["description"] == "updated description"

    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        assert dataset.name == "Sales Updated"
        assert dataset.description == "updated description"
    finally:
        session.close()


def test_list_datasets_recomputes_semantic_columns_from_base_query_spec() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.base_query_spec = {
            "version": 1,
            "source": {"datasource_id": int(dataset.datasource_id)},
            "base": {
                "primary_resource": "public.vw_sales",
                "resources": [{"id": "base", "resource_id": "public.vw_sales"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {
                    "include": [
                        {"resource": "base", "column": "created_at", "alias": "data_ref"},
                    ],
                    "exclude": [],
                },
                "computed_columns": [],
                "filters": [],
            },
        }
        dataset.semantic_columns = [{"name": "data_ref", "type": "text", "source": "projected"}]
        session.commit()
    finally:
        session.close()

    with client:
        response = client.get("/datasets")
    assert response.status_code == 200, response.text
    payload = response.json()
    row = next(item for item in payload if item["id"] == dataset_id)
    semantic = row.get("semantic_columns") or []
    target = next(item for item in semantic if item["name"] == "data_ref")
    assert target["type"] == "temporal"
