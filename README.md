# Istari Lens - Analytics Platform (MVP)

Plataforma analítica neutra low-code para criar análises sem código.

## Arquitetura

```
├── apps/
│   ├── web/              # Frontend Vite + React
│   └── api/              # Backend FastAPI
├── packages/
│   ├── shared/           # Tipos compartilhados
│   └── ui/               # Componentes compartilhados (formato)
├── infra/
│   ├── docker/           # Dockerfiles
│   └── sql/              # Seeds e migrations
├── docker-compose.yml    # Orquestração local
└── README.md
```

## Stack Técnico

**Frontend:**
- Vite 5 + React 18
- TypeScript
- Tailwind CSS
- React Query
- Recharts (visualizações)

**Backend:**
- FastAPI + Python 3.12
- SQLAlchemy 2.x + Alembic
- Psycopg3 (conexão Postgres)
- JWT + Passlib (autenticação)

**Banco de dados:**
- PostgreSQL (app_db - produto)
- Analytics via datasource externo (fallback por `ANALYTICS_DB_URL`)
- Docker Compose para orquestração

**Qualidade:**
- Ruff + Black (Python)
- ESLint + Prettier (TypeScript)

## Quick Start

### 1. Clonar repositório

```bash
git clone <repo>
cd istari-lens
cp .env.example .env
```

### 2. Instalar dependências (Node.js)

```bash
pnpm install
```

### 3. Subir services com Docker Compose

```bash
docker-compose up -d
```

Isso irá iniciar:
- **app_db** (Postgres) na porta 5432
- **api** (FastAPI) na porta 8000
- **web** (Vite) na porta 3000

> **Observação**: Na primeira execução, o backend irá:
> - Executar migrations (`alembic upgrade head`)
> - Criar tabelas do produto
> - Seed de usuário admin: `admin@local` / `admin123`

### 4. Acessar aplicação

- **App**: http://localhost:3000
- **API Docs**: http://localhost:8000/docs
- **Health Check**: http://localhost:8000/health

### 5. Parar services

```bash
docker-compose down
```

## Fluxo Validável - MVP

### Passo 1: Login como Admin

1. Ir para http://localhost:3000/login
2. Email: `admin@local`
3. Senha: `admin123`
4. Clique em "Login"
5. Será redirecionado para `/admin`

### Passo 2: Registrar View e Sincronizar Metadados

1. Na página `/admin`, preencher:
   - Schema: `public`
   - View Name: `vw_growth_users`
   - Description: "Growth users view"
2. Clique em "Register View"
3. Aguarde e verá a view na lista
4. Clique no botão **"Sync"** para sincronizar colunas do datasource configurado
5. Clique em **"Activate"** para ativar a view (se necessário)

### Passo 3: Login como Usuário Regular

1. Logout de `/admin`
2. Ir para http://localhost:3000/login
3. Email: `user@example.com`
4. Senha: `password`
5. Clique em "Login"
6. Será redirecionado para `/datasets`

> **Nota**: Se você não tiver um usuário regular criado, faça isso:
>
> ```bash
> curl -X POST http://localhost:8000/auth/register \
>   -H "Content-Type: application/json" \
>   -d '{
>     "email": "user@example.com",
>     "password": "password",
>     "full_name": "Demo User"
>   }'
> ```

### Passo 4: Criar Análise

1. Na página `/datasets`, clique em `vw_growth_users`
2. Será direcionado para `/datasets/:datasetId/builder` (builder de análises)
3. Preencha:
   - **Name**: "Revenue by Category"
   - **Metrics**: Adicionar métrica
     - Column: `revenue`
     - Agg: `sum`
   - **Dimensions**: Adicionar dimensão
     - Selecionar `category`
   - **Visualization Type**: `bar`
4. A preview deve exibir um gráfico de barras
5. Preencha um nome se não tiver e clique em **"Save Analysis"**
6. Sera salvo e redirecionado para a visualizacao do dashboard

### Passo 5: Visualizar Análise Salva

1. Na pagina de dataset/dashboard, abra a analise salva
2. Clique em **"Share"** para gerar um link compartilhado
3. Um alerta mostrará a URL: `http://localhost:3000/shared/{shareToken}`

### Passo 6: Acessar Link Compartilhado (Read-Only)

1. Copie o link do alerta
2. Abra em nova aba (sem autenticação)
3. Verá a análise renderizada em modo read-only
4. Pode visualizar dados, mas não pode editar

## API Endpoints

### Autenticação
- `POST /auth/login` - Login
- `POST /auth/register` - Registrar usuário

### Admin
- `GET /admin/views` - Listar views registradas
- `POST /admin/views` - Registrar nova view
- `POST /admin/views/{id}/sync` - Sincronizar metadados
- `PATCH /admin/views/{id}` - Atualizar view

