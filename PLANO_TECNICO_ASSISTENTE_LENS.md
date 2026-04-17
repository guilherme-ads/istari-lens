# PLANO_TECNICO_ASSISTENTE_LENS

## 1. Objetivo

Transformar o ciclo do Assistente AI do Lens em um fluxo:

- mais objetivo;
- mais aderente a pergunta do usuario;
- menos tecnico na resposta final;
- mais confiavel em producao;
- mais simples de evoluir e observar.

Este plano consolida:

- o diagnostico em [ANALISE_ASSISTENTE.md](C:/Users/adsgu/projects/istari-lens/ANALISE_ASSISTENTE.md)
- as referencias arquiteturais do documento externo de arquitetura de assistentes para analytics/BI

## 2. Principios de implementacao

Vamos seguir estes principios:

- manter `MCP` e tools tipadas como camada oficial de execucao;
- manter guardrails, validacao e auditoria locais;
- evitar reescrita total;
- priorizar mudancas de alto impacto e baixo risco primeiro;
- separar melhor responsabilidades entre:
  - entendimento da pergunta
  - descoberta semantica
  - execucao
  - interpretacao do resultado
  - redacao da resposta

## 3. Diagnostico resumido que guia o plano

Hoje o Lens ja faz bem:

- bootstrap de contexto;
- execucao via tools;
- tracing e auditoria;
- fallback local;
- structured outputs em partes do fluxo.

Hoje o Lens faz mal:

- mapear pergunta de negocio para resposta esperada;
- usar retrieval semantico dentro do fluxo principal;
- escolher a evidencia que responde a pergunta;
- interpretar resultado analitico antes da sintese final;
- evitar redundancia entre backend e frontend.

Em resumo:

- o sistema esta forte em `planner/executor/critic`;
- o sistema esta fraco em `semantic resolution/interpreter/response contract`.

## 4. Arquitetura alvo

Arquitetura recomendada para o Lens:

`User -> Intent + Prompt Shield -> Semantic Resolution -> Query Planning -> MCP/Tool Execution -> Result Interpreter -> Response Synthesizer -> UI`

### Responsabilidades por camada

#### 4.1 Semantic Resolution

Responsavel por:

- entender o que a pergunta realmente quer;
- inferir `expected_answer_shape`;
- recuperar metricas/dimensoes candidatas com semantica;
- decidir se precisa clarificacao.

#### 4.2 Query Planning

Responsavel por:

- transformar a pergunta resolvida em candidatos de query aderentes ao formato da resposta;
- evitar candidatos genericos demais quando a pergunta for especifica.

#### 4.3 MCP / Tool Execution

Mantem o que ja esta bom:

- validacao
- execucao
- retries
- tracing
- guardrails

#### 4.4 Result Interpreter

Nova camada central.

Responsavel por:

- transformar resultados de query em uma resposta interpretada;
- escolher a query que realmente responde a pergunta;
- produzir um payload estruturado para a sintese final.

#### 4.5 Response Synthesizer

Responsavel por:

- redigir a resposta final com linguagem natural;
- respeitar `response_status`, confianca e ambiguidades;
- evitar jargao e duplicacao.

#### 4.6 UI

Responsavel por:

- renderizar um unico contrato conversacional;
- separar auditoria tecnica da resposta principal;
- suportar follow-ups e clarificacoes com boa UX.

## 5. Roadmap incremental

## Fase 0 - Higiene de UX e contrato final

### Objetivo

Melhorar rapidamente a experiencia sem mexer na semantica profunda do agente.

### Escopo

- tornar `chat_presentation` o contrato user-facing principal;
- evitar duplicacao entre `primary_message`, `direct_answer` e `supporting_points`;
- esconder `answer` bruto da aba principal;
- preservar paragrafos no chat;
- limitar a quantidade de pontos de apoio.

### Arquivos impactados

- `apps/web/src/components/builder/BiAgentPanel.tsx`
- `apps/web/src/components/builder/biAgentChatResponse.ts`
- `apps/web/src/components/shared/Chat.tsx`
- opcionalmente `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`

### Entregas

- resposta principal sempre vinda de `chat_presentation`;
- `answer` e `executive_summary` exibidos apenas em auditoria/evidencias;
- deduplicacao no frontend;
- quebra visual de paragrafos no chat.

