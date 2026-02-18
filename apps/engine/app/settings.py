from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_host: str = "0.0.0.0"
    api_port: int = 8010
    environment: Literal["development", "test", "staging", "production"] = "development"

    analytics_db_url: str = "postgresql://postgres:postgres@localhost:5432/istari_product"
    engine_service_secret: str = "change-me-engine-service-secret"
    allow_direct_datasource_header: bool = False
    datasource_registry_ttl_seconds: int = 900
    query_timeout_seconds: int = 20
    execution_timeout_seconds: int = 30
    rate_limit_requests_per_minute: int = 120
    query_result_rows_max: int = 1000

    engine_cache_ttl_seconds: int = 60
    engine_cache_max_entries: int = 1000
    engine_singleflight_ttl_seconds: int = 30
    engine_batch_execution_concurrency_limit: int = 6


@lru_cache()
def get_settings() -> Settings:
    return Settings()