### Usuário
- `GET /datasets` - Listar datasets ativos
- `POST /query/preview` - Executar query e preview
- `POST /analyses` - Criar análise
- `GET /analyses` - Listar análises
- `GET /analyses/{id}` - Obter análise
- `PATCH /analyses/{id}` - Atualizar análise
- `DELETE /analyses/{id}` - Deletar análise
- `POST /analyses/{id}/share` - Gerar link compartilhado
- `GET /shared/{token}` - Acessar análise compartilhada

### Health
- `GET /health` - Health check

**Documentação interativa**: http://localhost:8000/docs

## Estrutura Backend

```
apps/api/
├── main.py              # Entrada da aplicação
├── alembic/             # Migrations (SQLAlchemy)
├── app/
│   ├── settings.py      # Configurações (env vars)
│   ├── database.py      # Conexões (SQLAlchemy + psycopg)
│   ├── models.py        # Modelos SQLAlchemy (User, View, Analysis, etc)
│   ├── schemas.py       # Schemas Pydantic (validação/OpenAPI)
│   ├── auth.py          # JWT + hash de senha
│   ├── dependencies.py  # Dependências (autenticação atual)
│   └── routers/
│       ├── auth.py      # Endpoints /auth
│       ├── views.py     # Endpoints /admin
│       ├── datasets.py  # Endpoints /datasets
│       ├── queries.py   # Endpoints /query
│       ├── analyses.py  # Endpoints /analyses
│       ├── shares.py    # Endpoints /shares
│       └── health.py    # Health check
```

## Estrutura Frontend

```
apps/web/
|- src/
|  |- pages/                  # Paginas (React Router)
|  |- components/             # Componentes reutilizaveis
|  |- hooks/                  # Hooks compartilhados
|  |- lib/                    # Utilitarios
|  |- App.tsx                 # Rotas da aplicacao
|  `- main.tsx                # Entry point Vite
|- index.html                 # HTML base
|- vite.config.ts             # Configuracao Vite
`- tailwind.config.ts         # Configuracao Tailwind
```
## Seguranca

### SQL Injection Prevention
- Nunca concatenar valores diretamente
- Usar parâmetros em todas as queries
- Validar identificadores contra catálogo persistido (information_schema)

### Autenticação
- JWT (PyJWT) com secret key
- Senha hasheada com bcrypt (passlib)
- Token incluído em Authorization header: `Bearer <token>`

### RBAC
- Admin: pode gerenciar views (cadastro, sync, ativar/desativar)
- User: pode criar análises sobre datasets ativos
- Share token: acesso read-only sem autenticação

## Banco de Dados

### Product DB (`istari_product`)
Tabelas:
- `users` - autenticação e perfil
- `views` - views registradas do datasource analítico
- `view_columns` - metadados de colunas
- `analyses` - configurações de análises (query spec JSON)
- `shares` - links compartilhados com token

### Analytics (Datasource Externo)
Read-only, sem escrita direta pela aplicação.
Pode ser qualquer PostgreSQL externo cadastrado em `datasources.database_url`.
Se nenhum datasource externo estiver configurado, a API usa `ANALYTICS_DB_URL` como fallback.

Dados de exemplo:
- `public.growth_users` - tabela com 20 registros fake
- `public.vw_growth_users` - view da tabela acima

Colunas:
- `id` (serial)
- `created_at` (timestamp)
- `category` (text)
- `channel` (text)
- `is_active` (boolean)
- `revenue` (decimal)

## Desenvolvimento

### Rodar em modo dev (sem Docker)

**Backend:**
```bash
cd apps/api
poetry install
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/istari_product
export ANALYTICS_DB_URL=postgresql://postgres:postgres@localhost:5432/istari_product
poetry run alembic upgrade head
poetry run uvicorn main:app --reload
```

**Frontend:**
```bash
cd apps/web
npm install
npm run dev
```

### Lint e Format

```bash
# TypeScript
pnpm lint
pnpm format

# Python (dentro de apps/api)
ruff check --fix
black .
```

### Testes

```bash
pnpm test                    # Rodar testes
```

Testes ainda não implementados neste MVP, mas a estrutura está pronta.

## Troubleshooting

### Erro: "Connection refused" ao conectar no banco

```bash
# Verificar se containers estão rodando
docker ps

# Ver logs
docker-compose logs app_db
docker-compose logs api
```

### Erro: "Alembic migration failed"

```bash
# Limpar volume e recomeçar
docker-compose down -v
docker-compose up -d
```

### Frontend não consegue conectar à API

Verificar:
- API está rodando na porta 8000
- NEXT_PUBLIC_API_URL está correto em `.env`
- CORS está habilitado no backend (está por padrão)

## Próximas Features (Fora do MVP)

- [ ] Cache de resultados
- [ ] Join entre múltiplas views
- [ ] Fórmulas e métricas derivadas
- [ ] Agendamento de exportações
- [ ] Colaboração em tempo real
- [ ] Historicidade de análises
- [ ] IA para sugestões de análises

## Contato

Para dúvidas ou sugestões, abra uma issue no repositório.

---

**Versão**: 0.1.0 (MVP)
**Status**: Em desenvolvimento
**Última atualização**: Fevereiro 2026



