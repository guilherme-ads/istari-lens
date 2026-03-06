from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import AuthSession, User
from app.modules.core.legacy.schemas import (
    UserChangePasswordRequest,
    UserLogin,
    UserMeUpdateRequest,
    UserRegister,
    TokenResponse,
    UserResponse,
)
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.auth.application.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)
from app.shared.infrastructure.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _set_refresh_cookie(response: Response, refresh_token: str, *, is_persistent: bool) -> None:
    cookie_kwargs = {
        "key": settings.refresh_cookie_name,
        "value": refresh_token,
        "httponly": True,
        "secure": settings.refresh_cookie_secure,
        "samesite": settings.refresh_cookie_samesite,
        "path": settings.refresh_cookie_path,
    }
    if is_persistent:
        max_age = int(timedelta(days=settings.refresh_token_expire_days).total_seconds())
        cookie_kwargs["max_age"] = max_age
        cookie_kwargs["expires"] = max_age

    response.set_cookie(**cookie_kwargs)


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.refresh_cookie_name,
        path=settings.refresh_cookie_path,
    )


def _build_access_response(user: User, *, remember_me: bool = True) -> TokenResponse:
    access_token = create_access_token(data={"sub": str(user.id)})
    return TokenResponse(
        access_token=access_token,
        remember_me=remember_me,
        user=UserResponse.model_validate(user),
    )


def _create_or_rotate_session(
    *,
    db: Session,
    user: User,
    request: Request,
    is_persistent: bool,
    existing_session: AuthSession | None = None,
) -> str:
    refresh_token = generate_refresh_token()
    refresh_hash = hash_refresh_token(refresh_token)
    now = datetime.utcnow()
    expires_at = now + timedelta(days=settings.refresh_token_expire_days)
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    if existing_session:
        existing_session.token_hash = refresh_hash
        existing_session.is_persistent = is_persistent
        existing_session.expires_at = expires_at
        existing_session.last_used_at = now
        existing_session.ip_address = ip_address
        existing_session.user_agent = user_agent
        existing_session.revoked_at = None
    else:
        db.add(
            AuthSession(
                user_id=user.id,
                token_hash=refresh_hash,
                is_persistent=is_persistent,
                ip_address=ip_address,
                user_agent=user_agent,
                expires_at=expires_at,
                last_used_at=now,
            )
        )
    return refresh_token


@router.post("/login", response_model=TokenResponse)
async def login(payload: UserLogin, response: Response, request: Request, db: Session = Depends(get_db)):
    """Authenticate user and return JWT token"""
    normalized_email = _normalize_email(payload.email)
    user = (
        db.query(User)
        .filter(func.lower(User.email) == normalized_email, User.deleted_at.is_(None))
        .first()
    )
    
    if not user or not verify_password(payload.password, user.hashed_password):
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
    remember_me = bool(payload.remember_me)
    refresh_token = _create_or_rotate_session(
        db=db,
        user=user,
        request=request,
        is_persistent=remember_me,
    )
    db.commit()
    _set_refresh_cookie(response, refresh_token, is_persistent=remember_me)
    return _build_access_response(user, remember_me=remember_me)


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
    
    return _build_access_response(new_user, remember_me=True)


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
    db.query(AuthSession).filter(AuthSession.user_id == current_user.id, AuthSession.revoked_at.is_(None)).update(
        {AuthSession.revoked_at: datetime.utcnow()},
        synchronize_session=False,
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_access_token(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    refresh_token: str | None = Cookie(default=None, alias=settings.refresh_cookie_name),
):
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token not provided")

    now = datetime.utcnow()
    token_hash = hash_refresh_token(refresh_token)
    session = (
        db.query(AuthSession)
        .filter(
            AuthSession.token_hash == token_hash,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .first()
    )
    if not session:
        _clear_refresh_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    user = db.query(User).filter(User.id == session.user_id).first()
    if not user or user.deleted_at is not None or not user.is_active:
        session.revoked_at = now
        db.commit()
        _clear_refresh_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User is inactive")

    remember_me = bool(session.is_persistent)
    new_refresh_token = _create_or_rotate_session(
        db=db,
        user=user,
        request=request,
        is_persistent=remember_me,
        existing_session=session,
    )
    db.commit()
    _set_refresh_cookie(response, new_refresh_token, is_persistent=remember_me)
    return _build_access_response(user, remember_me=remember_me)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    db: Session = Depends(get_db),
    refresh_token: str | None = Cookie(default=None, alias=settings.refresh_cookie_name),
):
    if refresh_token:
        token_hash = hash_refresh_token(refresh_token)
        session = db.query(AuthSession).filter(AuthSession.token_hash == token_hash, AuthSession.revoked_at.is_(None)).first()
        if session:
            session.revoked_at = datetime.utcnow()
            db.commit()

    _clear_refresh_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(AuthSession).filter(AuthSession.user_id == current_user.id, AuthSession.revoked_at.is_(None)).update(
        {AuthSession.revoked_at: datetime.utcnow()},
        synchronize_session=False,
    )
    db.commit()
    _clear_refresh_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


