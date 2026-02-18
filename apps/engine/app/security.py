from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Header

from app.errors import EngineError
from app.settings import get_settings

_settings = get_settings()


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(slots=True)
class ServiceAuthContext:
    workspace_id: int | None
    actor_user_id: int | None
    datasource_id: int | None
    dataset_id: int | None
    subject: str | None


def verify_service_token(token: str) -> ServiceAuthContext:
    parts = token.split(".")
    if len(parts) != 3:
        raise EngineError(status_code=401, code="invalid_service_token", message="Invalid service token format")

    header_b64, payload_b64, signature_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")

    expected_sig = hmac.new(
        _settings.engine_service_secret.encode("utf-8"),
        signing_input,
        hashlib.sha256,
    ).digest()
    got_sig = _b64url_decode(signature_b64)
    if not hmac.compare_digest(expected_sig, got_sig):
        raise EngineError(status_code=401, code="invalid_service_token", message="Invalid service token signature")

    payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    now = int(time.time())
    exp = _safe_int(payload.get("exp"))
    if exp is None or exp < now:
        raise EngineError(status_code=401, code="expired_service_token", message="Service token expired")
    if payload.get("aud") != "istari-engine":
        raise EngineError(status_code=401, code="invalid_service_token", message="Invalid service token audience")
    if payload.get("iss") != "istari-api":
        raise EngineError(status_code=401, code="invalid_service_token", message="Invalid service token issuer")

    return ServiceAuthContext(
        workspace_id=_safe_int(payload.get("workspace_id")),
        actor_user_id=_safe_int(payload.get("actor_user_id")),
        datasource_id=_safe_int(payload.get("datasource_id")),
        dataset_id=_safe_int(payload.get("dataset_id")),
        subject=payload.get("sub"),
    )


def require_service_auth(authorization: str | None = Header(default=None)) -> ServiceAuthContext:
    if not authorization:
        raise EngineError(status_code=401, code="missing_service_token", message="Missing service token")
    scheme, _, raw_token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not raw_token:
        raise EngineError(status_code=401, code="invalid_service_token", message="Invalid authorization header")
    return verify_service_token(raw_token)


def mint_service_token(
    *,
    secret: str,
    subject: str,
    workspace_id: int,
    actor_user_id: int | None,
    datasource_id: int,
    dataset_id: int | None,
    ttl_seconds: int = 120,
) -> str:
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": "istari-api",
        "aud": "istari-engine",
        "sub": subject,
        "iat": now,
        "exp": now + ttl_seconds,
        "workspace_id": workspace_id,
        "actor_user_id": actor_user_id,
        "datasource_id": datasource_id,
        "dataset_id": dataset_id,
    }
    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url_encode(sig)}"
