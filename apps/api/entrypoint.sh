#!/bin/sh
set -eu

RETRIES="${MIGRATION_MAX_RETRIES:-20}"
SLEEP_SECONDS="${MIGRATION_RETRY_SLEEP_SECONDS:-3}"

echo "Running migrations (alembic upgrade head)..."
i=1
while [ "$i" -le "$RETRIES" ]; do
  if alembic upgrade head; then
    echo "Migrations completed."
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    echo "Migration failed after ${RETRIES} attempts."
    exit 1
  fi
  echo "Migration attempt ${i}/${RETRIES} failed; retrying in ${SLEEP_SECONDS}s..."
  i=$((i + 1))
  sleep "$SLEEP_SECONDS"
done

echo "Starting API server..."
exec uvicorn main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips='*'
