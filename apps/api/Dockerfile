FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies - use argon2 instead of bcrypt to avoid initialization issues
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn[standard] \
    sqlalchemy \
    alembic \
    psycopg[binary] \
    psycopg2-binary \
    pydantic \
    pydantic-settings \
    httpx \
    pyjwt \
    passlib[argon2] \
    python-multipart \
    python-jose[cryptography] \
    cryptography \
    openpyxl \
    argon2-cffi \
    pytest \
    pytest-asyncio

# Copy application code
COPY apps/api ./

RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

# Run migrations and start server (fail fast on migration errors)
CMD ["bash", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000"]
