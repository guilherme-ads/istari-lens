from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import imports
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import Base, DataSource, SpreadsheetImport, User


def _create_app() -> tuple[TestClient, sessionmaker, int]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="imports@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()
    user_id = int(user.id)
    user_email = str(user.email)
    datasource = DataSource(
        name="external-db",
        description="",
        database_url="postgresql://fake",
        created_by_id=user_id,
        is_active=True,
        copy_policy="allowed",
    )
    session.add(datasource)
    session.commit()
    datasource_id = int(datasource.id)
    session.close()

    current_user = SimpleNamespace(id=user_id, email=user_email, is_admin=True, is_active=True)

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(imports.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[imports.get_db] = _get_db

    return TestClient(app), testing_session_local, datasource_id


def test_create_import_uses_existing_datasource_when_datasource_id_is_provided() -> None:
    client, session_factory, datasource_id = _create_app()

    with client:
        response = client.post(
            "/imports/create",
            json={
                "tenant_id": 1,
                "name": "Sales Sheet",
                "datasource_id": datasource_id,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["datasource_id"] == datasource_id

    session: Session = session_factory()
    try:
        datasource_count = session.query(DataSource).count()
        assert datasource_count == 1
        created_import = session.query(SpreadsheetImport).filter(SpreadsheetImport.id == payload["id"]).first()
        assert created_import is not None
        assert created_import.datasource_id == datasource_id
    finally:
        session.close()


def test_create_import_rejects_forbidden_datasource_copy_policy() -> None:
    client, session_factory, datasource_id = _create_app()
    session: Session = session_factory()
    try:
        datasource = session.get(DataSource, datasource_id)
        assert datasource is not None
        datasource.copy_policy = "forbidden"
        session.commit()
    finally:
        session.close()

    with client:
        response = client.post(
            "/imports/create",
            json={
                "tenant_id": 1,
                "name": "Sales Sheet",
                "datasource_id": datasource_id,
            },
        )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Datasource copy_policy forbids imported mode"
