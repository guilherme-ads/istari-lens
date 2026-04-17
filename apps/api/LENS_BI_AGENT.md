# Lens BI Agent (v4 - Arquitetura Hibrida Lens + OpenAI)

Esta versao evolui o BI Agent para um modelo hibrido:

- OpenAI decide tarefas cognitivas com structured outputs.
- Lens continua controlando execucao MCP, guardrails, validacao e auditoria.

## Principio Arquitetural

- OpenAI ajuda a decidir.
- Lens controla a execucao.
- MCP permanece camada oficial de tools.
- Guardrails, retries, dry-run e stopping criteria continuam locais.

## Componentes

## 1) OpenAIAdapter unificado

Arquivos:
- `app/modules/openai_adapter/client.py`
- `app/modules/openai_adapter/schemas.py`
- `app/modules/openai_adapter/errors.py`
- `app/modules/openai_adapter/tracing.py`
- `app/modules/openai_adapter/tooling.py`

Responsabilidades:
- chamada centralizada da Responses API
- retries/timeouts padronizados
- parsing e validacao de structured outputs
- metadados de tracing (`OpenAITraceMetadata`)
- allowlist para tool suggestion read-only

## 2) BI Agent Orchestrator

Arquivo:
- `app/modules/bi_agent/bi_agent_orchestrator.py`

Responsabilidades Lens:
- bootstrap de contexto via MCP
- planejamento deterministico + adaptive loop
- execucao via `tool_registry.execute(...)`
- guardrails locais
- consolidacao de resposta auditavel

Integracao hibrida:
- resolve adapter dinamicamente por request
- usa `OpenAIReasoningAdapter` quando `enable_reasoning_adapter=true` e existe integracao OpenAI ativa
- fallback local automatico para heuristicas

## 3) OpenAIReasoningAdapter

Arquivo:
- `app/modules/bi_agent/agent/openai_reasoning_adapter.py`

Tarefas cognitivas com structured outputs:
1. `intent_classification`
2. `question_analysis`
3. `candidate_reranking`
4. `hypothesis_suggestion`
5. `next_action_suggestion`

Cada etapa:
- usa schema estrito
- aplica guardrails locais
- registra contribuicoes aceitas/rejeitadas
- ativa fallback heuristico quando necessario

## 3.1) Taxonomia unificada de intencoes

Arquivos:
- `app/modules/bi_agent/agent/intent_taxonomy.py`
- `app/modules/bi_agent/agent/intents.py`
- `app/modules/bi_agent/agent/question_analysis.py`

Papel:
- centralizar definicao de intencoes e sinais
- reduzir divergencia entre classificacao de intencao e analise de pergunta
- manter defaults por intencao (diagnostico/comparacao/visualizacao/dashboard)

## 4) Adaptive Evidence Loop

Arquivo:
- `app/modules/bi_agent/agent/adaptive_loop.py`

Evolucoes:
- propaga `trace_id` para sugestoes cognitivas
- aceita sugestao apenas quando compativel com guardrails
- rejeita tool sugestiva fora do escopo do loop adaptativo
- segue com ranking local quando sugestao e invalida

## 5) Final Answer Synthesizer

Arquivo:
- `app/modules/bi_agent/answer_synthesis.py`

Papel:
- transforma resultado tecnico do agente em resposta conversacional para usuario final
- usa OpenAI Responses API + Structured Outputs (schema estrito)
- preserva guardrails: sem inventar fatos, sem esconder ambiguidade, sem inflar confianca
- fallback local obrigatorio quando chamada/schema/consistencia falham
- guarda versao explicita de prompt/schema para auditoria (`prompt_version`, `schema_version`)
- rejeita sintese com jargao tecnico no chat final (ex.: `trace_id`, `validation_errors`, `schema`)

Schema principal da sintese:
- `response_status` (`answered|needs_clarification|insufficient_evidence`)
- `short_chat_message`
- `direct_answer`
- `why_not_fully_answered`
- `assumptions_used`
- `clarifying_questions`
- `recommended_next_step`
- `confidence_explanation`
- `user_friendly_findings`
- `chat_presentation` (payload pronto para UI conversacional)

## Divisao de responsabilidades

## Lens (controle local)

- execucao MCP
- validacao de argumentos
- guardrails (dry-run, max steps, retries, allowlist)
- stopping criteria
- persistencia
- auditoria final

## OpenAI (cognitivo estruturado)

- classificacao de intencao
- interpretacao estruturada da pergunta
- sugestao de hipoteses/gaps
- reranqueamento de candidatos
- sugestao da proxima acao

## Fluxo Planner -> Executor -> Critic

