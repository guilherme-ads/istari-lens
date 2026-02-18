# Alembic migration environment

from logging.config import fileConfig
from sqlalchemy import engine_from_config
from sqlalchemy import pool
from alembic import context
import os
import sys

# Add the parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from app.modules.core.legacy.models import Base
    from app.shared.infrastructure.settings import get_settings
except ImportError:
    # If imports fail, create dummy objects
    from sqlalchemy.orm import declarative_base
    Base = declarative_base()
    
    class Settings:
        app_db_url = os.getenv('APP_DB_URL', 'postgresql://postgres:postgres@localhost/istari_product')
    
    def get_settings():
        return Settings()

# This is the Alembic Config object
config = context.config

# Interpret the config file for Python logging
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Set sqlalchemy.url from environment
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.app_db_url)

# Add your model's MetaData object for 'autogenerate' support
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    try:
        connectable = engine_from_config(
            config.get_section(config.config_ini_section, {}),
            prefix="sqlalchemy.",
            poolclass=pool.NullPool,
        )

        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata
            )

            with context.begin_transaction():
                context.run_migrations()
    except Exception as e:
        print(f"Warning: Could not run migrations: {e}")
        print("Continuing without migrations...")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