### Criterios de aceite

- nenhuma resposta aparece duplicada no chat quando `primary_message` e `direct_answer` forem equivalentes;
- a aba principal nunca exibe `answer` bruto se `chat_presentation` estiver presente;
- resposta com `\n\n` aparece como paragrafos distintos;
- supporting points limitados a no maximo 2.

### PR sugerido

- `PR-01-ui-chat-contract`

### Risco

- baixo

### Beneficio esperado

- melhora perceptivel imediata de clareza e legibilidade.

---

## Fase 1 - Introduzir `expected_answer_shape`

### Objetivo

Parar de tratar toda pergunta como exploracao generica.

### Escopo

Adicionar uma nova dimensao ao entendimento da pergunta:

- `expected_answer_shape`

### Valores sugeridos

- `single_best`
- `single_worst`
- `trend`
- `comparison`
- `drivers`
- `definition`
- `dashboard_plan`
- `open_exploration`

### Arquivos impactados

- `apps/api/app/modules/bi_agent/schemas.py`
- `apps/api/app/modules/bi_agent/agent/question_analysis.py`
- `apps/api/app/modules/bi_agent/agent/intent_taxonomy.py`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py`
- `apps/api/tests/test_bi_agent.py`
- `apps/api/tests/test_bi_agent_intent_taxonomy.py`

### Regras iniciais

- perguntas com "qual e o maior / melhor / mais / mais querido / mais usado" -> `single_best`
- perguntas com "qual e o menor / pior / menos" -> `single_worst`
- perguntas com "como evoluiu / tendencia / historico" -> `trend`
- perguntas com "comparar / versus / vs / diferenca" -> `comparison`
- perguntas com "o que explica / por que caiu / drivers / contribuidores" -> `drivers`
- perguntas com "o que significa / explique a metrica" -> `definition`

### Entregas

- `BiQuestionAnalysis` passa a carregar `expected_answer_shape`;
- heuristica local reconhece melhor o formato de resposta;
- adapter OpenAI pode enriquecer esse campo.

### Criterios de aceite

- perguntas ranking/superlativo nao caem em `open_exploration` por padrao;
- testes cobrindo ao menos:
  - `single_best`
  - `trend`
  - `drivers`
  - `definition`

### PR sugerido

- `PR-02-answer-shape`

### Risco

- baixo a medio

### Beneficio esperado

- melhora direta na aderencia entre pergunta e query.

---

## Fase 2 - Trazer `lens.search_metrics_and_dimensions` para o fluxo principal

### Objetivo

Adicionar retrieval semantico real antes da geracao de candidatos.

### Escopo

Usar a tool:

- `lens.search_metrics_and_dimensions`

quando a pergunta tiver baixa resolucao semantica.

### Heuristica de disparo

Executar busca quando:

- `mentioned_metrics` estiver vazio;
- ou `mentioned_dimensions` estiver vazio e a pergunta for especifica;
- ou a pergunta contiver termos subjetivos como:
  - "mais querida"
  - "mais popular"
  - "mais relevante"
  - "mais usada"
  - "melhor"
  - "pior"

### Arquivos impactados

- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`
- possivelmente `apps/api/app/modules/bi_agent/agent/question_analysis.py`
- possivelmente `apps/api/app/modules/bi_agent/agent/executor.py`
- `apps/api/app/modules/mcp/tools/context_tools.py`
- testes do BI Agent

### Decisao tecnica sugerida

Nao adicionar essa tool no adaptive loop.

Usar apenas:

- antes de `generate_query_candidates()`
- como etapa de semantic resolution

### Entregas

- novo passo de descoberta semantica antes de montar candidatos;
- selecao de metricas/dimensoes candidatas com base em texto livre;
- reducao de inferencia cega.

### Criterios de aceite

- perguntas com linguagem de negocio subjetiva passam por retrieval;
- o agente deixa de cair automaticamente na primeira metrica do catalogo sem tentativa de busca;
- casos como "estacao mais querida" passam a selecionar dimensao e metrica com justificativa rastreavel.

### PR sugerido

- `PR-03-semantic-discovery`

### Risco

- medio

