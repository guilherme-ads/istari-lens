from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.shared.infrastructure.database import get_db
from app.modules.auth.adapters.api.dependencies import get_current_admin_user
from app.modules.core.legacy.models import Base, User
from app.api.v1.routes import admin_users


engine = create_engine(
    "sqlite+pysqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def _seed_data() -> tuple[User, User]:
    db: Session = TestingSessionLocal()
    db.query(User).delete()
    admin = User(
        email="admin@test.com",
        hashed_password="hashed:secret123",
        full_name="Admin User",
        is_admin=True,
        is_active=True,
    )
    regular = User(
        email="regular@test.com",
        hashed_password="hashed:secret123",
        full_name="Regular User",
        is_admin=False,
        is_active=True,
    )
    db.add_all([admin, regular])
    db.commit()
    db.refresh(admin)
    db.refresh(regular)
    db.close()
    return admin, regular


def _make_client(as_admin: bool = True) -> tuple[TestClient, User]:
    admin, regular = _seed_data()
    current_user = admin if as_admin else regular
    app = FastAPI()
    app.include_router(admin_users.router)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    if as_admin:
        app.dependency_overrides[get_current_admin_user] = lambda: current_user
    else:
        def _forbidden():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        app.dependency_overrides[get_current_admin_user] = _forbidden

    return TestClient(app), admin


def _patch_hashing() -> None:
    admin_users.hash_password = lambda password: f"hashed:{password}"  # type: ignore[assignment]


def test_list_users_with_search_pagination_and_sort():
    _patch_hashing()
    client, _ = _make_client()
    response = client.get("/admin/users?search=regular&page=1&page_size=10&sort=email:asc")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert len(payload["items"]) == 1
    assert payload["items"][0]["email"] == "regular@test.com"


def test_create_user_and_prevent_duplicate_email():
    _patch_hashing()
    client, _ = _make_client()
    create = client.post(
        "/admin/users",
        json={
            "name": "New User",
            "email": "new@test.com",
            "role": "USER",
            "is_active": True,
            "password": "strongpass1",
        },
    )
    assert create.status_code == 201
    assert create.json()["email"] == "new@test.com"
    assert create.json()["role"] == "USER"

    duplicate = client.post(
        "/admin/users",
        json={
            "name": "New User 2",
            "email": "new@test.com",
            "role": "ADMIN",
            "is_active": True,
            "password": "strongpass1",
        },
    )
    assert duplicate.status_code == 409


def test_update_user_and_reset_password():
    _patch_hashing()
    client, _ = _make_client()
    users = client.get("/admin/users").json()["items"]
    target = next(item for item in users if item["email"] == "regular@test.com")
    user_id = target["id"]

    updated = client.patch(
        f"/admin/users/{user_id}",
        json={"name": "Renamed User", "role": "ADMIN", "is_active": True},
    )
    assert updated.status_code == 200
    assert updated.json()["full_name"] == "Renamed User"
    assert updated.json()["role"] == "ADMIN"

    reset = client.post(f"/admin/users/{user_id}/reset-password", json={"password": "newstrongpass1"})
    assert reset.status_code == 200


def test_soft_delete_user_and_self_delete_block():
    _patch_hashing()
    client, admin = _make_client()
    users = client.get("/admin/users").json()["items"]
    target = next(item for item in users if item["email"] == "regular@test.com")
    deleted = client.delete(f"/admin/users/{target['id']}")
    assert deleted.status_code == 204

    list_after_delete = client.get("/admin/users").json()["items"]
    emails = [item["email"] for item in list_after_delete]
    assert "regular@test.com" not in emails

    self_delete = client.delete(f"/admin/users/{admin.id}")
    assert self_delete.status_code == 400


def test_non_admin_access_is_forbidden():
    _patch_hashing()
    client, _ = _make_client(as_admin=False)
    response = client.get("/admin/users")
    assert response.status_code == 403

