from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

INSECURE_DEV_ENCRYPTION_KEY = "uZr6e4waGdI6B6xzUA8WpoJKzN-Eq9iUumBwJbLfhz0="


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # API
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    environment: Literal["development", "test", "staging", "production"] = "development"
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Database
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/istari_product"
    app_db_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/istari_product"
    analytics_db_url: str = "postgresql://postgres:postgres@localhost:5432/istari_product"
    query_preview_cache_ttl_seconds: int = 60
    query_preview_cache_max_entries: int = 500
    insights_chat_cache_ttl_seconds: int = 45
    insights_chat_cache_max_entries: int = 300
    insights_planner_model: str | None = None
    insights_answer_model: str | None = None
    insights_dev_debug_logs: bool = True
    log_external_queries: bool = False
    log_external_query_params: bool = False

    # Dashboard widget execution (process-local cache/dedupe)
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

    # JWT
    secret_key: str = "your-super-secret-key-change-in-prod"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60

    # Encryption for credentials
    encryption_key: str = INSECURE_DEV_ENCRYPTION_KEY

    # Bootstrap (development only by default)
    bootstrap_admin_enabled: bool = False
    bootstrap_admin_email: str = "admin@local"
    bootstrap_admin_password: str = ""

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, value: str | list[str] | None) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            raw_items = [item.strip() for item in value.split(",")]
            return [item for item in raw_items if item]
        return value

    @field_validator("database_url", "app_db_url", mode="before")
    @classmethod
    def _normalize_sqlalchemy_postgres_urls(cls, value: str) -> str:
        if isinstance(value, str) and value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @field_validator("secret_key")
    @classmethod
    def _validate_secret_key(cls, value: str, info: ValidationInfo) -> str:
        env = (info.data.get("environment") or "development").lower()
        if env == "production":
            if value == "your-super-secret-key-change-in-prod" or len(value) < 32:
                raise ValueError("SECRET_KEY must be strong and at least 32 chars in production")
        return value

    @field_validator("encryption_key")
    @classmethod
    def _validate_encryption_key(cls, value: str, info: ValidationInfo) -> str:
        env = (info.data.get("environment") or "development").lower()
        if env == "production" and value in {
            "change-me-with-a-generated-fernet-key",
            INSECURE_DEV_ENCRYPTION_KEY,
        }:
            raise ValueError("ENCRYPTION_KEY must be configured in production")
        if not value:
            raise ValueError("ENCRYPTION_KEY must be configured")
        return value

    @model_validator(mode="after")
    def _validate_prod_cors(self) -> "Settings":
        if self.is_production and not self.cors_origins:
            raise ValueError("CORS_ORIGINS must be configured in production")
        return self


@lru_cache()
def get_settings() -> Settings:
    return Settings()


# Shared settings instance for app-wide imports.
settings = get_settings()