### Beneficio esperado

- grande ganho em aderencia semantica.

---

## Fase 3 - Reduzir inferencia automatica agressiva

### Objetivo

Trocar "adivinhar e seguir" por "descobrir ou pedir clarificacao".

### Escopo

Revisar a logica atual em:

- `question_analysis.py`
- `query_candidates.py`

### Mudancas sugeridas

- parar de inferir a primeira metrica sempre que `mentioned_metrics == []`;
- so usar inferencia automatica quando houver:
  - um hit forte no retrieval
  - um sinonimo claro no catalogo
  - historico de conversa realmente consistente
- se a pergunta continuar ambigua, retornar `needs_clarification`.

### Arquivos impactados

- `apps/api/app/modules/bi_agent/agent/question_analysis.py`
- `apps/api/app/modules/bi_agent/agent/conversation_memory.py`
- `apps/api/app/modules/bi_agent/agent/answerability.py`
- testes relacionados

### Entregas

- politica de inferencia mais conservadora;
- melhor uso de `clarifying_questions`;
- menos respostas "corretas tecnicamente, erradas semanticamente".

### Criterios de aceite

- perguntas ambiguidas deixam de produzir resposta direta com metrica aleatoria;
- `needs_clarification` aparece mais cedo quando necessario;
- queda de falsos positivos em `answered`.

### PR sugerido

- `PR-04-safe-inference`

### Risco

- medio

### Beneficio esperado

- aumento importante de confiabilidade.

---

## Fase 4 - Criar a camada `Result Interpreter`

### Objetivo

Resolver a maior lacuna arquitetural do Lens.

### Novo modulo sugerido

- `apps/api/app/modules/bi_agent/agent/result_interpreter.py`

### Contrato sugerido

Criar um modelo estruturado como:

```python
class InterpretedAnswer(BaseModel):
    answer_type: Literal[
        "top_dimension",
        "bottom_dimension",
        "ranking_summary",
        "trend_summary",
        "comparison_summary",
        "definition",
        "insufficient_evidence",
        "needs_clarification",
    ]
    response_status_hint: Literal["answered", "needs_clarification", "insufficient_evidence"]
    selected_candidate_id: str | None = None
    direct_answer: str | None = None
    supporting_facts: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    recommended_next_step: str | None = None
```

### Responsabilidades do interpretador

- escolher a query que melhor responde a pergunta;
- interpretar top-1, ranking, tendencia e comparacoes;
- converter linhas em fatos uteis;
- nao depender do primeiro registro cru;
- preparar um payload limpo para a sintese.

### Regras iniciais por `expected_answer_shape`

#### `single_best`

- procurar query com quebra dimensional ordenada por metrica desc;
- selecionar top row;
- responder:
  - "A X com maior Y e Z."

#### `single_worst`

- selecionar menor valor relevante;
- responder:
  - "A X com pior Y e Z."

#### `trend`

- procurar query temporal;
- identificar subida, queda ou estabilidade;
- citar periodo apenas se houver base.

#### `drivers`

- procurar dimensional breakdown / top contributors / temporal x dimensao;
- escolher contribuidores principais;
- manter cautela com causalidade.

### Arquivos impactados

