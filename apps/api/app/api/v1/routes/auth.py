from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import User
from app.modules.core.legacy.schemas import (
    UserChangePasswordRequest,
    UserLogin,
    UserMeUpdateRequest,
    UserRegister,
    TokenResponse,
    UserResponse,
)
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.auth.application.security import hash_password, verify_password, create_access_token
from app.shared.infrastructure.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

def _normalize_email(email: str) -> str:
    return email.strip().lower()


@router.post("/login", response_model=TokenResponse)
async def login(request: UserLogin, db: Session = Depends(get_db)):
    """Authenticate user and return JWT token"""
    normalized_email = _normalize_email(request.email)
    user = (
        db.query(User)
        .filter(func.lower(User.email) == normalized_email, User.deleted_at.is_(None))
        .first()
    )
    
    if not user or not verify_password(request.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password"
        )
    
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User is inactive"
        )

    user.last_login_at = datetime.utcnow()
    db.commit()
    
    access_token = create_access_token(data={"sub": str(user.id)})
    
    return TokenResponse(
        access_token=access_token,
        user=UserResponse.model_validate(user)
    )


@router.post("/register", response_model=TokenResponse)
async def register(request: UserRegister, db: Session = Depends(get_db)):
    """Register new user (admin only for now)"""
    # In production, restrict this or require admin creation
    normalized_email = _normalize_email(request.email)
    existing_user = (
        db.query(User)
        .filter(func.lower(User.email) == normalized_email, User.deleted_at.is_(None))
        .first()
    )
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )
    
    new_user = User(
        email=normalized_email,
        hashed_password=hash_password(request.password),
        full_name=request.full_name,
        is_admin=False
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    access_token = create_access_token(data={"sub": str(new_user.id)})
    
    return TokenResponse(
        access_token=access_token,
        user=UserResponse.model_validate(new_user)
    )


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return UserResponse.model_validate(current_user)


@router.patch("/me", response_model=UserResponse)
async def update_me(
    request: UserMeUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if request.email is not None:
        if not current_user.is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admins can change email",
            )
        normalized_email = _normalize_email(request.email)
        existing = (
            db.query(User)
            .filter(
                func.lower(User.email) == normalized_email,
                User.id != current_user.id,
                User.deleted_at.is_(None),
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already registered",
            )
        current_user.email = normalized_email

    if request.full_name is not None:
        current_user.full_name = request.full_name.strip()

    db.commit()
    db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    request: UserChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(request.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    if request.current_password == request.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from current password",
        )

    current_user.hashed_password = hash_password(request.new_password)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


