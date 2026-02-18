import logging
import uuid
import asyncio

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.errors import EngineError
from app.settings import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    docs_enabled = settings.environment != "production"
    app = FastAPI(
        title="Istari Engine",
        description="Dedicated query execution and metadata service",
        version="0.1.0",
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )

    @app.exception_handler(EngineError)
    async def handle_engine_error(_request: Request, exc: EngineError) -> JSONResponse:
        logger.warning(
            "engine.handled_error | %s",
            {
                "error_id": exc.error_id,
                "code": exc.code,
                "status_code": exc.status_code,
            },
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, "error_id": exc.error_id}},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
        error_id = str(uuid.uuid4())
        logger.exception("engine.unhandled_error | %s", {"error_id": error_id})
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "Unexpected internal error",
                    "error_id": error_id,
                }
            },
        )

    @app.middleware("http")
    async def request_timeout_middleware(request: Request, call_next):  # type: ignore[override]
        try:
            return await asyncio.wait_for(call_next(request), timeout=settings.execution_timeout_seconds + 2)
        except TimeoutError as exc:
            raise EngineError(
                status_code=504,
                code="request_timeout",
                message="Request timed out",
            ) from exc

    app.include_router(router)
    return app


app = create_app()
