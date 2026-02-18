from __future__ import annotations

from cryptography.fernet import InvalidToken
from fastapi import HTTPException

from app.modules.core.legacy.models import DataSource
from app.modules.security.adapters.fernet_vault import FernetSecretsVaultAdapter

_vault = FernetSecretsVaultAdapter()


def resolve_datasource_url(datasource: DataSource | None) -> str | None:
    if datasource is None:
        return None

    raw_value = getattr(datasource, "database_url", None)
    if not raw_value:
        return None

    try:
        return _vault.decrypt(raw_value)
    except InvalidToken as exc:
        if raw_value.startswith("postgresql://") or raw_value.startswith("postgresql+psycopg://"):
            return raw_value
        raise HTTPException(
            status_code=400,
            detail="Datasource credentials are invalid for current encryption key. Recreate datasource.",
        ) from exc
