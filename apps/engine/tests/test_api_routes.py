from fastapi.testclient import TestClient

from app.api import routes
from app.schemas import BatchQueryResponse, BatchQueryResultItem, QueryResult, ResourceList, SchemaDefinition
from app.security import mint_service_token
from main import app


class _FakePipeline:
    async def execute(self, *, spec, datasource_url: str, correlation_id: str | None = None):
        _ = spec
        _ = datasource_url
        _ = correlation_id
        return QueryResult(
            columns=["m0"],
            rows=[{"m0": 1}],
            row_count=1,
            execution_time_ms=3,
            sql_hash="h1",
            cache_hit=False,
            deduped=False,
        )

    async def execute_batch(self, *, specs, datasource_url: str, correlation_id: str | None = None):
        _ = datasource_url
        _ = correlation_id
        items = []
        for request_id, _spec in specs:
            items.append(
                BatchQueryResultItem(
                    request_id=request_id,
                    result=QueryResult(
                        columns=["m0"],
                        rows=[{"m0": 2}],
                        row_count=1,
                        execution_time_ms=4,
                        sql_hash="h2",
                        cache_hit=False,
                        deduped=False,
                    ),
                )
            )
        return BatchQueryResponse(
            results=items,
            batch_size=len(items),
            deduped_count=0,
            executed_count=len(items),
            cache_hit_count=0,
        )

    async def list_resources(self, *, datasource_url: str):
        _ = datasource_url
        return ResourceList(items=[{"id": "public.vw_sales", "schema_name": "public", "resource_name": "vw_sales", "resource_type": "VIEW"}])

    async def get_schema(self, *, datasource_url: str, resource_id: str):
        _ = datasource_url
        return SchemaDefinition(resource_id=resource_id, fields=[{"name": "id", "data_type": "bigint", "nullable": False}])


def _service_token(*, workspace_id: int = 11, datasource_id: int = 77, dataset_id: int | None = 5) -> str:
    return mint_service_token(
        secret="change-me-engine-service-secret",
        subject="tests",
        workspace_id=workspace_id,
        actor_user_id=3,
        datasource_id=datasource_id,
        dataset_id=dataset_id,
    )


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_service_token()}"}


def _register_datasource(client: TestClient) -> None:
    response = client.post(
        "/internal/datasources/register",
        json={
            "datasource_id": 77,
            "datasource_url": "postgresql://fake",
            "workspace_id": 11,
            "dataset_id": 5,
        },
        headers=_auth_headers(),
    )
    assert response.status_code == 200, response.text


def test_query_execute_requires_auth() -> None:
    client = TestClient(app)
    response = client.post(
        "/query/execute",
        json={
            "datasource_id": 77,
            "workspace_id": 11,
            "dataset_id": 5,
            "spec": {
                "resource_id": "public.vw_sales",
                "metrics": [{"field": "id", "agg": "count"}],
                "dimensions": [],
                "filters": [],
                "sort": [],
                "limit": 10,
                "offset": 0,
            },
        },
    )
    assert response.status_code == 401, response.text


def test_query_execute_contract() -> None:
    original = routes._pipeline
    routes._pipeline = _FakePipeline()
    try:
        client = TestClient(app)
        _register_datasource(client)
        response = client.post(
            "/query/execute",
            json={
                "datasource_id": 77,
                "workspace_id": 11,
                "dataset_id": 5,
                "actor_user_id": 3,
                "spec": {
                    "resource_id": "public.vw_sales",
                    "metrics": [{"field": "id", "agg": "count"}],
                    "dimensions": [],
                    "filters": [],
                    "sort": [],
                    "limit": 10,
                    "offset": 0,
                },
            },
            headers=_auth_headers(),
        )
        assert response.status_code == 200, response.text
        assert response.json()["row_count"] == 1
    finally:
        routes._pipeline = original


def test_query_execute_batch_contract() -> None:
    original = routes._pipeline
    routes._pipeline = _FakePipeline()
    try:
        client = TestClient(app)
        _register_datasource(client)
        response = client.post(
            "/query/execute/batch",
            json={
                "datasource_id": 77,
                "workspace_id": 11,
                "dataset_id": 5,
                "queries": [
                    {
                        "request_id": "w1",
                        "spec": {
                            "resource_id": "public.vw_sales",
                            "metrics": [{"field": "id", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                    {
                        "request_id": "w2",
                        "spec": {
                            "resource_id": "public.vw_sales",
                            "metrics": [{"field": "id", "agg": "count"}],
                            "dimensions": [],
                            "filters": [],
                            "sort": [],
                            "limit": 10,
                            "offset": 0,
                        },
                    },
                ],
            },
            headers=_auth_headers(),
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["batch_size"] == 2
        assert payload["results"][0]["request_id"] == "w1"
        assert payload["results"][1]["request_id"] == "w2"
    finally:
        routes._pipeline = original


def test_schema_and_catalog_contracts() -> None:
    original = routes._pipeline
    routes._pipeline = _FakePipeline()
    try:
        client = TestClient(app)
        _register_datasource(client)
        schema_response = client.get(
            "/schema/public.vw_sales",
            params={"datasource_id": 77, "workspace_id": 11, "dataset_id": 5},
            headers=_auth_headers(),
        )
        assert schema_response.status_code == 200, schema_response.text
        assert schema_response.json()["resource_id"] == "public.vw_sales"

        catalog_response = client.get(
            "/catalog/resources",
            params={"datasource_id": 77, "workspace_id": 11, "dataset_id": 5},
            headers=_auth_headers(),
        )
        assert catalog_response.status_code == 200, catalog_response.text
        assert catalog_response.json()["items"][0]["id"] == "public.vw_sales"
    finally:
        routes._pipeline = original


def test_blocks_direct_datasource_header() -> None:
    original_allow = routes._settings.allow_direct_datasource_header
    routes._settings.allow_direct_datasource_header = False
    try:
        client = TestClient(app)
        _register_datasource(client)
        response = client.post(
            "/query/execute",
            json={
                "datasource_id": 77,
                "workspace_id": 11,
                "dataset_id": 5,
                "spec": {"resource_id": "public.vw_sales", "widget_type": "text"},
            },
            headers={
                **_auth_headers(),
                "x-engine-datasource-url": "postgresql://not-allowed",
            },
        )
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "direct_datasource_header_blocked"
    finally:
        routes._settings.allow_direct_datasource_header = original_allow


def test_workspace_authorization_blocked_for_mismatch() -> None:
    original = routes._pipeline
    routes._pipeline = _FakePipeline()
    try:
        client = TestClient(app)
        _register_datasource(client)
        headers = {"Authorization": f"Bearer {_service_token(workspace_id=99)}"}
        response = client.post(
            "/query/execute",
            json={
                "datasource_id": 77,
                "workspace_id": 11,
                "dataset_id": 5,
                "spec": {"resource_id": "public.vw_sales", "widget_type": "text"},
            },
            headers=headers,
        )
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "workspace_mismatch"
    finally:
        routes._pipeline = original
