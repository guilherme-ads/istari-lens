# Backend Refactor Plan (Clean + Hexagonal)

## Current module map

- `Core`:
  - `routers/auth.py`, `routers/admin_users.py`
  - `routers/datasets.py`, `routers/datasources.py`, `routers/dashboards.py`
  - `routers/queries.py`, `routers/insights.py`
- `Integration/Infra`:
  - `database.py` (SQLAlchemy + analytics connection)
  - `crypto.py` (credential encryption)
  - `external_query_logging.py` (query telemetry logging)
  - OpenAI HTTP calls inside `routers/insights.py`
- `Legacy compatibility`:
  - Runtime schema patches in `main.py`
  - Legacy widget payload adaptation in `routers/dashboards.py::_adapt_legacy_query_config`
  - `query_builder.py` public helper signatures preserved
- `Duplicated logic`:
  - SQL build and execution duplicated across `dashboard_execution.py`, `routers/queries.py`, `routers/insights.py`

## Refactor status

- Implemented `QueryExecution` bounded context:
  - `app/modules/query_execution/domain`: internal `InternalQuerySpec`, `CompiledQuery`, `ResultSet`, execution context, ports.
  - `app/modules/query_execution/application`: use-case services `QueryBuilderService` and `QueryExecutionService`.
  - `app/modules/query_execution/adapters`: postgres compiler + secure read-only runner adapter.
- Introduced security abstraction:
  - `app/modules/security/domain/ports.py`: `SecretsVaultPort`.
  - `app/modules/security/adapters/fernet_vault.py`: adapter over existing Fernet encryption.
- Preserved compatibility:
  - `app/query_builder.py` remains stable as a façade (same function names/signatures).

## Incremental migration sequence (strangler)

1. Widgets/query execution (done in this iteration):
   - Dashboard widget SQL compilation now uses shared `query_builder` façade backed by `QueryExecution` module.
   - Dashboard query execution path now routes through `PostgresQueryRunnerAdapter` with read-only guardrails.
2. Insights query pipeline (done in this iteration):
   - Insights query execution now routes through `QueryExecutionService` runner.
   - Same compiler source is used via shared widget builder façade.
3. Remaining migration (next iterations):
   - Move route-level orchestration into module-level use-cases per context (`dashboards`, `datasets`, `datasources`, `insights`).
   - Extract repository ports for metadata persistence and tenancy/RBAC enforcement.
   - Isolate OpenAI orchestration under explicit `LLMPort` + adapter.
   - Move schema bootstrap patches from `main.py` to explicit migration lifecycle.

## Security guarantees in query execution

- SQL execution now validates read-only policy before running:
  - allows only `SELECT`, `WITH`, or `EXPLAIN`.
  - blocks dangerous verbs (`INSERT/UPDATE/DELETE/DDL/...`) and multi-statement payloads.
- Timeout is enforced by adapter execution.
- Result rows are clipped to configured safe limits.

## Multi-tenant and RBAC notes

- User/tenant correlation fields are now part of execution context and structured logs.
- Full tenant-first metadata enforcement still requires schema-level tenant keys (`tenant_id`) in metadata tables and repository filters.

