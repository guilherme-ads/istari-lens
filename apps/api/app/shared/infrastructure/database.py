from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.pool import QueuePool
from psycopg import AsyncConnection
from app.shared.infrastructure.settings import get_settings

settings = get_settings()

# Product database (SQLAlchemy)
engine = create_engine(
    settings.app_db_url,
    poolclass=QueuePool,
    pool_size=10,
    max_overflow=20,
    echo=False
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


# Analytics database connection (read-only)
async def get_analytics_connection():
    """Get a psycopg3 connection to analytics database"""
    try:
        conn = await AsyncConnection.connect(settings.analytics_db_url)
        return conn
    except Exception as e:
        raise Exception(f"Failed to connect to analytics database: {str(e)}")


def get_db():
    """Dependency for getting db session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
