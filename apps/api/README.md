# Istari Lens API

API principal do produto (FastAPI). Esta camada gerencia autenticacao, dashboards, datasets, configuracoes e orquestra chamadas para o `engine`.

## Subir localmente

```bash
poetry install
poetry run alembic upgrade head
poetry run uvicorn main:app --reload --port 8000
```

Documentacao:
- Swagger: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Integracao com Engine

Principais fluxos:
- Query preview (`/query/preview` e `/query/preview/batch`)
- Execucao de widgets de dashboard
- Sync de schema de views
- Shared analysis read-only

Todos esses fluxos chamam o servico `apps/engine` via `EngineClient`.

## Variaveis de ambiente

O settings da API usa prefixo `APP_`.

Minimas para subir:
```env
APP_ENVIRONMENT=development
APP_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/istari_product
APP_APP_DB_URL=postgresql+psycopg://postgres:postgres@localhost:5432/istari_product
APP_ANALYTICS_DB_URL=postgresql://postgres:postgres@localhost:5432/istari_product
APP_SECRET_KEY=your-super-secret-key-change-in-prod
APP_ENCRYPTION_KEY=<fernet-key-base64>
APP_ENGINE_BASE_URL=http://localhost:8010
APP_ENGINE_SERVICE_SECRET=change-me-engine-service-secret
APP_ENGINE_SERVICE_TOKEN_TTL_SECONDS=120
```

## Testes

```bash
poetry run pytest
```
