import logging
from typing import Any

from app.shared.infrastructure.settings import get_settings

settings = get_settings()
logger = logging.getLogger("uvicorn.error")


def _safe_params(params: list[Any] | tuple[Any, ...]) -> list[str]:
    normalized: list[str] = []
    for value in params:
        if value is None:
            normalized.append("NULL")
            continue
        text = str(value)
        if len(text) > 200:
            text = text[:200] + "...(truncated)"
        normalized.append(text)
    return normalized


def log_external_query(
    *,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
    context: str,
    datasource_id: int | None = None,
) -> None:
    """
    Emits observability logs for SQL sent to external databases.
    Controlled via LOG_EXTERNAL_QUERIES and LOG_EXTERNAL_QUERY_PARAMS.
    """
    if not settings.log_external_queries:
        return

    payload: dict[str, Any] = {
        "context": context,
        "datasource_id": datasource_id,
        "sql": sql,
    }
    if settings.log_external_query_params and params is not None:
        payload["params"] = _safe_params(params)

    logger.info("external_query | %s", payload)
