from datetime import datetime, timedelta
from typing import Optional
import jwt
from passlib.context import CryptContext
from app.shared.infrastructure.settings import get_settings

settings = get_settings()


def _build_pwd_context() -> CryptContext:
    argon_ctx = CryptContext(schemes=["argon2"], deprecated="auto")
    try:
        # Probe backend availability once at startup.
        argon_ctx.hash("istari-probe")
        return argon_ctx
    except Exception:
        return CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


pwd_context = _build_pwd_context()

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt

def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
        return payload
    except jwt.InvalidTokenError:
        return None

