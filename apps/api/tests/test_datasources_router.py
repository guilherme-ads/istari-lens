from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import datasources
from app.modules.auth.adapters.api.dependencies import (
    get_current_admin_user,
    get_current_user,
)
from app.modules.core.legacy.models import (
    Base,
    Dashboard,
    DashboardWidget,
    Dataset,
    DataSource,
    User,
    View,
)


def _create_app() -> tuple[TestClient, sessionmaker, int, int, int, int]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    testing_session_local = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine,
    )
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(
        email="datasource-delete@test.com",
        hashed_password="x",
        is_admin=True,
        is_active=True,
    )
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
        created_by_id=user.id,
        is_active=False,
    )
    session.add(datasource)
    session.flush()

    view = View(
        datasource_id=datasource.id,
        schema_name="public",
        view_name="vw_sales",
        is_active=True,
    )
    session.add(view)
    session.flush()

    dataset = Dataset(
        datasource_id=datasource.id,
        view_id=view.id,
        name="Sales",
        description="",
        is_active=True,
    )
    session.add(dataset)
    session.flush()

    dashboard = Dashboard(
        dataset_id=dataset.id,
        name="Main",
        layout_config=[],
        created_by_id=user.id,
    )
    session.add(dashboard)
    session.flush()

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type="kpi",
        title="Total",
        position=0,
        query_config={
            "widget_type": "kpi",
            "metrics": [{"op": "count", "column": "id"}],
        },
        config_version=1,
    )
    session.add(widget)
    session.commit()

    current_user = SimpleNamespace(
        id=user.id,
        email=user.email,
        is_admin=True,
        is_active=True,
    )

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(datasources.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_current_admin_user] = lambda: current_user
    app.dependency_overrides[datasources.get_db] = _get_db

    return (
        TestClient(app),
        testing_session_local,
        datasource.id,
        dataset.id,
        dashboard.id,
        widget.id,
    )


def test_delete_datasource_removes_related_dashboards_and_widgets() -> None:
    client, session_factory, datasource_id, dataset_id, dashboard_id, widget_id = _create_app()

    with client:
        response = client.delete(f"/datasources/{datasource_id}")
    assert response.status_code == 204, response.text

    session: Session = session_factory()
    try:
        assert session.get(DataSource, datasource_id) is None
        assert session.get(Dataset, dataset_id) is None
        assert session.get(Dashboard, dashboard_id) is None
        assert session.get(DashboardWidget, widget_id) is None
    finally:
        session.close()
