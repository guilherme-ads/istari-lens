# Auditoria OpenAI no Lens (estado atual da branch `feat/lens-mcp-tools`)

Data: 2026-03-31

## 9. Recursos OpenAI usados hoje

## 9.1 Responses API
- Status: **Usado**
- Onde:
  - `app/modules/openai_adapter/client.py`
  - `app/modules/dashboards/application/ai_generation.py`
  - `app/api/v1/routes/api_config.py`
  - `app/modules/bi_agent/agent/openai_reasoning_adapter.py`
- Uso:
  - tarefas cognitivas do BI Agent
  - dashboard planning
  - teste de integracao OpenAI

## 9.2 Structured Outputs (JSON Schema)
- Status: **Usado**
- Onde:
  - `openai_adapter/schemas.py`
  - `openai_reasoning_adapter.py`
  - `ai_generation.py`
- Uso:
  - intent/question/hypothesis/next-action/rerank
  - dashboard plan

## 9.3 Function/Tool Calling nativo OpenAI
- Status: **Nao executado no core (preparado)**
- Onde:
  - `openai_adapter/tooling.py`
- Uso:
  - mapeamento de tools MCP para formato compativel
  - allowlist read-only

## 9.4 Chat Completions API
- Status: **Nao usado no fluxo principal**

## 9.5 Reasoning models (uso explicito dedicado)
- Status: **Parcial**
- Observacao:
  - modelo configuravel via integracao ativa
  - sem policy dedicada por intent ainda

## 9.6 Streaming
- Status: **Nao usado**

## 9.7 Embeddings / File Search / Assistants / Agents SDK
- Status: **Nao usados**

## 10. Onde sao usados no Lens

- `openai_adapter/*`: camada unificada de cliente, schemas, erros, tracing
- `bi_agent/agent/openai_reasoning_adapter.py`: camada cognitiva estruturada
- `bi_agent/bi_agent_orchestrator.py`: resolve adapter e correlaciona tracing
- `dashboards/application/ai_generation.py`: dashboard planning via adapter unificado
- `api/v1/routes/api_config.py`: teste de integracao e billing

## 11. O que ainda e simulado manualmente

- heuristica de fallback em:
  - `intents.py`
  - `question_analysis.py`
  - `query_candidates.py`
  - `adaptive_loop.py`
- execucao de tools permanece local via MCP (por design)

## 12. Nivel de alinhamento com OpenAI

Classificacao: **Parcialmente alinhado (alto progresso)**

Por que:
- forte alinhamento em Responses + structured outputs + tracer correlacionado
- controle operacional permanece local (boa governanca)
- tool calling nativo ainda nao ativo no fluxo principal

## 13. Lacunas importantes

1. Tool calling nativo ainda sem rollout no executor principal
2. Sem streaming de respostas
3. Sem embeddings/file search para memoria semantica
4. Sem policy de modelo por tarefa/latencia/custo

## 14. Pontos fortes atuais

1. `OpenAIAdapter` unificado e reutilizavel
2. BI Agent hibrido com fallback explicito
3. Guardrails locais preservados
4. `trace_id` correlaciona OpenAI + MCP + decisoes adaptativas
5. MCP segue como camada oficial de tools

## 15. Riscos tecnicos

1. Dependencia de heuristica local ainda relevante quando OpenAI indisponivel
2. Qualidade pode variar com schema mal calibrado
3. Sem tool-calling nativo ativo, parte da decisao ainda exige mapping manual

## 16. Recomendacao inicial (sem implementar nesta auditoria)

1. Pilotar tool-calling nativo opt-in para allowlist read-only
2. Adicionar policy de selecao de modelo por tarefa cognitiva
3. Evoluir tracing para painel dedicado de revisao humana no frontend
