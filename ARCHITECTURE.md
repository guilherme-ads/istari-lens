# Istari Lens - Architecture Decision Record

## Overview

Plataforma analítica low-code MVP com arquitetura monorepo.

## Technology Choices

### Frontend
- **Framework**: Vite 5 + React 18
  - Razão: SPA com build rápido, setup simples e integração direta com React Router
- **Styling**: Tailwind CSS
  - Razão: Utility-first, rápido desenvolvimento MVP
- **State Management**: React Query (TanStack Query)
  - Razão: Server state gerenciado automaticamente, cache inteligente
- **Charts**: Recharts
  - Razão: Composable, integra bem com React, leve

### Backend
- **Framework**: FastAPI
  - Razão: Type hints automáticos via Pydantic, OpenAPI/Swagger native, async support
- **ORM**: SQLAlchemy 2.x
  - Razão: Battle-tested, suporta complex relationships
- **Migrations**: Alembic
  - Razão: Standard para SQLAlchemy, versionamento automático
- **DB Driver**: Psycopg3
  - Razão: Native async support para queries no analytics_db
- **Auth**: JWT + Passlib
  - Razão: Simples, stateless, escalável

### Banco de Dados
- **Dual Postgres** (app_db + analytics_db)
  - app_db: Persistência de usuários, análises, metadados
  - analytics_db: Read-only, dados originais
  - Razão: Separação de concerns, analytics_db pode ser read-replica

### DevOps
- **Containerization**: Docker + Docker Compose
  - Razão: Ambiente consistente, fácil onboarding
- **Package Manager**: pnpm (Node.js) + Poetry (Python)
  - Razão: Monorepo native support (pnpm), deterministic locks

## Architecture Patterns

### Backend

```
FastAPI App
├── Routers (separados por domínio)
├── Services/Repositories (lógica de negócio)
├── Schemas (Pydantic - validação + OpenAPI)
├── Models (SQLAlchemy - persistência)
└── Dependencies (middleware - autenticação)
```

**Fluxo de Request:**
1. Request chega em router
2. Dependency injection resolve autenticação, DB session
3. Router valida entrada via Pydantic Schema
4. Lógica de negócio executa
5. Response serializado via Schema

**Segurança SQL:**
- Nunca concatenar valores
- Qualquer valor é parâmetro (`%s` em psycopg)
- Identificadores (schema/view/column) validados contra metadados persistidos

### Frontend

```
Vite + React App
├── Pages (React Router)
├── Components (UI reutilizáveis)
├── Hooks (lógica customizada - React Query integrado)
├── Lib (utilities)
│   ├── api-client.ts (fetch wrapper com interceptadores)
│   └── types.ts (tipos compartilhados)
└── Styles (Tailwind)
```

**Data Flow:**
1. Component mount
2. useQuery hook busca data
3. API client faz requisição com autenticação
4. React Query cacheia resultado
5. Component renderiza

## Data Model

### Dois bancos separados:

**Product DB (app_db):**
```
users
├── id, email, hashed_password
├── is_admin, is_active
└── created_at, updated_at

views (registro de views no analytics_db)
├── id, schema_name, view_name
├── description, is_active
└── columns (relacionamento 1:N)

view_columns (metadados sincronizados)
├── id, view_id, column_name, column_type
├── is_aggregatable, is_filterable, is_groupable
└── created_at

analyses (configurações salvas)
├── id, owner_id, dataset_id
├── name, description
├── query_config (JSON - QuerySpec)
├── visualization_config (JSON)
└── created_at, updated_at

shares (links compartilhados)
├── id, analysis_id, created_by_id
├── token (urlsafe), is_active, expires_at
└── created_at
```

**Analytics DB (istari_analytics) - Read Only:**
```
growth_users (tabela de exemplo)
├── id, created_at, category, channel
├── is_active, revenue
└── (e outras tabelas conforme necessário)

vw_growth_users (view de exemplo)
└── SELECT ... FROM growth_users
```

## Query Execution Flow

1. **Frontend**: Monta QuerySpec ({datasetId, metrics, dimensions, filters, sort, limit})
2. **Backend /query/preview**:
   a. Valida QuerySpec contra metadados persistidos (view_columns)
   b. Gera SQL seguro (sem concatenação, tudo parâmetros)
   c. Executa em analytics_db (read-only)
   d. Retorna dados (ou erro)
3. **Frontend**: Renderiza dados em visualização escolhida (table, bar, line, pie, kpi)
4. **User**: Salva análise (persiste QuerySpec e visualization config em analyses table)
5. **Share**: Gera token único, allows read-only access

## Security Model

### Autenticação
- Email + passowrd → JWT token
- Token em Authorization: Bearer header
- Token contém user_id, expiração

### Autorização
- Middleware: verifica token válido
- RBAC simples:
  - Admin: /admin/* endpoints
  - User: /datasets, /analyses, /query endpoints
  - Public: /shared/{token}

### SQL Safety
- Valores sempre parâmetrizados
- Identificadores validados contra metadados persistidos
- Read-only connection para analytics_db

## Escalabilidade (Fora do MVP)

- Cache de resultados (Redis)
- Connection pooling (já implementado)
- Rate limiting
- Análise assíncrona (Celery)
- Data warehouse (Snowflake, BigQuery)

## Trade-offs

### MVP Simplicity vs Production Readiness
- Sem API key authentication (apenas user/pass)
- Sem rate limiting
- Sem cache de query results
- Sem audit logging
- Sem soft deletes

### Single Query vs Multiple Datasets
- MVP suporta 1 dataset por análise
- JOIN complexos não suportados
- Fórmulas entre métricas não suportadas

### Async Backend vs Scheduled Jobs
- Queries síncronа (< 5000 linhas)
- Sem export/snapshot assíncrono
- Sem agendamento

## Decision Log

| Decisão | Opções | Escolha | Razão |
|---------|--------|---------|-------|
| ORM | SQLAlchemy vs Django ORM | SQLAlchemy | Mais controle, melhor async |
| API Format | GraphQL vs REST | REST | Simpler para MVP, OpenAPI native |
| Auth | Session vs JWT | JWT | Stateless, monorepo friendly |
| Containerization | K8s vs Compose | Docker Compose | MVP simplicity |
| Frontend | Vite vs Create React App | Vite | Build rápido, setup simples e DX moderna |

## Future Considerations

- Mover analytics_db para cloud data warehouse
- Implementar column-level permissioning
- Suportar custom SQL (com validação rigorosa)
- Webhook para notificações
- BI tool integrations (Tableau, Metabase)

