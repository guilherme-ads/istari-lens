from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


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
