from __future__ import annotations

import asyncio
import logging
from time import perf_counter

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel

from app.errors import EngineError
from app.schemas import (
    BatchQueryRequest,
    BatchQueryResponse,
    QueryExecuteRequest,
    QueryResult,
    ResourceList,
    SchemaDefinition,
)
from app.security import ServiceAuthContext, require_service_auth
from app.services.datasource_registry import DatasourceRegistry
from app.services.pipeline import QueryPipeline
from app.services.rate_limiter import SlidingWindowRateLimiter
from app.settings import get_settings

router = APIRouter()
_settings = get_settings()
_pipeline = QueryPipeline(_settings)
_registry = DatasourceRegistry(ttl_seconds=_settings.datasource_registry_ttl_seconds)
_rate_limiter = SlidingWindowRateLimiter(max_requests_per_minute=_settings.rate_limit_requests_per_minute)
logger = logging.getLogger("uvicorn.error")


class RegisterDatasourceRequest(BaseModel):
    datasource_id: int
    datasource_url: str
    workspace_id: int
    dataset_id: int | None = None


def _assert_direct_header_policy(header_value: str | None) -> None:
    if header_value and not _settings.allow_direct_datasource_header:
        raise EngineError(
            status_code=403,
            code="direct_datasource_header_blocked",
            message="Direct datasource header is blocked by policy",
        )


def _sanitize_error_message(message: str) -> str:
    lowered = message.lower()
    if "password" in lowered or "postgresql://" in lowered:
        return "Internal processing error"
    return message


def _validate_request_auth(
    *,
    context: ServiceAuthContext,
    workspace_id: int,
    datasource_id: int,
    dataset_id: int | None,
) -> None:
    if context.workspace_id is None or context.workspace_id != workspace_id:
        raise EngineError(status_code=403, code="workspace_mismatch", message="Workspace is not authorized")
    if context.datasource_id is None or context.datasource_id != datasource_id:
        raise EngineError(status_code=403, code="datasource_mismatch", message="Datasource is not authorized")
    if dataset_id is not None and context.dataset_id is not None and context.dataset_id != dataset_id:
        raise EngineError(status_code=403, code="dataset_mismatch", message="Dataset is not authorized")


async def _resolve_registered_datasource(*, datasource_id: int, workspace_id: int, dataset_id: int | None) -> str:
    entry = await _registry.get(datasource_id)
    if entry is None:
        raise EngineError(
            status_code=404,
            code="datasource_not_registered",
            message="Datasource not registered in engine runtime",
        )
    if entry.workspace_id != workspace_id:
        raise EngineError(status_code=403, code="workspace_mismatch", message="Workspace is not authorized")
    if dataset_id is not None and entry.dataset_id is not None and entry.dataset_id != dataset_id:
        raise EngineError(status_code=403, code="dataset_mismatch", message="Dataset is not authorized")
    return entry.datasource_url


async def _enforce_rate_limit(context: ServiceAuthContext) -> None:
    workspace_key = context.workspace_id if context.workspace_id is not None else "unknown"
    actor_key = context.actor_user_id if context.actor_user_id is not None else "system"
    await _rate_limiter.check(f"{workspace_key}:{actor_key}")


def _audit_log(
    *,
    context: ServiceAuthContext,
    datasource_id: int | None,
    dataset_id: int | None,
    operation: str,
    status: str,
    duration_ms: int,
    error_code: str | None = None,
    correlation_id: str | None = None,
) -> None:
    logger.info(
        "engine.audit.execution | %s",
        {
            "workspace_id": context.workspace_id,
            "actor_user_id": context.actor_user_id,
            "datasource_id": datasource_id,
            "dataset_id": dataset_id,
            "operation": operation,
            "status": status,
            "duration_ms": duration_ms,
            "error_code": error_code,
            "correlation_id": correlation_id,
        },
    )


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "engine"}


@router.post("/internal/datasources/register")
async def register_datasource(
    payload: RegisterDatasourceRequest,
    auth: ServiceAuthContext = Depends(require_service_auth),
) -> dict[str, str]:
    _validate_request_auth(
        context=auth,
        workspace_id=payload.workspace_id,
        datasource_id=payload.datasource_id,
        dataset_id=payload.dataset_id,
    )
    await _registry.set(
        datasource_id=payload.datasource_id,
        datasource_url=payload.datasource_url,
        workspace_id=payload.workspace_id,
        dataset_id=payload.dataset_id,
    )
    return {"status": "ok"}


