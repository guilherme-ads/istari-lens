import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.shared.infrastructure.database import engine, Base, SessionLocal
from app.modules.core.legacy.models import User
from app.modules.auth.application.security import hash_password
from app.shared.infrastructure.settings import get_settings
from app.api.v1.routes import (
    health,
    auth,
    views,
    datasets,
    queries,
    analyses,
    shares,
    datasources,
    dashboards,
    view_schema,
    admin_users,
    api_config,
    imports,
    catalog,
)

logger = logging.getLogger(__name__)
settings = get_settings()

# Create tables
Base.metadata.create_all(bind=engine)


def _ensure_views_datasource_id_column() -> None:
    """
    Compatibility patch for legacy databases created before views.datasource_id existed.
    """
    try:
        with engine.begin() as conn:
            has_column = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'views' AND column_name = 'datasource_id'
                    LIMIT 1
                    """
                )
            ).first()
            if has_column:
                return

            conn.execute(text("ALTER TABLE views ADD COLUMN datasource_id INTEGER"))

            has_analyses_datasource_id = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'analyses' AND column_name = 'datasource_id'
                    LIMIT 1
                    """
                )
            ).first()

            # Backfill from analyses when possible.
            if has_analyses_datasource_id:
                conn.execute(
                    text(
                        """
                        UPDATE views v
                        SET datasource_id = a.datasource_id
                        FROM (
                          SELECT dataset_id, MIN(datasource_id) AS datasource_id
                          FROM analyses
                          GROUP BY dataset_id
                        ) a
                        WHERE v.id = a.dataset_id
                          AND v.datasource_id IS NULL
                        """
                    )
                )

            # For environments with a single datasource, backfill any remaining NULLs.
            conn.execute(
                text(
                    """
                    UPDATE views
                    SET datasource_id = (
                      SELECT id
                      FROM datasources
                      ORDER BY id
                      LIMIT 1
                    )
                    WHERE datasource_id IS NULL
                      AND (SELECT COUNT(*) FROM datasources) = 1
                    """
                )
            )

            conn.execute(
                text(
                    """
                    DO $$
                    BEGIN
                      IF NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'views_datasource_id_fkey'
                      ) THEN
                        ALTER TABLE views
                        ADD CONSTRAINT views_datasource_id_fkey
                        FOREIGN KEY (datasource_id) REFERENCES datasources(id);
                      END IF;
                    END $$;
                    """
                )
            )
    except Exception:
        logger.exception("Schema compatibility patch failed")


_ensure_views_datasource_id_column()


