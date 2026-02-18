from collections.abc import Generator

from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import Base, DataSource, Dataset, User, View
from app.api.v1.routes import queries


class _FakeEngineClient:
    def __init__(self) -> None:
        self.last_single_spec: dict | None = None
        self.last_batch_queries: list[dict] = []
        self.batch_calls: list[dict] = []

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
        self.last_single_spec = query_spec
        return {
            "columns": ["m0"],
            "rows": [{"m0": 7}],
            "row_count": 1,
            "execution_time_ms": 5,
            "sql_hash": "hash-1",
            "cache_hit": False,
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
        _ = datasource_url
        _ = actor_user_id
        _ = correlation_id
        self.last_batch_queries = queries
        self.batch_calls.append(
            {
                "dataset_id": dataset_id,
                "queries": queries,
            }
        )
        return {
            "results": [
                {
                    "request_id": item["request_id"],
                    "result": {
                        "columns": ["m0"],
                        "rows": [{"m0": 11}],
                        "row_count": 1,
                        "execution_time_ms": 4,
                        "sql_hash": "hash-batch",
                        "cache_hit": False,
                        "deduped": False,
                    },
                }
                for item in queries
            ],
            "batch_size": len(queries),
            "deduped_count": 0,
            "executed_count": len(queries),
            "cache_hit_count": 0,
        }


class _FailingEngineClient:
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
        _ = query_spec
        _ = datasource_id
        _ = workspace_id
        _ = dataset_id
        _ = datasource_url
        _ = actor_user_id
        _ = correlation_id
        raise HTTPException(status_code=422, detail={"error": {"code": "invalid_spec", "message": "invalid"}})

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
        _ = queries
        _ = datasource_id
        _ = workspace_id
        _ = dataset_id
        _ = datasource_url
        _ = actor_user_id
        _ = correlation_id
        raise HTTPException(status_code=422, detail={"error": {"code": "invalid_spec", "message": "invalid"}})



def _create_test_data(session: Session, *, is_admin: bool = True, datasource_owner_id: int | None = None) -> User:
    user = User(email="query@test.com", hashed_password="x", is_admin=is_admin, is_active=True)
    session.add(user)
    session.flush()

    owner_id = datasource_owner_id if datasource_owner_id is not None else user.id

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
        created_by_id=owner_id,
        is_active=True,
    )
    session.add(datasource)
    session.flush()

    view = View(
        datasource_id=datasource.id,
        schema_name="public",
        view_name="vw_growth_users",
        is_active=True,
    )
    session.add(view)
    session.flush()

    dataset = Dataset(
        datasource_id=datasource.id,
        view_id=view.id,
        name="Growth Users",
        is_active=True,
    )
    session.add(dataset)

    second_view = View(
        datasource_id=datasource.id,
        schema_name="public",
        view_name="vw_growth_users_secondary",
        is_active=True,
    )
    session.add(second_view)
    session.flush()
    second_dataset = Dataset(
        datasource_id=datasource.id,
        view_id=second_view.id,
        name="Growth Users Secondary",
        is_active=True,
    )
    session.add(second_dataset)
    session.commit()
    return user



def _build_client(*, is_admin: bool = True, datasource_owner_id: int | None = None) -> tuple[TestClient, _FakeEngineClient]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    user = _create_test_data(session, is_admin=is_admin, datasource_owner_id=datasource_owner_id)

    def _get_db() -> Generator[Session, None, None]:
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    fake_engine_client = _FakeEngineClient()
    original_get_engine_client = queries.get_engine_client

    app = FastAPI()
    app.include_router(queries.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[queries.get_db] = _get_db

    queries.get_engine_client = lambda: fake_engine_client

    client = TestClient(app)

    def _cleanup() -> None:
        queries.get_engine_client = original_get_engine_client
        session.close()

    client._cleanup = _cleanup  # type: ignore[attr-defined]
    return client, fake_engine_client



def test_preview_uses_engine_without_local_semantic_validation() -> None:
    client, fake_engine = _build_client()
    try:
        response = client.post(
            "/query/preview",
            json={
                "datasetId": 1,
                "metrics": [{"field": "non_existing_column", "agg": "sum"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 10,
                "offset": 0,
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["columns"] == ["m0"]
        assert payload["rows"] == [{"m0": 7}]
        assert fake_engine.last_single_spec is not None
        assert fake_engine.last_single_spec["metrics"][0]["field"] == "non_existing_column"
    finally:
        client._cleanup()  # type: ignore[attr-defined]



def test_preview_batch_uses_engine_batch_endpoint() -> None:
    client, fake_engine = _build_client()
    try:
        response = client.post(
            "/query/preview/batch",
            json={
                "queries": [
                    {
                        "widget_id": "w1",
                        "spec": {
                            "datasetId": 1,
                            "metrics": [{"field": "*", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                    {
                        "widget_id": "w2",
                        "spec": {
                            "datasetId": 1,
                            "metrics": [{"field": "*", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                ]
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert len(payload["results"]) == 2
        assert payload["results"][0]["widget_id"] == "w1"
        assert payload["results"][1]["widget_id"] == "w2"
        assert len(fake_engine.last_batch_queries) == 2
    finally:
        client._cleanup()  # type: ignore[attr-defined]


def test_preview_repasses_engine_error_payload() -> None:
    client, _ = _build_client()
    original_get_engine_client = queries.get_engine_client
    queries.get_engine_client = lambda: _FailingEngineClient()
    try:
        response = client.post(
            "/query/preview",
            json={
                "datasetId": 1,
                "metrics": [{"field": "x", "agg": "sum"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 10,
                "offset": 0,
            },
        )
        assert response.status_code == 422
        assert response.json()["detail"]["error"]["code"] == "invalid_spec"
    finally:
        queries.get_engine_client = original_get_engine_client
        client._cleanup()  # type: ignore[attr-defined]


def test_preview_batch_splits_calls_for_different_dataset_ids() -> None:
    client, fake_engine = _build_client()
    try:
        response = client.post(
            "/query/preview/batch",
            json={
                "queries": [
                    {
                        "widget_id": "w1",
                        "spec": {
                            "datasetId": 1,
                            "metrics": [{"field": "*", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                    {
                        "widget_id": "w2",
                        "spec": {
                            "datasetId": 2,
                            "metrics": [{"field": "*", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                ]
            },
        )
        assert response.status_code == 200, response.text
        assert len(fake_engine.batch_calls) == 2
        dataset_ids = sorted(int(item["dataset_id"]) for item in fake_engine.batch_calls)
        assert dataset_ids == [1, 2]
    finally:
        client._cleanup()  # type: ignore[attr-defined]


def test_preview_blocks_cross_workspace_user() -> None:
    client, _ = _build_client(is_admin=False, datasource_owner_id=999)
    try:
        response = client.post(
            "/query/preview",
            json={
                "datasetId": 1,
                "metrics": [{"field": "x", "agg": "sum"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 10,
                "offset": 0,
            },
        )
        assert response.status_code == 403
        assert response.json()["detail"] == "User is not authorized for datasource workspace"
    finally:
        client._cleanup()  # type: ignore[attr-defined]
