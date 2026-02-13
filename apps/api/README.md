# Istari Lens API

FastAPI backend para Istari Lens - plataforma analítica low-code.

## Desenvolvimento

### Setup Local

```bash
# Instalar Poetry
pip install poetry

# Instalar dependências
poetry install

# Configurar variáveis de ambiente
cp .env.example .env

# Executar migrations
poetry run alembic upgrade head

# Rodar servidor
poetry run uvicorn main:app --reload
```

A API estará disponível em http://localhost:8000

### Documentação

Swagger UI: http://localhost:8000/docs
ReDoc: http://localhost:8000/redoc

## Estrutura

```
app/
├── models.py        # Modelos SQLAlchemy
├── schemas.py       # Schemas Pydantic
├── settings.py      # Configurações
├── database.py      # Configuração de banco
├── auth.py          # Utilitários de autenticação
├── dependencies.py  # Dependências (middleware)
└── routers/
    ├── auth.py      # Rotas de autenticação
    ├── views.py     # Admin: gerenciar views
    ├── datasets.py  # Usuário: listar datasets
    ├── queries.py   # Usuário: executar queries
    ├── analyses.py  # Usuário: gerenciar análises
    ├── shares.py    # Usuário: compartilhar análises
    └── health.py    # Health check
```

## Lint & Format

```bash
# Format com black
poetry run black .

# Lint com ruff
poetry run ruff check --fix

# Type checking
poetry run mypy .
```

## Tests

```bash
poetry run pytest
```

## Environment Variables

```
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