def _ensure_dashboard_widgets_config_version_column() -> None:
    try:
        with engine.begin() as conn:
            has_column = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'dashboard_widgets' AND column_name = 'config_version'
                    LIMIT 1
                    """
                )
            ).first()
            if has_column:
                return
            conn.execute(text("ALTER TABLE dashboard_widgets ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1"))
    except Exception:
        logger.exception("dashboard_widgets config_version patch failed")


_ensure_dashboard_widgets_config_version_column()


def _ensure_dashboards_created_by_column() -> None:
    try:
        with engine.begin() as conn:
            has_column = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'dashboards' AND column_name = 'created_by_id'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_column:
                conn.execute(text("ALTER TABLE dashboards ADD COLUMN created_by_id INTEGER"))

            conn.execute(
                text(
                    """
                    DO $$
                    BEGIN
                      IF NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'dashboards_created_by_id_fkey'
                      ) THEN
                        ALTER TABLE dashboards
                        ADD CONSTRAINT dashboards_created_by_id_fkey
                        FOREIGN KEY (created_by_id) REFERENCES users(id);
                      END IF;
                    END $$;
                    """
                )
            )

            conn.execute(
                text(
                    """
                    CREATE INDEX IF NOT EXISTS dashboard_created_by_idx
                    ON dashboards(created_by_id)
                    """
                )
            )

            conn.execute(
                text(
                    """
                    UPDATE dashboards d
                    SET created_by_id = ds.created_by_id
                    FROM datasets dt
                    JOIN datasources ds ON ds.id = dt.datasource_id
                    WHERE d.dataset_id = dt.id
                      AND d.created_by_id IS NULL
                    """
                )
            )
    except Exception:
        logger.exception("dashboards created_by patch failed")


_ensure_dashboards_created_by_column()


def _ensure_dashboard_widgets_execution_columns() -> None:
    try:
        with engine.begin() as conn:
            has_last_execution_ms = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'dashboard_widgets' AND column_name = 'last_execution_ms'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_last_execution_ms:
                conn.execute(text("ALTER TABLE dashboard_widgets ADD COLUMN last_execution_ms INTEGER"))

            has_last_executed_at = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'dashboard_widgets' AND column_name = 'last_executed_at'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_last_executed_at:
                conn.execute(text("ALTER TABLE dashboard_widgets ADD COLUMN last_executed_at TIMESTAMP"))
    except Exception:
        logger.exception("dashboard_widgets execution telemetry patch failed")


_ensure_dashboard_widgets_execution_columns()


def _ensure_dashboards_native_filters_column() -> None:
    try:
        with engine.begin() as conn:
            has_column = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'dashboards' AND column_name = 'native_filters'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_column:
                conn.execute(text("ALTER TABLE dashboards ADD COLUMN native_filters JSON NOT NULL DEFAULT '[]'::json"))
    except Exception:
        logger.exception("dashboards native_filters patch failed")


_ensure_dashboards_native_filters_column()


def _ensure_users_admin_columns() -> None:
    try:
        with engine.begin() as conn:
            has_last_login_at = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'users' AND column_name = 'last_login_at'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_last_login_at:
                conn.execute(text("ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP"))

            has_deleted_at = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'users' AND column_name = 'deleted_at'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_deleted_at:
                conn.execute(text("ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP"))
    except Exception:
        logger.exception("users admin columns patch failed")


_ensure_users_admin_columns()


def _ensure_datasources_import_columns() -> None:
    try:
        with engine.begin() as conn:
            has_source_type = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'datasources' AND column_name = 'source_type'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_source_type:
                conn.execute(
                    text(
                        """
                        ALTER TABLE datasources
                        ADD COLUMN source_type VARCHAR(64) NOT NULL DEFAULT 'postgres_external'
                        """
                    )
                )
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_datasources_source_type ON datasources(source_type)"))

            has_tenant_id = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'datasources' AND column_name = 'tenant_id'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_tenant_id:
                conn.execute(text("ALTER TABLE datasources ADD COLUMN tenant_id INTEGER"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_datasources_tenant_id ON datasources(tenant_id)"))

            has_status = conn.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'datasources' AND column_name = 'status'
                    LIMIT 1
                    """
                )
            ).first()
            if not has_status:
                conn.execute(text("ALTER TABLE datasources ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active'"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_datasources_status ON datasources(status)"))
    except Exception:
        logger.exception("datasources import columns patch failed")


_ensure_datasources_import_columns()


def _bootstrap_admin_user() -> None:
    if not settings.bootstrap_admin_enabled:
        return

    if settings.environment == "production":
        logger.error("BOOTSTRAP_ADMIN_ENABLED cannot be used in production")
        return

    if not settings.bootstrap_admin_password:
        logger.warning("BOOTSTRAP_ADMIN_ENABLED=true, but no BOOTSTRAP_ADMIN_PASSWORD was configured")
        return

    db = SessionLocal()
    try:
        admin_user = db.query(User).filter(User.email == settings.bootstrap_admin_email).first()
        if admin_user:
            return
        admin_user = User(
            email=settings.bootstrap_admin_email,
            hashed_password=hash_password(settings.bootstrap_admin_password),
            full_name="Admin User",
            is_admin=True,
            is_active=True,
        )
        db.add(admin_user)
        db.commit()
        logger.warning("Bootstrap admin user created for %s", settings.bootstrap_admin_email)
    finally:
        db.close()


def _resolve_cors_origins() -> list[str]:
    if settings.cors_origins:
        return settings.cors_origins
    if settings.environment in {"development", "test"}:
        return ["http://localhost:3000", "http://127.0.0.1:3000"]
    return []


def create_app() -> FastAPI:
    docs_enabled = settings.environment != "production"
    app = FastAPI(
        title="Istari Lens API",
        description="Analytics platform API",
        version="0.1.0",
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
    )

    cors_origins = _resolve_cors_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return app


_bootstrap_admin_user()
app = create_app()

# Include routers
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(datasources.router)
app.include_router(views.router)
app.include_router(view_schema.router)
app.include_router(datasets.router)
app.include_router(dashboards.router)
app.include_router(admin_users.router)
app.include_router(queries.router)
app.include_router(api_config.router)
app.include_router(imports.router)
app.include_router(catalog.router)
app.include_router(analyses.router)
app.include_router(shares.router)

@app.get("/")
async def root():
    return {"message": "Istari Lens API"}

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.api_host, port=settings.api_port)