- novo `result_interpreter.py`
- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`
- `apps/api/app/modules/bi_agent/agent/evidence_selection.py`
- `apps/api/app/modules/bi_agent/schemas.py`
- testes novos dedicados

### Entregas

- payload de resposta interpretada antes da sintese final;
- reducao drastica de findings no formato dump.

### Criterios de aceite

- perguntas de top-1 geram resposta direta em uma frase;
- o sistema nao usa mais `key_findings[0]` como `answer`;
- a query escolhida para responder fica rastreavel.

### PR sugerido

- `PR-05-result-interpreter`

### Risco

- medio

### Beneficio esperado

- maior ganho real de qualidade do projeto.

---

## Fase 5 - Reescrever `rank_query_evidence` para answer-fit

### Objetivo

Fazer a selecao de evidencia servir a resposta, nao so a cobertura.

### Problema atual

O ranking atual valoriza:

- cobertura;
- prioridade do candidato;
- row count;
- novidade.

Mas nao valoriza suficientemente:

- utilidade para responder a pergunta literal.

### Mudancas sugeridas

Adicionar novos componentes de score:

- `answer_fit_score`
- `question_shape_fit_score`
- `interpretability_score`
- `redundancy_penalty`

### Regras

- query que responde diretamente deve ganhar de query mais "rica" mas menos util;
- query temporal nao deve dominar resposta de ranking se a pergunta nao for temporal;
- query overview nao deve virar resposta principal de pergunta sobre top categoria.

### Arquivos impactados

- `apps/api/app/modules/bi_agent/agent/evidence_selection.py`
- testes semanticos

### Criterios de aceite

- para `single_best`, a query selecionada tende a ser de breakdown/ranking, nao overview;
- para `trend`, a query temporal tende a ser a principal;
- queda perceptivel de achados irrelevantes na resposta.

### PR sugerido

- `PR-06-answer-fit-ranking`

### Risco

- medio

### Beneficio esperado

- respostas muito mais aderentes.

---

## Fase 6 - Reescrever `_compose_analyst_answer()` para usar resultado interpretado

### Objetivo

Parar de usar o primeiro finding como resposta final intermediaria.

### Mudanca principal

Trocar:

- `ranked_evidence -> key_findings -> executive_summary -> answer`

por:

- `ranked_evidence -> interpreted_answer -> answer payload -> synthesis`

### Estrutura sugerida

- `answer`
- `executive_summary`
- `key_findings`
- `limitations`

devem nascer do `interpreted_answer`, e nao do finding cru.

### Arquivos impactados

- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`

### Criterios de aceite

- `answer` e `executive_summary` deixam de ser dumps semantizados;
- perguntas objetivas passam a ter `answer` curto e direto;
- `key_findings` passam a complementar a resposta em vez de competir com ela.

### PR sugerido

- `PR-07-answer-composition`

### Risco

- medio

### Beneficio esperado

- melhora estrutural do texto intermediario e do fallback.

---

## Fase 7 - Reescrever a sintese final

### Objetivo

Fazer o LLM final trabalhar em cima de um objeto interpretado e nao de um pacote tecnico ruidoso.

### Mudanca principal

Atualizar `BIFinalAnswerSynthesizer` para receber:

- `interpreted_result`
- `confidence`
- `clarification_options`
- `recommended_next_step`

em vez de depender de:

- `technical_answer`
- `key_findings` tecnicos
- `queries_executed` crus como base principal de raciocinio

### Nova estrutura de saida sugerida

Trocar o foco para um contrato mais simples:

- `primary_message`
- `direct_answer`
- `supporting_points`
- `caveat`
- `follow_up_questions`
- `recommended_next_step`
- `confidence_message`

### Arquivos impactados

- `apps/api/app/modules/bi_agent/answer_synthesis.py`
- `apps/api/app/modules/bi_agent/schemas.py`
- testes de sintese

### Criterios de aceite

- resposta final sempre tenta responder na primeira frase;
- no maximo 2 pontos de apoio;
- sem duplicacao entre `primary_message` e `direct_answer`;
- fallback local continua legivel sem OpenAI.

### PR sugerido

- `PR-08-final-synthesis-v2`

### Risco

- medio

### Beneficio esperado

- estabilidade e qualidade mais previsivel da resposta final.

---

## Fase 8 - Melhorar fallback local e guardrails de saida

### Objetivo

Garantir que o modo sem OpenAI ainda seja bom.

### Mudancas sugeridas

- templates deterministicos por `answer_type`;
- deduplicacao semantica entre campos;
- limite de numero de supporting points;
- filtro final para:
  - jargao tecnico
  - aliases opacos
  - repeticao literal

### Arquivos impactados

- `apps/api/app/modules/bi_agent/answer_synthesis.py`
- possivelmente utilitario novo em `apps/api/app/modules/bi_agent/agent/`

### Criterios de aceite

- fallback local produz resposta objetiva em perguntas simples;
- `short_chat_message` e `direct_answer` nao saem iguais quando ambos existem;
- nunca vaza `m0`, `trace_id`, `schema`, `validation_errors`.

### PR sugerido

- `PR-09-local-fallback-hardening`

### Risco

- baixo

### Beneficio esperado

- qualidade aceitavel mesmo sem runtime OpenAI.

