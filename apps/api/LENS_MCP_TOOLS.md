# Lens MCP Tools (v1 - Dataset Unico)

Este documento descreve a base operacional do MCP do Lens para um agente de BI que atua em **um unico dataset por execucao**.

## Visao Geral

- Endpoint de catalogo: `GET /mcp/tools`
- Endpoint de execucao: `POST /mcp/tools/{tool_name}`
- Router MCP fino: lista catalogo e delega para `tool_registry`.
- Execucao desacoplada em modulos:
  - `app/modules/mcp/tool_registry.py`
  - `app/modules/mcp/schemas.py`
  - `app/modules/mcp/history.py`
  - `app/modules/mcp/plans.py`
  - `app/modules/mcp/tools/*.py`

## Contrato Padrao de Resposta

Toda tool retorna envelope padrao:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "warnings": [],
  "validation_errors": [],
  "suggestions": [],
  "metadata": {}
}
```

Campos relevantes para agente:
- `warnings`: alertas nao bloqueantes
- `validation_errors`: erros acionaveis por campo/codigo
- `suggestions`: proximos passos recomendados
- `metadata`: `trace_id`, `call_id`, `duration_ms`, categoria, etc.

## Fluxo Recomendado do Agente BI (Dataset Unico)

1. Receber `user_question` + `dataset_id`
2. Ler contexto:
   - `lens.get_dataset_semantic_layer`
   - `lens.get_dataset_schema`
   - `lens.get_dataset_catalog`
3. Explorar dados e validar query:
   - `lens.profile_dataset`
   - `lens.search_metrics_and_dimensions`
   - `lens.validate_query_inputs`
   - `lens.run_query`
4. Decidir plano analitico iterativo
5. Construir draft de dashboard quando necessario:
   - `lens.create_dashboard_draft`
   - `lens.add_dashboard_section`
   - `lens.add_dashboard_widget`
   - `lens.update_dashboard_widget`
   - `lens.set_dashboard_native_filters`
6. Validar draft:
   - `lens.validate_widget_config`
   - `lens.validate_dashboard_draft`
7. Persistir estado final:
   - `lens.save_dashboard_draft`

`lens.list_datasets` permanece por compatibilidade/uso administrativo, mas nao e central na v1 orientada a dataset unico.

## Tool Plan e Historico

- Template de plano de execucao incluido em `GET /mcp/tools` (`execution_plan_template`).
- Historico de chamadas registrado em memoria (`MCPToolHistoryStore`) por `trace_id`.
- Cada chamada recebe `trace_id` (entrada opcional) e devolve `call_id` + `duration_ms`.

## Catalogo Completo

### Context

1. `lens.list_datasets` (compat)
2. `lens.get_dataset_semantic_layer`
3. `lens.get_dataset_catalog`
4. `lens.get_dataset_schema`
5. `lens.search_metrics_and_dimensions`

### Analysis

1. `lens.preview_query` (compat)
2. `lens.profile_dataset`
3. `lens.run_query`
4. `lens.explain_metric`
5. `lens.validate_query_inputs`

### Builder

1. `lens.generate_dashboard_plan` (compat)
2. `lens.create_dashboard_draft`
3. `lens.add_dashboard_section`
4. `lens.add_dashboard_widget`
5. `lens.update_dashboard_widget`
6. `lens.delete_dashboard_widget`
7. `lens.set_dashboard_native_filters`
8. `lens.save_dashboard_draft`

### Validation

1. `lens.validate_widget_config`
2. `lens.validate_dashboard_draft`
3. `lens.suggest_best_visualization`

## Input/Output por Tool (Resumo)

## Context

1. `lens.get_dataset_semantic_layer`
- input: `dataset_id` (obrigatorio)
- output principal: dataset meta, `semantic_columns`, `view_columns`, `metrics`, `dimensions`

2. `lens.get_dataset_catalog`
- input: `dataset_id`
- output principal: `metrics[]`, `dimensions[]`, contagens

3. `lens.get_dataset_schema`
- input: `dataset_id`
- output principal: `fields[]` com `raw_type` + `semantic_type`

4. `lens.search_metrics_and_dimensions`
- input: `dataset_id`, `query`, `limit`
- output principal: hits rankeados em metricas e dimensoes

## Analysis

1. `lens.profile_dataset`
- input: `dataset_id`, `include_row_count`
- output principal: perfil de colunas, contagens, `estimated_row_count`

2. `lens.run_query`
- input: `dataset_id`, `metrics` (obrigatorio), `dimensions`, `filters`, `sort`, `limit`, `offset`
- output principal: `query_spec`, `columns`, `rows`, `row_count`

3. `lens.explain_metric`
- input: `dataset_id` + (`metric_id` ou `metric_name`)
- output principal: metrica e explicacao textual

4. `lens.validate_query_inputs`
- input: mesmo shape de query analitica
- output principal: `normalized_spec` + erros acionaveis

## Builder

1. `lens.create_dashboard_draft`
- input: `dataset_id`, `name`, `description`, `visibility`
- output principal: dashboard criado (com `layout_config`/`native_filters`)

2. `lens.add_dashboard_section`
- input: `dataset_id`, `dashboard_id`, `title`, `columns`, `position`
- output principal: secao adicionada + estado do dashboard

3. `lens.add_dashboard_widget`
- input: `dataset_id`, `dashboard_id`, `widget_type`, `config`, `section_id?`, `placement?`
- output principal: widget criado + layout atualizado

4. `lens.update_dashboard_widget`
- input: `dataset_id`, `dashboard_id`, `widget_id`, campos de update
- output principal: widget atualizado

5. `lens.delete_dashboard_widget`
- input: `dataset_id`, `dashboard_id`, `widget_id`
- output principal: widget removido + layout limpo

6. `lens.set_dashboard_native_filters`
- input: `dataset_id`, `dashboard_id`, `native_filters[]`
- output principal: filtros persistidos

7. `lens.save_dashboard_draft`
- input: `dataset_id`, `dashboard_id`, patch de metadados/layout/filtros
- output principal: estado persistido e validado do dashboard

## Validation

1. `lens.validate_widget_config`
- input: `dataset_id`, `widget_type`, `config`, `dashboard_id?`
- output principal: `normalized_config` ou erros por campo

2. `lens.validate_dashboard_draft`
- input: `dataset_id`, `dashboard_id`, `strict`
- output principal: total/valid/invalid widgets, consistencia geral e erros

3. `lens.suggest_best_visualization`
- input: `dataset_id`, `metrics[]`, `dimensions[]`, `time_column?`, `goal?`
- output principal: ranking de tipos de widget com `recommended_config`

## Validacoes Implementadas

- Compatibilidade entre tipo de widget e shape de configuracao (`WidgetConfig`)
- Compatibilidade entre metricas/dimensoes/filtros e schema do dataset
- Validacao de dependencias KPI derivado (widget dependencies)
- Validacao de filtros nativos e colunas existentes
- Validacao de referencias de widget no `layout_config`
- Erros retornados em formato acionavel (`code`, `field`, `message`)

## Gaps Restantes Para Agente Completo

1. Orquestrador LLM multi-step (planejamento dinamico + decisao de parada)
2. Persistencia duravel do historico/trace (hoje em memoria)
3. Politicas de custo/timeout/retry por tool call
4. Memoria curta de contexto analitico entre iteracoes (alem do trace tecnico)
5. Criticos de qualidade de resposta (confidence scoring / grounded answer checks)
6. Publicacao/versionamento automatizado de dashboards orientado por objetivo


## Integracao OpenAI (hibrida)

Nesta fase, o MCP continua sendo a camada oficial de execucao. O modelo pode sugerir proxima tool/argumentos, mas:

- Lens valida sugestao
- Lens decide
- Lens executa via `tool_registry`
- Lens registra trace/warnings/validation_errors

Allowlist read-only preparada para tool suggestion/future tool calling:
- `lens.get_dataset_semantic_layer`
- `lens.get_dataset_schema`
- `lens.get_dataset_catalog`
- `lens.search_metrics_and_dimensions`
- `lens.profile_dataset`
- `lens.run_query`
- `lens.explain_metric`
- `lens.validate_query_inputs`
- `lens.suggest_best_visualization`

Tools mutaveis de builder seguem fora do controle direto do modelo nesta etapa.
