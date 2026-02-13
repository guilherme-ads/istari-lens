import pytest
from sqlalchemy.orm import Session
from app.models import User
from app.auth import hash_password
from app.database import SessionLocal

@pytest.fixture
def db():
    """Database session for tests"""
    db = SessionLocal()
    yield db
    db.close()

@pytest.fixture
def admin_user(db: Session):
    """Create a test admin user"""
    user = User(
        email="admin_test@test.com",
        hashed_password=hash_password("testpass"),
        is_admin=True,
        full_name="Test Admin"
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

def test_user_creation(db: Session, admin_user: User):
    """Test user creation"""
    assert admin_user.email == "admin_test@test.com"
    assert admin_user.is_admin is True
