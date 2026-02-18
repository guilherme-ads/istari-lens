from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc, func, or_
from sqlalchemy.orm import Session

from app.modules.auth.application.security import hash_password
from app.shared.infrastructure.database import get_db
from app.modules.auth.adapters.api.dependencies import get_current_admin_user
from app.modules.core.legacy.models import User
from app.modules.core.legacy.schemas import (
    AdminUserCreateRequest,
    AdminUserListResponse,
    AdminUserResetPasswordRequest,
    AdminUserResponse,
    AdminUserUpdateRequest,
)

router = APIRouter(prefix="/admin/users", tags=["admin"])

SortField = Literal["name", "email", "created_at", "updated_at", "last_login_at", "role"]
SortDir = Literal["asc", "desc"]


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _to_response(user: User) -> AdminUserResponse:
    role = "ADMIN" if user.is_admin else "USER"
    return AdminUserResponse(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=role,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
        last_login_at=user.last_login_at,
        deleted_at=user.deleted_at,
    )


@router.get("", response_model=AdminUserListResponse)
async def list_users(
    search: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    sort: str = Query(default="updated_at:desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    del current_user
    sort_field: SortField = "updated_at"
    sort_dir: SortDir = "desc"
    if ":" in sort:
        raw_field, raw_dir = sort.split(":", 1)
        if raw_field in {"name", "email", "created_at", "updated_at", "last_login_at", "role"}:
            sort_field = raw_field  # type: ignore[assignment]
        if raw_dir in {"asc", "desc"}:
            sort_dir = raw_dir  # type: ignore[assignment]

    query = db.query(User).filter(User.deleted_at.is_(None))
    if search:
        like = f"%{search.strip()}%"
        query = query.filter(or_(User.full_name.ilike(like), User.email.ilike(like)))

    if sort_field == "name":
        order_col = User.full_name
    elif sort_field == "email":
        order_col = User.email
    elif sort_field == "created_at":
        order_col = User.created_at
    elif sort_field == "last_login_at":
        order_col = User.last_login_at
    elif sort_field == "role":
        order_col = User.is_admin
    else:
        order_col = User.updated_at

    total = query.with_entities(func.count(User.id)).scalar() or 0
    ordering = asc(order_col) if sort_dir == "asc" else desc(order_col)
    users = (
        query.order_by(ordering, desc(User.id))
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return AdminUserListResponse(
        items=[_to_response(user) for user in users],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{user_id}", response_model=AdminUserResponse)
async def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    del current_user
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return _to_response(user)


@router.post("", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    request: AdminUserCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    del current_user
    normalized_email = _normalize_email(request.email)
    existing = db.query(User).filter(func.lower(User.email) == normalized_email, User.deleted_at.is_(None)).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(
        email=normalized_email,
        full_name=request.name.strip(),
        hashed_password=hash_password(request.password),
        is_admin=request.role == "ADMIN",
        is_active=request.is_active,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _to_response(user)


@router.patch("/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: int,
    request: AdminUserUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if request.email is not None:
        normalized_email = _normalize_email(request.email)
        existing = (
            db.query(User)
            .filter(func.lower(User.email) == normalized_email, User.id != user_id, User.deleted_at.is_(None))
            .first()
        )
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
        user.email = normalized_email

    if request.name is not None:
        user.full_name = request.name.strip()
    if request.role is not None:
        user.is_admin = request.role == "ADMIN"
    if request.is_active is not None:
        user.is_active = request.is_active

    if current_user.id == user.id and request.role == "USER":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot remove your own admin role")
    if current_user.id == user.id and request.is_active is False:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot deactivate your own user")

    db.commit()
    db.refresh(user)
    return _to_response(user)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if current_user.id == user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own user")

    user.is_active = False
    user.deleted_at = datetime.utcnow()
    db.commit()
    return None


@router.post("/{user_id}/reset-password", response_model=AdminUserResponse)
async def reset_user_password(
    user_id: int,
    request: AdminUserResetPasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    del current_user
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    user.hashed_password = hash_password(request.password)
    db.commit()
    db.refresh(user)
    return _to_response(user)