@router.post("/query/execute", response_model=QueryResult)
async def query_execute(
    payload: QueryExecuteRequest,
    x_engine_datasource_url: str | None = Header(default=None),
    x_correlation_id: str | None = Header(default=None),
    auth: ServiceAuthContext = Depends(require_service_auth),
) -> QueryResult:
    _assert_direct_header_policy(x_engine_datasource_url)
    _validate_request_auth(
        context=auth,
        workspace_id=payload.workspace_id,
        datasource_id=payload.datasource_id,
        dataset_id=payload.dataset_id,
    )
    await _enforce_rate_limit(auth)
    started = perf_counter()
    try:
        datasource_url = await _resolve_registered_datasource(
            datasource_id=payload.datasource_id,
            workspace_id=payload.workspace_id,
            dataset_id=payload.dataset_id,
        )
        result = await asyncio.wait_for(
            _pipeline.execute(
                spec=payload.spec,
                datasource_url=datasource_url,
                correlation_id=x_correlation_id,
            ),
            timeout=_settings.execution_timeout_seconds,
        )
        _audit_log(
            context=auth,
            datasource_id=payload.datasource_id,
            dataset_id=payload.dataset_id,
            operation="query.execute",
            status="ok",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            correlation_id=x_correlation_id,
        )
        return result
    except TimeoutError as exc:
        _audit_log(
            context=auth,
            datasource_id=payload.datasource_id,
            dataset_id=payload.dataset_id,
            operation="query.execute",
            status="timeout",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code="execution_timeout",
            correlation_id=x_correlation_id,
        )
        raise EngineError(status_code=504, code="execution_timeout", message="Query execution timed out") from exc
    except EngineError as exc:
        _audit_log(
            context=auth,
            datasource_id=payload.datasource_id,
            dataset_id=payload.dataset_id,
            operation="query.execute",
            status="error",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code=exc.code,
            correlation_id=x_correlation_id,
        )
        raise
    except Exception as exc:
        _audit_log(
            context=auth,
            datasource_id=payload.datasource_id,
            dataset_id=payload.dataset_id,
            operation="query.execute",
            status="error",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code="internal_error",
            correlation_id=x_correlation_id,
        )
        raise EngineError(
            status_code=500,
            code="internal_error",
            message=_sanitize_error_message(str(exc)),
        ) from exc


@router.post("/query/execute/batch", response_model=BatchQueryResponse)
async def query_execute_batch(
    request: BatchQueryRequest,
    x_engine_datasource_url: str | None = Header(default=None),
    x_correlation_id: str | None = Header(default=None),
    auth: ServiceAuthContext = Depends(require_service_auth),
) -> BatchQueryResponse:
    _assert_direct_header_policy(x_engine_datasource_url)
    _validate_request_auth(
        context=auth,
        workspace_id=request.workspace_id,
        datasource_id=request.datasource_id,
        dataset_id=request.dataset_id,
    )
    await _enforce_rate_limit(auth)
    started = perf_counter()
    pairs = [(item.request_id, item.spec) for item in request.queries]
    try:
        datasource_url = await _resolve_registered_datasource(
            datasource_id=request.datasource_id,
            workspace_id=request.workspace_id,
            dataset_id=request.dataset_id,
        )
        result = await asyncio.wait_for(
            _pipeline.execute_batch(
                specs=pairs,
                datasource_url=datasource_url,
                correlation_id=x_correlation_id,
            ),
            timeout=_settings.execution_timeout_seconds,
        )
        _audit_log(
            context=auth,
            datasource_id=request.datasource_id,
            dataset_id=request.dataset_id,
            operation="query.execute.batch",
            status="ok",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            correlation_id=x_correlation_id,
        )
        return result
    except TimeoutError as exc:
        _audit_log(
            context=auth,
            datasource_id=request.datasource_id,
            dataset_id=request.dataset_id,
            operation="query.execute.batch",
            status="timeout",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code="execution_timeout",
            correlation_id=x_correlation_id,
        )
        raise EngineError(status_code=504, code="execution_timeout", message="Query execution timed out") from exc
    except EngineError as exc:
        _audit_log(
            context=auth,
            datasource_id=request.datasource_id,
            dataset_id=request.dataset_id,
            operation="query.execute.batch",
            status="error",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code=exc.code,
            correlation_id=x_correlation_id,
        )
        raise
    except Exception as exc:
        _audit_log(
            context=auth,
            datasource_id=request.datasource_id,
            dataset_id=request.dataset_id,
            operation="query.execute.batch",
            status="error",
            duration_ms=max(0, int((perf_counter() - started) * 1000)),
            error_code="internal_error",
            correlation_id=x_correlation_id,
        )
        raise EngineError(
            status_code=500,
            code="internal_error",
            message=_sanitize_error_message(str(exc)),
        ) from exc


@router.get("/catalog/resources", response_model=ResourceList)
async def catalog_resources(
    datasource_id: int,
    workspace_id: int,
    dataset_id: int | None = None,
    x_engine_datasource_url: str | None = Header(default=None),
    auth: ServiceAuthContext = Depends(require_service_auth),
) -> ResourceList:
    _assert_direct_header_policy(x_engine_datasource_url)
    _validate_request_auth(
        context=auth,
        workspace_id=workspace_id,
        datasource_id=datasource_id,
        dataset_id=dataset_id,
    )
    await _enforce_rate_limit(auth)
    datasource_url = await _resolve_registered_datasource(
        datasource_id=datasource_id,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
    )
    return await _pipeline.list_resources(datasource_url=datasource_url)


@router.get("/schema/{resource_id:path}", response_model=SchemaDefinition)
async def schema_get(
    resource_id: str,
    datasource_id: int,
    workspace_id: int,
    dataset_id: int | None = None,
    x_engine_datasource_url: str | None = Header(default=None),
    auth: ServiceAuthContext = Depends(require_service_auth),
) -> SchemaDefinition:
    _assert_direct_header_policy(x_engine_datasource_url)
    _validate_request_auth(
        context=auth,
        workspace_id=workspace_id,
        datasource_id=datasource_id,
        dataset_id=dataset_id,
    )
    await _enforce_rate_limit(auth)
    datasource_url = await _resolve_registered_datasource(
        datasource_id=datasource_id,
        workspace_id=workspace_id,
        dataset_id=dataset_id,
    )
    return await _pipeline.get_schema(
        datasource_url=datasource_url,
        resource_id=resource_id,
    )
