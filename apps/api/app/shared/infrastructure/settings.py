from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        env_prefix="APP_",
    )

    # =========================
    # Environment
    # =========================
    environment: Literal["development", "test", "staging", "production"]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    # =========================
    # API
    # =========================
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # =========================
    # Database
    # =========================
    database_url: str
    app_db_url: str | None = None
    analytics_db_url: str | None = None

    query_preview_cache_ttl_seconds: int = 60
    query_preview_cache_max_entries: int = 500
    query_timeout_seconds: int = 20
    query_result_rows_max: int = 1000
    engine_base_url: str = "http://localhost:8010"
    engine_timeout_seconds: int = 30
    engine_service_secret: str = "change-me-engine-service-secret"
    engine_service_token_ttl_seconds: int = 120
    api_config_billing_window_days: int = 30
    api_config_billing_monthly_budget_usd: float = 0.0
    log_external_queries: bool = False
    log_external_query_params: bool = False

    # =========================
    # Dashboard widget execution
    # =========================
    dashboard_widget_cache_max_entries: int = 2000
    dashboard_widget_cache_grace_seconds: int = 15
    dashboard_widget_cache_failover_seconds: int = 300
    dashboard_widget_cache_ttl_kpi_seconds: int = 60
    dashboard_widget_cache_ttl_chart_seconds: int = 120
    dashboard_widget_cache_ttl_table_seconds: int = 30
    dashboard_widget_singleflight_ttl_seconds: int = 30
    dashboard_widget_render_concurrency_limit: int = 6
    dashboard_widget_timeout_kpi_seconds: int = 8
    dashboard_widget_timeout_chart_seconds: int = 15
    dashboard_widget_timeout_table_seconds: int = 20

    # =========================
    # Security
    # =========================
    secret_key: str
    encryption_key: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60

    # =========================
    # Bootstrap
    # =========================
    bootstrap_admin_enabled: bool = False
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None

    # ============================================================
    # Validators
    # ============================================================

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: str | list[str] | None) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            raw_items = [item.strip() for item in value.split(",")]
            return [item for item in raw_items if item]
        return value

    @field_validator("database_url", "app_db_url", "analytics_db_url", mode="before")
    @classmethod
    def normalize_postgres_urls(cls, value: str | None) -> str | None:
        if value and value.startswith(("postgres://", "postgresql://")):
            return value.replace("postgres://", "postgresql+psycopg://", 1).replace(
                "postgresql://", "postgresql+psycopg://", 1
            )
        return value

    @field_validator("secret_key")
    @classmethod
    def validate_secret_key(cls, value: str, info: ValidationInfo) -> str:
        env = info.data.get("environment")
        if env == "production" and len(value) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters in production")
        return value

    @field_validator("encryption_key")
    @classmethod
    def validate_encryption_key(cls, value: str, info: ValidationInfo) -> str:
        if not value:
            raise ValueError("ENCRYPTION_KEY must be configured")

        env = info.data.get("environment")
        if env == "production" and len(value) < 32:
            raise ValueError(
                "ENCRYPTION_KEY must be strong and at least 32 characters in production"
            )
        return value

    @model_validator(mode="after")
    def validate_production_rules(self) -> "Settings":
        if self.is_production:
            if not self.cors_origins:
                raise ValueError("CORS_ORIGINS must be configured in production")

            if "*" in self.cors_origins:
                raise ValueError("Wildcard CORS is not allowed in production")

            if self.log_level == "DEBUG":
                raise ValueError("DEBUG logging is not allowed in production")

        return self


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