---

## Fase 9 - Expor configuracoes de experimento e observabilidade no frontend

### Objetivo

Dar visibilidade e controle gradual sobre o rollout.

### Mudancas sugeridas

- permitir feature flag para `enable_reasoning_adapter`;
- exibir progresso por etapa;
- exibir quando houve:
  - clarificacao
  - fallback local
  - baixa confianca

### Arquivos impactados

- `apps/web/src/components/builder/BiAgentPanel.tsx`
- `apps/web/src/lib/api.ts`

### Criterios de aceite

- equipe consegue testar variantes do fluxo com controle;
- usuario entende melhor o status da analise.

### PR sugerido

- `PR-10-ui-observability-rollout`

### Risco

- baixo

### Beneficio esperado

- rollout mais seguro e aprendizado mais rapido.

## 6. Plano por PRs

Sequencia sugerida:

1. `PR-01-ui-chat-contract`
2. `PR-02-answer-shape`
3. `PR-03-semantic-discovery`
4. `PR-04-safe-inference`
5. `PR-05-result-interpreter`
6. `PR-06-answer-fit-ranking`
7. `PR-07-answer-composition`
8. `PR-08-final-synthesis-v2`
9. `PR-09-local-fallback-hardening`
10. `PR-10-ui-observability-rollout`

## 7. Backlog tecnico detalhado

## 7.1 Backend

### Novos modelos / schemas

- adicionar `expected_answer_shape` em `BiQuestionAnalysis`
- adicionar schema para `InterpretedAnswer`
- revisar `BiFinalAnswerSynthesis`
- revisar `BiChatPresentation`

### Novos modulos

- `result_interpreter.py`
- opcional: `semantic_resolution.py`
- opcional: `response_guardrails.py`

### Modulos a revisar

- `question_analysis.py`
- `query_candidates.py`
- `evidence_selection.py`
- `bi_agent_orchestrator.py`
- `answer_synthesis.py`
- `conversation_memory.py`

## 7.2 Frontend

### Componentes a revisar

- `BiAgentPanel.tsx`
- `biAgentChatResponse.ts`
- `Chat.tsx`

### Ajustes de contrato

- UI deve depender de um contrato unico de resposta final;
- separar claramente:
  - resposta
  - evidencias
  - auditoria

## 7.3 Testes

### Novos testes recomendados

- perguntas de top-1
- perguntas com termos subjetivos
- perguntas temporais
- perguntas diagnosticas
- verificacao de nao duplicacao
- verificacao de primeira frase responder a pergunta

## 8. Metricas de qualidade para rollout

### 8.1 Produto

- taxa de resposta util por pergunta
- taxa de follow-up necessario
- taxa de correcao manual pelo usuario

### 8.2 Tecnica

- tool success rate
- media de etapas por resposta
- latencia por resposta
- custo por resposta
- taxa de fallback local

### 8.3 Linguagem

- tamanho medio da resposta
- taxa de jargao tecnico
- taxa de duplicacao
- aderencia da primeira frase

## 9. Ordem de prioridade real

Se for necessario cortar escopo, a ordem minima recomendada e:

1. Fase 0
2. Fase 4
3. Fase 2
4. Fase 6
5. Fase 7

Justificativa:

- Fase 0 melhora UX rapido;
- Fase 4 corrige a maior falha estrutural;
- Fase 2 melhora semantica da pergunta;
- Fase 6 e 7 consolidam a nova resposta.

## 10. Resultado esperado ao final

Ao final dessas fases, o Lens deve conseguir:

- entender melhor perguntas em linguagem de negocio;
- evitar respostas baseadas em evidencias irrelevantes;
- responder primeiro, explicar depois;
- perguntar quando realmente houver ambiguidade;
- manter seguranca, auditabilidade e escalabilidade;
- operar com qualidade boa mesmo com fallback local.

## 11. Proximo passo recomendado

Comecar pela implementacao de:

- `PR-01-ui-chat-contract`
- `PR-02-answer-shape`
- `PR-03-semantic-discovery`

porque esse conjunto:

- ja reduz ruido visivel na UX;
- melhora o entendimento da pergunta;
- prepara o terreno para o `Result Interpreter`.

