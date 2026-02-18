# Istari Engine

Servico dedicado de execucao de queries e metadados.

## Contrato publico

- `POST /query/execute` -> `QueryResult` (payload com `datasource_id`, `workspace_id`, `dataset_id`, `spec`)
- `POST /query/execute/batch` -> `BatchQueryResponse` (payload com `datasource_id`, `workspace_id`, `dataset_id`, `queries`)
- `GET /catalog/resources?datasource_id=..&workspace_id=..` -> `ResourceList`
- `GET /schema/{resource_id}?datasource_id=..&workspace_id=..` -> `SchemaDefinition`
- `POST /internal/datasources/register` (uso interno API->Engine)
- `GET /health` -> healthcheck

Todos os endpoints (exceto `health`) exigem `Authorization: Bearer <service-token>`.

## Desenvolvimento

```bash
cd apps/engine
poetry install
poetry run uvicorn main:app --reload --port 8010
```
