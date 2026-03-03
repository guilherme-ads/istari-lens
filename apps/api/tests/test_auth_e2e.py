from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import admin_users, auth
from app.modules.auth.application.security import hash_password
from app.modules.core.legacy.models import Base, User
from app.shared.infrastructure.database import get_db


engine = create_engine(
    "sqlite+pysqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(auth.router)
    app.include_router(admin_users.router)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


def _seed_users() -> tuple[User, User]:
    db: Session = TestingSessionLocal()
    db.query(User).delete()
    admin = User(
        email="admin@test.com",
        hashed_password=hash_password("adminpass123"),
        full_name="Admin",
        is_admin=True,
        is_active=True,
    )
    regular = User(
        email="user@test.com",
        hashed_password=hash_password("userpass123"),
        full_name="Regular",
        is_admin=False,
        is_active=True,
    )
    db.add_all([admin, regular])
    db.commit()
    db.refresh(admin)
    db.refresh(regular)
    db.close()
    return admin, regular


def _login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    assert "set-cookie" in response.headers
    return response.json()["access_token"]


def test_login_is_case_insensitive_and_change_password_flow():
    _seed_users()
    client = _make_client()

    token = _login(client, "  USER@TEST.COM  ", "userpass123")
    wrong_current = client.post(
        "/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "wrongpass123", "new_password": "newpass1234"},
    )
    assert wrong_current.status_code == 400
    assert wrong_current.json()["detail"] == "Current password is incorrect"

    changed = client.post(
        "/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "userpass123", "new_password": "newpass1234"},
    )
    assert changed.status_code == 204

    old_login = client.post("/auth/login", json={"email": "user@test.com", "password": "userpass123"})
    assert old_login.status_code == 401

    new_login = client.post("/auth/login", json={"email": "USER@test.com", "password": "newpass1234"})
    assert new_login.status_code == 200


def test_register_normalizes_email_and_blocks_case_duplicate():
    _seed_users()
    client = _make_client()

    duplicate = client.post(
        "/auth/register",
        json={"email": " USER@TEST.COM ", "password": "anotherpass123", "full_name": "Dup"},
    )
    assert duplicate.status_code == 400
    assert duplicate.json()["detail"] == "Email already registered"

    created = client.post(
        "/auth/register",
        json={"email": "  New.User@Example.COM ", "password": "strongpass123", "full_name": "New"},
    )
    assert created.status_code == 200
    assert created.json()["user"]["email"] == "new.user@example.com"


def test_me_update_profile_email_rules():
    _seed_users()
    client = _make_client()
    user_token = _login(client, "user@test.com", "userpass123")
    admin_token = _login(client, "admin@test.com", "adminpass123")

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {user_token}"})
    assert me.status_code == 200
    assert me.json()["email"] == "user@test.com"

    user_only_name = client.patch(
        "/auth/me",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"full_name": "Updated User"},
    )
    assert user_only_name.status_code == 200
    assert user_only_name.json()["full_name"] == "Updated User"

    forbidden_email = client.patch(
        "/auth/me",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"email": "user.renamed@test.com"},
    )
    assert forbidden_email.status_code == 403
    assert forbidden_email.json()["detail"] == "Only admins can change email"

    updated = client.patch(
        "/auth/me",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"email": "  ADMIN.RENAMED@TEST.COM ", "full_name": "Admin Updated"},
    )
    assert updated.status_code == 200
    assert updated.json()["email"] == "admin.renamed@test.com"
    assert updated.json()["full_name"] == "Admin Updated"

    duplicate = client.patch(
        "/auth/me",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"email": "user@test.com"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "Email already registered"


def test_admin_only_delete_and_reset_password_flow():
    admin, regular = _seed_users()
    client = _make_client()

    user_token = _login(client, "user@test.com", "userpass123")
    admin_token = _login(client, "admin@test.com", "adminpass123")

    forbidden = client.get("/admin/users", headers={"Authorization": f"Bearer {user_token}"})
    assert forbidden.status_code == 403

    reset = client.post(
        f"/admin/users/{regular.id}/reset-password",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"password": "resetpass123"},
    )
    assert reset.status_code == 200

    old_login = client.post("/auth/login", json={"email": "user@test.com", "password": "userpass123"})
    assert old_login.status_code == 401
    assert old_login.json()["detail"] == "Invalid email or password"

    _login(client, "user@test.com", "resetpass123")

    deleted = client.delete(f"/admin/users/{regular.id}", headers={"Authorization": f"Bearer {admin_token}"})
    assert deleted.status_code == 204

    deleted_login = client.post("/auth/login", json={"email": "user@test.com", "password": "resetpass123"})
    assert deleted_login.status_code == 401
    assert deleted_login.json()["detail"] == "Invalid email or password"

    self_delete = client.delete(f"/admin/users/{admin.id}", headers={"Authorization": f"Bearer {admin_token}"})
    assert self_delete.status_code == 400
    assert self_delete.json()["detail"] == "You cannot delete your own user"


def test_refresh_rotation_and_logout():
    _seed_users()
    client = _make_client()

    _login(client, "user@test.com", "userpass123")
    refresh = client.post("/auth/refresh")
    assert refresh.status_code == 200
    assert "access_token" in refresh.json()

    logout = client.post("/auth/logout")
    assert logout.status_code == 204

    refresh_after_logout = client.post("/auth/refresh")
    assert refresh_after_logout.status_code == 401


def test_logout_all_revokes_active_sessions():
    _seed_users()
    client = _make_client()

    access_token = _login(client, "user@test.com", "userpass123")
    logout_all = client.post("/auth/logout-all", headers={"Authorization": f"Bearer {access_token}"})
    assert logout_all.status_code == 204

    refresh_after_logout_all = client.post("/auth/refresh")
    assert refresh_after_logout_all.status_code == 401
