from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import catalog
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import (
    Base,
    DataSource,
    Dataset,
    Dimension,
    Metric,
    MetricDimension,
    User,
    View,
    ViewColumn,
)


def _create_app() -> tuple[TestClient, sessionmaker, int]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="catalog@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()
    user_id = int(user.id)
    user_email = str(user.email)

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
        created_by_id=user.id,
        is_active=True,
    )
    session.add(datasource)
    session.flush()

    view = View(datasource_id=datasource.id, schema_name="public", view_name="recargas", is_active=True)
    session.add(view)
    session.flush()
    session.add_all(
        [
            ViewColumn(view_id=view.id, column_name="id_recarga", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="receita_recarga", column_type="numeric", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view.id, column_name="total_energia", column_type="double precision", is_aggregatable=True, is_groupable=False),
            ViewColumn(view_id=view.id, column_name="data_recarga", column_type="timestamp", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="estacao", column_type="text", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="parceiro", column_type="text", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="cidade", column_type="text", is_aggregatable=False, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="tipo_conector", column_type="text", is_aggregatable=False, is_groupable=True),
        ]
    )

    dataset = Dataset(
        datasource_id=datasource.id,
        view_id=view.id,
        name="recargas",
        description="Dataset de recargas",
        is_active=True,
    )
    session.add(dataset)
    session.commit()
    dataset_id = int(dataset.id)
    session.close()

    current_user = SimpleNamespace(id=user_id, email=user_email, is_admin=True, is_active=True)

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(catalog.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[catalog.get_db] = _get_db

    return TestClient(app), testing_session_local, dataset_id


def test_catalog_datasets_backfills_semantic_catalog() -> None:
    client, session_factory, dataset_id = _create_app()
    with client:
        response = client.get("/catalog/datasets")
    assert response.status_code == 200, response.text
    rows = response.json()
    row = next(item for item in rows if item["id"] == dataset_id)
    assert row["metrics_count"] > 0
    assert row["dimensions_count"] > 0

    session: Session = session_factory()
    try:
        assert session.query(Metric).filter(Metric.dataset_id == dataset_id).count() > 0
        assert session.query(Dimension).filter(Dimension.dataset_id == dataset_id).count() > 0
        assert session.query(MetricDimension).count() > 0
    finally:
        session.close()


def test_catalog_dataset_detail_metrics_and_dimensions() -> None:
    client, _session_factory, dataset_id = _create_app()
    with client:
        detail_response = client.get(f"/catalog/dataset/{dataset_id}")
        metrics_response = client.get(f"/catalog/metrics?dataset={dataset_id}")
        dimensions_response = client.get(f"/catalog/dimensions?dataset={dataset_id}")

    assert detail_response.status_code == 200, detail_response.text
    detail = detail_response.json()
    metric_names = {item["name"] for item in detail["metrics"]}
    dimension_names = {item["name"] for item in detail["dimensions"]}
    assert "receita_total" in metric_names
    assert "numero_recargas" in metric_names
    assert "id_recarga_total" not in metric_names
    assert "id_recarga_medio" not in metric_names
    assert "mes" in dimension_names
    assert "cidade" in dimension_names

    assert metrics_response.status_code == 200, metrics_response.text
    assert any(item["formula"].startswith("SUM(") for item in metrics_response.json())
    assert dimensions_response.status_code == 200, dimensions_response.text
    assert any(item["type"] == "temporal" for item in dimensions_response.json())


def test_catalog_search_returns_dataset_metric_and_dimension_hits() -> None:
    client, _session_factory, dataset_id = _create_app()
    with client:
        response = client.get("/catalog/search", params={"term": "receita", "dataset": dataset_id})
    assert response.status_code == 200, response.text
    payload = response.json()
    kinds = {item["kind"] for item in payload["items"]}
    assert "metric" in kinds


def test_catalog_metric_and_dimension_crud() -> None:
    client, _session_factory, dataset_id = _create_app()
    with client:
        base = client.get(f"/catalog/dataset/{dataset_id}")
        assert base.status_code == 200, base.text

        create_metric = client.post(
            "/catalog/metrics",
            json={
                "dataset_id": dataset_id,
                "name": "ticket_medio_custom",
                "formula": "AVG(receita_recarga)",
                "description": "Ticket medio customizado",
                "unit": "currency",
                "default_grain": "all",
                "synonyms": ["ticket", "tm"],
                "examples": ["Qual o ticket medio?"],
            },
        )
        assert create_metric.status_code == 201, create_metric.text
        metric_id = create_metric.json()["id"]

        update_metric = client.patch(
            f"/catalog/metrics/{metric_id}",
            json={"name": "ticket_medio_custom_v2", "formula": "AVG(receita_recarga)"},
        )
        assert update_metric.status_code == 200, update_metric.text
        assert update_metric.json()["name"] == "ticket_medio_custom_v2"

        create_dimension = client.post(
            "/catalog/dimensions",
            json={
                "dataset_id": dataset_id,
                "name": "turno",
                "description": "Turno da recarga",
                "type": "categorical",
                "synonyms": ["periodo"],
            },
        )
        assert create_dimension.status_code == 201, create_dimension.text
        dimension_id = create_dimension.json()["id"]

        update_dimension = client.patch(
            f"/catalog/dimensions/{dimension_id}",
            json={"name": "turno_operacional", "type": "categorical"},
        )
        assert update_dimension.status_code == 200, update_dimension.text
        assert update_dimension.json()["name"] == "turno_operacional"

        delete_metric = client.delete(f"/catalog/metrics/{metric_id}")
        assert delete_metric.status_code == 204, delete_metric.text

        delete_dimension = client.delete(f"/catalog/dimensions/{dimension_id}")
        assert delete_dimension.status_code == 204, delete_dimension.text


def test_catalog_regenerate_dataset_rebuilds_suggestions() -> None:
    client, _session_factory, dataset_id = _create_app()
    with client:
        detail = client.get(f"/catalog/dataset/{dataset_id}")
        assert detail.status_code == 200, detail.text

        create_metric = client.post(
            "/catalog/metrics",
            json={
                "dataset_id": dataset_id,
                "name": "manual_custom",
                "formula": "COUNT(id_recarga)",
            },
        )
        assert create_metric.status_code == 201, create_metric.text
        manual_metric_id = int(create_metric.json()["id"])

        regenerate = client.post(f"/catalog/dataset/{dataset_id}/regenerate")
        assert regenerate.status_code == 200, regenerate.text
        payload = regenerate.json()
        metric_names = {item["name"] for item in payload["metrics"]}
        metric_ids = {int(item["id"]) for item in payload["metrics"]}
        assert "manual_custom" not in metric_names
        assert manual_metric_id not in metric_ids
        assert "numero_recargas" in metric_names
