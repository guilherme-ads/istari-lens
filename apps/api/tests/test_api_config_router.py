import asyncio
from collections.abc import Generator
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.crypto import credential_encryptor
from app.dependencies import get_current_admin_user, get_current_user
from app.models import Base, LLMIntegration, User
from app.routers import api_config


def _create_app(with_integration: bool = True) -> tuple[TestClient, sessionmaker]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="api-config@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

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
    current_user_stub = SimpleNamespace(id=user.id, email=user.email, is_admin=True, is_active=True)
    session.close()

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(api_config.router)
    app.dependency_overrides[get_current_user] = lambda: current_user_stub
    app.dependency_overrides[get_current_admin_user] = lambda: current_user_stub
    app.dependency_overrides[api_config.get_db] = _get_db

    return TestClient(app), testing_session_local


def test_integrations_list_returns_all_items() -> None:
    client, session_factory = _create_app(with_integration=True)
    session: Session = session_factory()
    try:
        admin = session.query(User).filter(User.email == "api-config@test.com").first()
        assert admin is not None
        session.add(
            LLMIntegration(
                provider="openai",
                encrypted_api_key=credential_encryptor.encrypt("sk-test-abcdefghij-2"),
                model="gpt-4o-mini",
                is_active=False,
                created_by_id=admin.id,
                updated_by_id=admin.id,
            )
        )
        session.commit()
    finally:
        session.close()

    with client:
        response = client.get("/api-config/integrations")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["items"]) == 2
    assert payload["items"][0]["is_active"] is True
    assert payload["items"][1]["is_active"] is False


def test_activate_integration_deactivates_previous_active() -> None:
    client, session_factory = _create_app(with_integration=True)
    session: Session = session_factory()
    try:
        admin = session.query(User).filter(User.email == "api-config@test.com").first()
        assert admin is not None
        second = LLMIntegration(
            provider="openai",
            encrypted_api_key=credential_encryptor.encrypt("sk-test-abcdefghij-3"),
            model="gpt-4o-mini",
            is_active=False,
            created_by_id=admin.id,
            updated_by_id=admin.id,
        )
        session.add(second)
        session.commit()
        session.refresh(second)
        second_id = second.id
    finally:
        session.close()

    with client:
        response = client.patch(f"/api-config/integrations/{second_id}/activate")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == second_id
    assert payload["is_active"] is True

    session = session_factory()
    try:
        rows = session.query(LLMIntegration).filter(LLMIntegration.provider == "openai").all()
        active_count = len([item for item in rows if item.is_active])
        assert active_count == 1
        assert any(item.id == second_id and item.is_active for item in rows)
    finally:
        session.close()


def test_refresh_billing_persists_snapshot_and_exposes_on_list() -> None:
    client, _session_factory = _create_app(with_integration=True)
    original_fetch_costs = api_config._fetch_openai_costs

    async def _fake_fetch_costs(*, api_key: str, start_time, end_time) -> float:
        _ = api_key, start_time, end_time
        return 12.34

    api_config._fetch_openai_costs = _fake_fetch_costs
    try:
        with client:
            refresh = client.post("/api-config/integrations/billing/refresh")
            listed = client.get("/api-config/integrations")
    finally:
        api_config._fetch_openai_costs = original_fetch_costs

    assert refresh.status_code == 200, refresh.text
    refresh_payload = refresh.json()
    assert refresh_payload["refreshed"] >= 1

    assert listed.status_code == 200, listed.text
    list_payload = listed.json()
    assert len(list_payload["items"]) >= 1
    first = list_payload["items"][0]
    assert first["billing_spent_usd"] == 12.34


def test_extract_billing_total_reads_cost_buckets() -> None:
    payload = {
        "data": [
            {"results": [{"amount": {"value": 1.25, "currency": "usd"}}, {"amount": {"value": 2.0, "currency": "usd"}}]},
            {"results": [{"amount": {"value": 0.75, "currency": "usd"}}]},
        ],
    }
    assert api_config._extract_billing_total_usd(payload) == 4.0


def test_fetch_openai_costs_uses_pagination() -> None:
    original_client = api_config.httpx.AsyncClient
    calls: list[dict] = []

    class _FakeResponse:
        def __init__(self, status_code: int, payload: dict) -> None:
            self.status_code = status_code
            self._payload = payload

        def json(self) -> dict:
            return self._payload

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            _ = args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            _ = exc_type, exc, tb
            return False

        async def get(self, url: str, headers: dict, params: dict):
            _ = url, headers
            calls.append(dict(params))
            if params.get("page") == "cursor_2":
                return _FakeResponse(
                    200,
                    {"data": [{"results": [{"amount": {"value": 3.3, "currency": "usd"}}]}], "has_more": False, "next_page": None},
                )
            return _FakeResponse(
                200,
                {
                    "data": [{"results": [{"amount": {"value": 1.1, "currency": "usd"}}, {"amount": {"value": 2.2, "currency": "usd"}}]}],
                    "has_more": True,
                    "next_page": "cursor_2",
                },
            )

    api_config.httpx.AsyncClient = _FakeAsyncClient
    try:
        total = asyncio.run(
            api_config._fetch_openai_costs(
                api_key="sk-test",
                start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
                end_time=datetime(2026, 1, 31, tzinfo=timezone.utc),
            )
        )
    finally:
        api_config.httpx.AsyncClient = original_client

    assert total == 6.6
    assert calls[0]["bucket_width"] == "1d"
    assert "page" not in calls[0]
    assert calls[1]["page"] == "cursor_2"


def test_fetch_openai_costs_raises_clear_error_on_permission_denied() -> None:
    original_client = api_config.httpx.AsyncClient

    class _FakeResponse:
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code

        def json(self) -> dict:
            return {"error": {"message": "forbidden"}}

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            _ = args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            _ = exc_type, exc, tb
            return False

        async def get(self, url: str, headers: dict, params: dict):
            _ = url, headers, params
            return _FakeResponse(403)

    api_config.httpx.AsyncClient = _FakeAsyncClient
    try:
        try:
            asyncio.run(
                api_config._fetch_openai_costs(
                    api_key="sk-test",
                    start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    end_time=datetime(2026, 1, 31, tzinfo=timezone.utc),
                )
            )
            assert False, "Expected HTTPException for permission denied"
        except api_config.HTTPException as exc:
            assert exc.status_code == 400
            assert "Admin Key" in str(exc.detail)
    finally:
        api_config.httpx.AsyncClient = original_client
