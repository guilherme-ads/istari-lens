# Istari Lens

Plataforma de analytics low-code com arquitetura em servicos:
- `apps/web`: frontend React (Vite)
- `apps/api`: API principal (FastAPI)
- `apps/engine`: engine de execucao de queries e catalogo
- `app_db`: Postgres local (produto + fallback analytics em dev)

## Arquitetura local (Docker Compose)

```text
web (3000) -> api (8000) -> engine (8010) -> datasource (app_db ou externo)
```

## Requisitos

- Docker + Docker Compose
- Node.js 20+ (para rodar frontend fora do Docker)
- Python 3.12+ (para rodar API/Engine fora do Docker)

## Quick Start

1. Copie variaveis de ambiente:
```bash
cp .env.example .env
```

2. Suba o ambiente:
```bash
docker-compose up -d --build
```

3. Acesse:
- App: `http://localhost:3000`
- API docs: `http://localhost:8000/docs`
- Engine health: `http://localhost:8010/health`

4. Derrube:
```bash
docker-compose down
```

## Variaveis importantes

Variaveis da API usam prefixo `APP_` internamente no settings.
No `docker-compose.yml`, as principais configuracoes ja sao injetadas.

Principais chaves:
- `APP_ENVIRONMENT`
- `APP_DATABASE_URL`
- `APP_APP_DB_URL`
- `APP_ANALYTICS_DB_URL`
- `APP_SECRET_KEY`
- `APP_ENCRYPTION_KEY`
- `APP_ENGINE_BASE_URL`
- `APP_ENGINE_SERVICE_SECRET`

Variaveis compartilhadas no compose:
- `ENGINE_SERVICE_SECRET`
- `ANALYTICS_DB_URL_DOCKER`

## Desenvolvimento sem Docker

API:
```bash
cd apps/api
poetry install
poetry run uvicorn main:app --reload --port 8000
```

Engine:
```bash
cd apps/engine
poetry install
poetry run uvicorn main:app --reload --port 8010
```

Web:
```bash
cd apps/web
npm install
npm run dev
```

## Testes (API)

Exemplo:
```bash
cd apps/api
python -m pytest
```

## Documentacao por servico

- `apps/api/README.md`
- `apps/engine/README.md`
- `apps/web/README.md`