1. Recebe `question + dataset_id`
2. Carrega contexto (`semantic_layer`, `schema`, `catalog`)
3. Resolve memoria curta (`conversation_history`) para referencias como "essa metrica"/"agora por periodo"
4. Classifica intencao (OpenAI estruturado + fallback)
5. Executa `question_analysis` (OpenAI estruturado + fallback)
6. Gera candidatos locais
7. Reranqueia candidatos (OpenAI estruturado + fallback)
8. Roda adaptive loop com ganho de evidencia
9. Executa pos-processamento (visualizacao/plano/draft conforme modo)
10. Critic final calcula confianca e gaps
11. Retorna payload auditavel

## Modos

- `answer`: responde sem criar dashboard
- `plan`: responde + dashboard_plan
- `draft`: pode criar draft; dry-run por padrao

## Fallback e Guardrails

Fallback automatico para heuristica/local quando:
- chamada OpenAI falha
- schema invalido
- confianca abaixo do threshold
- sugestao viola guardrails
- sugestao inconsistente com contexto

Guardrails principais:
- dry-run default
- limite de steps/retries
- sem persistencia sem `apply_changes=true`
- sem tools mutaveis sob controle direto do modelo

## Tool Suggestion / Future Tool Calling

Tools elegiveis (read-only nesta fase):
- `lens.get_dataset_semantic_layer`
- `lens.get_dataset_schema`
- `lens.get_dataset_catalog`
- `lens.search_metrics_and_dimensions`
- `lens.profile_dataset`
- `lens.run_query`
- `lens.explain_metric`
- `lens.validate_query_inputs`
- `lens.suggest_best_visualization`

Tools mutaveis seguem 100% locais:
- `lens.add_dashboard_section`
- `lens.add_dashboard_widget`
- `lens.update_dashboard_widget`
- `lens.delete_dashboard_widget`
- `lens.save_dashboard_draft`

## Tracing e Auditoria

Correlacao por `trace_id`:
- chamadas OpenAI -> `openai_trace`
- chamadas MCP -> `tool_calls`
- evidencia coletada -> `evidence`/`queries_executed`
- decisoes adaptativas -> `adaptive_decisions`
- motivo de parada -> `stopping_reason`
- trilha de qualidade de resposta -> `quality_trace`
- trilha de memoria curta -> `quality_trace` (`stage=memory`)

Campos novos relevantes no output:
- `reasoning_adapter_contributions`
- `openai_trace`
- `final_answer`
- `response_status`
- `short_chat_message`
- `clarifying_questions`
- `recommended_next_step`
- `confidence_explanation`
- `user_friendly_findings`
- `answer_synthesis_trace`
- `answer_synthesis_fallback_used`
- `quality_trace`
- `chat_presentation`

## Contrato do endpoint

Endpoint:
- `POST /bi-agent/run`

Input:
- `dataset_id` (obrigatorio)
- `question` (obrigatorio)
- `conversation_history` (opcional, estruturado por turnos `user|assistant|ai`)
- `mode` (`answer|plan|draft`)
- `apply_changes` (default `false`)
- `adaptive_mode` (default `true`)
- `max_evidence_steps`
- `enable_reasoning_adapter` (default `false`)
- `dashboard_id` (opcional)
- `trace_id` (opcional)

Output (resumo):
- `answer`, `executive_summary`, `key_findings`
- `chat_presentation` (mensagem principal e follow-ups para chat)
- `conversation_memory` (memoria curta aplicada, referencias usadas, inferencias)
- `assumptions`, `ambiguities`, `limitations`
- `final_answer`, `response_status`, `short_chat_message`
- `clarifying_questions`, `recommended_next_step`, `confidence_explanation`
- `analysis_state`, `hypotheses`, `evidence_gaps`
- `adaptive_decisions`, `next_query_candidates`, `stopping_reason`
- `reasoning_adapter_contributions`, `openai_trace`, `answer_synthesis_trace`
- `quality_trace`
- `tool_calls`, `queries_executed`, `trace_id`

## Limites atuais

1. Tool calling nativo OpenAI ainda em modo preparatorio (sem execucao direta)
2. Diagnostico segue correlacional (nao causal)
3. Custo de query ainda estimado por heuristica
4. Sem memoria persistente multi-execucao

## UX e semantica de valores

- Evidencias e findings passam por normalizacao semantica (labels de negocio)
- Valores sao formatados por contexto (moeda, percentual, data, contagem) para linguagem mais natural
- Contrato `chat_presentation` separa conteudo user-facing de detalhes tecnicos em abas de auditoria

## Golden Suite (avaliacao continua)

- Testes de regressao multi-intencao cobrem casos KPI, dashboard, diagnostico, temporal e visualizacao
- Checks minimos automaticos:
  - resposta user-facing nao vazar tokens opacos (`m0`, `trace_id`)
  - coerencia entre `response_status` e tipo de resposta entregue
  - presenca de trilha de qualidade (`quality_trace`) com estagios centrais

## Proximo passo exato

Implementar piloto opt-in de tool calling nativo OpenAI somente para tools read-only allowlisted, com validacao local obrigatoria antes de executar cada call e reconciliacao explicita de estado no adaptive loop.
