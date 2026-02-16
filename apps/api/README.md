# Istari Lens API

FastAPI backend para Istari Lens - plataforma analitica low-code.

## Desenvolvimento

### Setup Local

```bash
# Instalar Poetry
pip install poetry

# Instalar dependencias
poetry install

# Configurar variaveis de ambiente
cp .env.example .env

# Executar migrations
poetry run alembic upgrade head

# Rodar servidor
poetry run uvicorn main:app --reload
```

A API estara disponivel em `http://localhost:8000`.

### Documentacao

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Estrutura

```text
app/
|- models.py        # Modelos SQLAlchemy
|- schemas.py       # Schemas Pydantic
|- settings.py      # Configuracoes
|- database.py      # Configuracao de banco
|- auth.py          # Utilitarios de autenticacao
|- dependencies.py  # Dependencias (middleware)
'- routers/
   |- auth.py       # Rotas de autenticacao
   |- views.py      # Admin: gerenciar views
   |- datasets.py   # Usuario: listar datasets
   |- queries.py    # Usuario: executar queries
   |- analyses.py   # Usuario: gerenciar analises
   |- shares.py     # Usuario: compartilhar analises
   |- api_config.py # Configuracao de provider/API
   '- health.py     # Health check
```

## API Configuration

```http
GET  /api-config/integration
GET  /api-config/integrations
POST /api-config/integrations/openai
PATCH /api-config/integrations/{integration_id}/activate
PATCH /api-config/integrations/{integration_id}/deactivate
POST /api-config/integrations/{integration_id}/test
POST /api-config/integrations/billing/refresh
PUT  /api-config/integration/openai
POST /api-config/integration/openai/test
```

## Lint & Format

```bash
poetry run black .
poetry run ruff check --fix
poetry run mypy .
```

## Tests

```bash
poetry run pytest
```

## Environment Variables

```env
DATABASE_URL=postgresql://...
APP_DB_URL=postgresql://...
ANALYTICS_DB_URL=postgresql://...
SECRET_KEY=your-secret
ENCRYPTION_KEY=your-fernet-key
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=60
ENVIRONMENT=development
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
BOOTSTRAP_ADMIN_ENABLED=false
```
