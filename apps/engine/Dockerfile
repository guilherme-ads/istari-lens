FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    fastapi \
    uvicorn[standard] \
    psycopg[binary] \
    pydantic \
    pydantic-settings

COPY apps/engine ./

ENV PORT=8010
EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8010} --proxy-headers --forwarded-allow-ips=*"]
