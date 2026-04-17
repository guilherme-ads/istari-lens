# ANALISE_ASSISTENTE

## 1. Resumo executivo

O problema principal nao esta no fato de o sistema "ter pouco processamento". O problema esta em **onde o sistema esta otimizando**.

Hoje o Assistente:

- otimiza bem cobertura de evidencias, execucao auditavel e guardrails;
- otimiza mal a pergunta literal do usuario;
- gera muitas estruturas intermediarias;
- nao possui uma camada forte de **interpretacao do resultado para resposta**;
- usa a sintese final para "embelezar" uma resposta que ja nasceu ruim.

Em termos praticos:

- a degradacao comeca **antes da sintese final**;
- a pior perda de qualidade acontece entre:
  - `question_analysis.py`
  - `query_candidates.py`
  - `evidence_selection.py`
  - `_compose_analyst_answer()` em `bi_agent_orchestrator.py`
- o frontend ainda pode **ampliar a sensacao de redundancia** ao concatenar diferentes camadas de resposta e ao exibir campos internos que nao foram pensados como UX final.

Conclusao curta:

- a arquitetura esta robusta para execucao;
- a arquitetura ainda esta fraca para **responder exatamente o que foi perguntado**;
- o sistema precisa de uma camada nova e explicita de **result interpretation / answer shaping**;
- antes disso, ha correcoes simples de alto impacto que ja melhoram muito a qualidade.

## 2. Escopo da leitura

Li o fluxo local relevante de ponta a ponta:

### Backend

- `apps/api/app/api/v1/routes/bi_agent.py`
- `apps/api/app/modules/bi_agent/schemas.py`
- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`
- `apps/api/app/modules/bi_agent/answer_synthesis.py`
- `apps/api/app/modules/bi_agent/agent/question_analysis.py`
- `apps/api/app/modules/bi_agent/agent/query_candidates.py`
- `apps/api/app/modules/bi_agent/agent/evidence_selection.py`
- `apps/api/app/modules/bi_agent/agent/critic.py`
- `apps/api/app/modules/bi_agent/agent/answerability.py`
- `apps/api/app/modules/bi_agent/agent/conversation_memory.py`
- `apps/api/app/modules/bi_agent/agent/adaptive_loop.py`
- `apps/api/app/modules/bi_agent/agent/executor.py`
- `apps/api/app/modules/bi_agent/agent/followups.py`
- `apps/api/app/modules/bi_agent/agent/semantic_normalization.py`
- `apps/api/app/modules/bi_agent/agent/value_formatting.py`
- `apps/api/app/modules/bi_agent/agent/intent_taxonomy.py`
- `apps/api/app/modules/bi_agent/agent/intent_strategy.py`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py`

### MCP / contexto / query / "RAG atual"

- `apps/api/app/modules/mcp/tool_registry.py`
- `apps/api/app/modules/mcp/tools/context_tools.py`
- `apps/api/app/modules/mcp/tools/analysis_tools.py`
- `apps/api/app/modules/mcp/tools/validation_tools.py`
- `apps/api/app/modules/mcp/context.py`

### Frontend

- `apps/web/src/lib/api.ts`
- `apps/web/src/components/builder/BiAgentPanel.tsx`
- `apps/web/src/components/builder/biAgentChatResponse.ts`
- `apps/web/src/components/shared/Chat.tsx`

### Documentacao e testes

- `apps/api/LENS_BI_AGENT.md`
- `apps/api/LENS_OPENAI_AUDIT.md`
- testes do BI Agent, sintese, memoria, semantica e golden suite

### Limitacao operacional

Nao consegui executar os testes localmente porque o ambiente atual nao possui `python`, `pytest`, `node`, `npm`, `pnpm` ou `poetry` disponiveis no shell. O diagnostico abaixo foi feito por leitura estatica completa do codigo.

## 3. Como o pipeline funciona hoje

## 3.1 Entrada e frontend

O frontend chama `POST /bi-agent/run` via `api.runBiAgent(...)` em `apps/web/src/components/builder/BiAgentPanel.tsx`.

Observacoes:

- o frontend envia `dataset_id`, `question`, `mode`, `apply_changes=false` e `conversation_history`;
- o frontend **nao expoe** `enable_reasoning_adapter`, `adaptive_mode` nem `max_evidence_steps`, apesar de o backend suportar esses campos em `apps/api/app/modules/bi_agent/schemas.py:49-54`;
- na pratica, a UX atual fica presa ao comportamento padrao.

## 3.2 Bootstrap de contexto

O orquestrador inicia carregando:

- `lens.get_dataset_semantic_layer`
- `lens.get_dataset_schema`
- `lens.get_dataset_catalog`

Isso acontece via `build_context_steps()` e `BIPlanExecutor`.

Importante:

- isso **nao e um RAG vetorial**;
- o "RAG atual" e um retrieval deterministico de:
  - schema
  - catalogo semantico
  - semantic layer
- existe uma tool de busca textual no catalogo, `lens.search_metrics_and_dimensions`, mas ela **nao e usada no fluxo do orquestrador**.

Isso e um achado importante: o sistema tem uma ferramenta de retrieval semantico mais util para linguagem natural, mas o pipeline principal nao a aproveita.

## 3.3 Memoria curta

`resolve_question_with_memory()` pode anexar:

- pergunta anterior do usuario;
- resposta anterior do assistente;
- metrica inferida;
- dimensao inferida.

O mecanismo e util, mas ele tambem pode carregar ruido para a pergunta atual se a resposta anterior ja estava ruim.

## 3.4 Interpretacao da pergunta

O sistema usa:

- `classify_intent()`
- `analyze_question()`
- opcionalmente `OpenAIReasoningAdapter`

O problema aqui e que a analise de pergunta:

- identifica intencao de forma muito rasa;
- faz matching por substring simples;
- quando nao encontra metrica/dimensao, **infere defaults agressivos**.

## 3.5 Geracao de candidatos de query

`generate_query_candidates()` monta um conjunto pequeno e generico:

- `cand_overview`
- `cand_temporal_trend`
- `cand_dimension_breakdown`
- `cand_temporal_dimension`
- `cand_top_contributors`

Ou seja: o sistema explora "visao geral", "tempo", "dimensao", "diagnostico", mas nao modela explicitamente o formato da resposta esperada pelo usuario.

## 3.6 Execucao / adaptive loop

O executor valida e roda queries via:

- `lens.validate_query_inputs`
- `lens.run_query`

O adaptive loop escolhe o proximo candidato pelo ganho de evidencia e cobertura.

O foco aqui esta em:

- cobertura temporal
- cobertura dimensional
- novidade
- custo
- confianca

Mas **nao ha um score forte de "esta query responde diretamente a pergunta?"**.

## 3.7 Critica e answerability

Depois da execucao:

- `BIAgentCritic.review()` calcula confianca;
- `decide_answerability()` decide:
  - `answered`
  - `needs_clarification`
  - `insufficient_evidence`

De novo: o sistema avalia melhor "consigo justificar que executei algo?" do que "tenho a resposta certa para a pergunta do usuario?".

## 3.8 Selecionar evidencia e compor resposta tecnica

Esse e o ponto mais problematico.

O fluxo atual faz:

1. `rank_query_evidence(...)`
2. `_compose_analyst_answer(...)`
3. `_build_executive_summary(...)`

E o comportamento atual e:

- transformar uma query em um "finding" pela **primeira linha retornada**;
- usar o primeiro finding como `executive_summary`;
- usar esse resumo como `answer` em varios casos.

Isto e o centro da degradacao.

## 3.9 Sintese final

`BIFinalAnswerSynthesizer.synthesize()` tenta converter o payload tecnico em uma resposta conversacional.

Porem:

- ele recebe um `technical_answer` que muitas vezes ja esta ruim;
- recebe `key_findings` que ja sao frases tecnicas ou incidentais;
- se o LLM estiver indisponivel, o fallback local preserva boa parte dessa estrutura ruim.

## 3.10 Formatacao final no frontend

O frontend usa tres camadas ao mesmo tempo:

- `chat_presentation`
- `final_answer`
- fallback em `answer` / `executive_summary`

Isso cria inconsistencias e redundancia.

## 4. Diagnostico principal: onde a resposta degrada

## 4.1 Primeira degradacao critica: a pergunta nao vira um "answer shape"

Arquivos principais:

- `apps/api/app/modules/bi_agent/agent/question_analysis.py`
- `apps/api/app/modules/bi_agent/agent/query_candidates.py`

Problema:

- a pergunta do usuario vira intent + metricas + dimensoes + flags;
- ela **nao vira um tipo de resposta esperado**.

Exemplos de answer shape que hoje nao existem explicitamente:

- "qual e o maior X?" -> ranking / top-1 por dimensao
- "qual e o menor X?" -> bottom-1 por dimensao
- "qual estacao e mais querida?" -> superlativo por dimensao com leitura de preferencia/uso
- "como evoluiu?" -> tendencia temporal
- "o que explica?" -> drivers / comparacao

Sem esse answer shape, o sistema explora o dataset, mas nao sabe responder no formato certo.

Impacto:

- o pipeline gera queries "plausiveis", mas nao uma resposta "adequada".

## 4.2 Segunda degradacao critica: inferencia agressiva demais

Arquivos:

- `apps/api/app/modules/bi_agent/agent/question_analysis.py:107-136`
- `apps/api/app/modules/bi_agent/agent/query_candidates.py:105-110`

Problemas:

- se nao encontra metrica, `analyze_question()` infere a primeira metrica do catalogo;
- se nao encontra dimensao explicita, outras partes do fluxo podem cair no primeiro campo categorico;
- `query_candidates.py` usa:
  - `agg = "sum" if primary_metric else "count"`
  - `metric_field = primary_metric or numeric_fields[0] or schema_fields[0]["name"] or "id"`

Consequencia:

- o sistema pode passar a responder algo perfeitamente valido do ponto de vista tecnico, mas totalmente desalinhado do que o usuario queria;
- quando nao ha boa resolucao semantica, o sistema segue em frente em vez de perguntar.

Risco real:

- responder com alta confianca a pergunta errada.

## 4.3 Terceira degradacao critica: falta retrieval semantico real dentro do fluxo

Arquivos:

- `apps/api/app/modules/mcp/tools/context_tools.py:227`
- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`

Achado:

- `lens.search_metrics_and_dimensions` existe;
- o orquestrador nao usa essa tool.

Consequencia:

- perguntas em linguagem de negocio ("mais querida", "preferida", "mais usada", "melhor", "mais relevante") nao passam por uma camada de mapeamento semantico para metricas/dimensoes do catalogo;
- o sistema depende de substring literal e heuristicas locais.

Esse e exatamente o tipo de problema que explica perguntas como:

- "Qual e a estacao mais querida dos usuarios?"

se degradando para algo como:

- data da ultima recarga
- soma de peso percentual minimo
- BYD SAGA 2

O sistema achou dados, mas nao achou o **significado** da pergunta.

## 4.4 Quarta degradacao critica: `rank_query_evidence()` prioriza cobertura, nao resposta

Arquivo:

- `apps/api/app/modules/bi_agent/agent/evidence_selection.py:24`

Problema conceitual:

- o ranking de evidencia considera:
  - row count
  - prioridade do candidato
  - custo
  - alinhamento com intent
  - alinhamento parcial com metricas/dimensoes
  - novidade

Mas ele nao mede de forma explicita:

- "esta query me permite responder literalmente a pergunta?"

Exemplo:

- para uma pergunta de superlativo por dimensao, uma query temporal pode aparecer como forte evidencia;
- isso gera um finding tecnicamente correto, mas inutil para a resposta final.

## 4.5 Quinta degradacao critica: o finding e montado pela primeira linha da query

Arquivo:

- `apps/api/app/modules/bi_agent/agent/evidence_selection.py:141-163`

Comportamento atual:

- pega `first_row`;
- le os tres primeiros campos;
- gera texto no formato:
  - `Titulo: Campo = valor; Campo = valor; Campo = valor.`

Problemas:

- a primeira linha pode nao ser a mais importante;
- os tres primeiros campos podem ser incidentais;
- isso premia colunas tecnicas ou contextuais;
- nao ha interpretacao de top-1, tendencia, share, delta, comparacao ou causalidade;
- o texto resultante tem cara de dump semantizado, nao de resposta.

Esse e o ponto que mais se conecta com o exemplo real fornecido.

## 4.6 Sexta degradacao critica: `executive_summary` e `answer` nascem de um finding ruim

Arquivo:

- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py:713-760`

Problema:

- `key_findings` vem do ranking de evidencia;
- `_build_executive_summary()` usa o primeiro finding;
- para intents exploratorias, `answer = executive_summary`.

Em outras palavras:

- o sistema nao extrai a resposta;
- ele promove o primeiro finding a resposta.

Isso e o motivo de a resposta soar:

- confusa
- tecnica
- indireta
- pouco util

## 4.7 Setima degradacao: a sintese final tenta salvar uma resposta que ja veio ruim

Arquivo:

- `apps/api/app/modules/bi_agent/answer_synthesis.py`

Pontos positivos:

- ha preocupacao real com jargao tecnico;
- ha guardrails;
- ha schema estrito;
- ha fallback.

Mas os problemas sao:

- o prompt e bom como "redator", nao como "interpretador";
- o payload inclui `technical_answer`, `key_findings`, `limitations`, `queries_executed`, `evidence`;
- se `technical_answer` ja e ruim, o melhor que o sintetizador consegue fazer e reembalar o ruim.

O prompt atual em `answer_synthesis.py:144-150` fala em:

- resposta direta
- linguagem natural
- sem jargao

Mas nao impone com forca:

- responder primeiro a pergunta literal;
- evitar duplicacao entre `short_chat_message`, `direct_answer` e `user_friendly_findings`;
- escolher apenas as evidencias diretamente relacionadas a resposta.

## 4.8 O fallback local da sintese preserva duplicacao

Arquivo:

- `apps/api/app/modules/bi_agent/answer_synthesis.py:326`
- `apps/api/app/modules/bi_agent/answer_synthesis.py:350`
- `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py:937-938`
- `apps/web/src/components/builder/biAgentChatResponse.ts:93-117`

Problema:

- no fallback para `answered`, `short_chat_message` recebe `safe_answer`;
- `direct_answer` tambem recebe `safe_answer`;
- depois `chat_presentation.primary_message` usa `short_chat_message`;
- no frontend, `buildFinalChatResponse()` concatena:
  - `primary_message`
  - `direct_answer`
  - `Principais pontos`

Resultado:

- duplicacao facil;
- resposta parece "colada";
- a sensacao de redundancia aumenta muito.

## 4.9 O frontend ainda mistura camadas de resposta internas e finais

Arquivos:

- `apps/web/src/components/builder/BiAgentPanel.tsx:96`
- `apps/web/src/components/builder/BiAgentPanel.tsx:236`
- `apps/web/src/components/builder/biAgentChatResponse.ts:86-176`

Problemas:

- o chat usa `buildFinalChatResponse()`;
- mas a aba "Resposta" ainda mostra `chatPresentation?.primary_message || lastResponse.answer`;
- `answer` e `executive_summary` sao campos internos/utilitarios e nao deveriam ser o principal contrato de UX;
- isso expoe texto tecnico mesmo quando o backend oferece uma versao mais amigavel.

## 4.10 A renderizacao do chat colapsa paragrafos

Arquivo:

- `apps/web/src/components/shared/Chat.tsx:80`

Problema:

- o conteudo e renderizado com `dangerouslySetInnerHTML`;
- apenas `**bold**` e convertido;
- `\n\n` nao vira `<br>` ou `<p>`;
- respostas multi-paragrafo tendem a virar um bloco unico.

Consequencia:

- mesmo uma resposta razoavel pode parecer mais densa e menos objetiva do que realmente e.

## 4.11 A memoria curta pode propagar respostas ruins

Arquivo:

- `apps/api/app/modules/bi_agent/agent/conversation_memory.py:23`

Problema:

- o sistema pode anexar a resposta anterior do assistente diretamente na pergunta resolvida;
- se a resposta anterior ja estava tecnica ou errada, o ruido entra na proxima rodada;
- isso cria drift conversacional.

## 4.12 O frontend nao permite ligar o reasoning adapter

Arquivos:

- `apps/api/app/modules/bi_agent/schemas.py:49-54`
- `apps/web/src/lib/api.ts:902-908`
- `apps/web/src/components/builder/BiAgentPanel.tsx:72-77`

Achado:

- o backend suporta `enable_reasoning_adapter`;
- o frontend nao envia esse campo.

Consequencia:

- a experiencia padrao fica dependente das heuristicas locais;
- isso reduz a capacidade de usar o modelo para resolver ambiguidade semantica em producao.

Observacao importante:

- mesmo sem `enable_reasoning_adapter`, a sintese final ainda pode usar OpenAI se houver runtime ativo;
- mas a parte mais importante do raciocinio anterior a resposta continua local.

## 4.13 Os prompts do reasoning adapter sao curtos demais para o problema

Arquivo:

- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py:60`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py:129`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py:222`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py:300`
- `apps/api/app/modules/bi_agent/agent/openai_reasoning_adapter.py:409`

Problema:

- os prompts sao corretos, mas muito genericos;
- faltam:
  - exemplos;
  - criterios de desempate;
  - orientacao sobre resposta literal a perguntas de negocio;
  - instrucao para reconhecer superlativos, preferencias, ranking, top/bottom, share, contribuidores.

Resultado:

- quando ativado, o adapter pode ajudar;
- mas ele nao tem material suficiente para elevar muito a qualidade sozinho.

## 4.14 A suite de testes protege mais contra vazamento tecnico do que contra inutilidade pratica

Arquivos:

- `apps/api/tests/test_bi_agent_golden_suite.py`
- `apps/api/tests/test_bi_agent_answer_synthesis.py`
- `apps/web/src/components/builder/biAgentChatResponse.test.ts`

Ponto forte:

- os testes protegem contra `m0`, `trace_id`, ausencia de follow-up etc.

Ponto fraco:

- nao validam adequadamente:
  - aderencia literal a pergunta;
  - objetividade;
  - ausencia de redundancia;
  - utilidade pratica;
  - se a primeira frase ja responde a pergunta.

Hoje e possivel passar na suite e ainda entregar uma resposta ruim para o usuario.

## 5. Reconstrucao do problema com o exemplo real

Pergunta:

> "Qual e a estacao mais querida dos usuarios?"

Fluxo provavel no estado atual:

1. A pergunta e classificada como `exploratory_analysis`.
2. O sistema nao encontra claramente:
   - a metrica correta de "querida"
   - a traducao de "querida" para uso, share, recorrencia, preferencia etc.
3. Sem retrieval semantico forte, ele cai em defaults:
   - primeira metrica plausivel
   - primeira dimensao categorica plausivel
4. O candidate set generico roda:
   - overview
   - temporal trend
   - dimension breakdown
5. `rank_query_evidence()` promove evidencias por cobertura/priority/row_count.
6. `_build_finding_text()` transforma a primeira linha de uma query em frase.
7. `_build_executive_summary()` usa o primeiro finding.
8. `_compose_analyst_answer()` devolve esse resumo como resposta.
9. A sintese final so reescreve ou replica o material.

Por isso o resultado fica assim:

- aparece data da ultima recarga, porque a query temporal entrou como evidencia "forte";
- aparece nome de estacao, porque alguma quebra dimensional trouxe isso;
- aparece metrica agregada sem contexto, porque o sistema nao interpretou "mais querida" como top-1 de uma medida de preferencia/uso;
- tudo entra na resposta como colagem de findings.

Em resumo:

- o sistema respondeu o dataset;
- nao respondeu a pergunta.

## 6. Problemas por categoria

## 6.1 Prompt engineering

Problemas:

- prompts do reasoning adapter sao curtos e sem few-shot;
- prompt de sintese nao recebe um objeto "resposta interpretada", recebe um pacote tecnico;
- nao ha proibicao forte de repetir `short_chat_message` em `direct_answer`;
- nao ha regra forte de formato:
  - 1 frase direta
  - 2 evidencias no maximo
  - 1 ressalva
  - 1 follow-up

## 6.2 Arquitetura

Problema arquitetural central:

- existe planner;
- existe executor;
- existe critic;
- existe synthesizer;
- **nao existe interpreter**.

Ou seja:

- ninguem e dono de transformar resultado de query em resposta exata.

## 6.3 Pos-processamento

Problemas:

- sanitizacao troca alias opaco, mas nao melhora logica;
- fallback replica textos;
- `supporting_points` e `key_findings` se sobrepoem;
- o frontend concatena camadas.

## 6.4 Interpretacao da query

Problemas:

- leitura baseada em primeira linha;
- nenhum modulo explicito para:
  - top-1
  - ranking
  - comparacao
  - share
  - delta
  - outlier
  - tendencia

## 6.5 Formatacao final

Problemas:

- resposta longa pode virar bloco unico;
- aba principal ainda mostra campo interno bruto;
- excesso de seccoes tecnicas pode confundir o usuario comum.

## 7. Melhorias praticas e implementaveis

Vou priorizar do mais simples/mais impacto para o mais estrutural.

## 7.1 Fase 0: melhorias simples, alto impacto, baixo risco

### 7.1.1 Tornar `chat_presentation` o unico contrato user-facing

Recomendacao:

- usar `chat_presentation` como resposta canonica da UI;
- tratar `answer`, `executive_summary`, `key_findings` como campos de auditoria;
- na aba "Resposta", parar de exibir `lastResponse.answer` como fallback principal.

Impacto:

- reduz muito a exposicao de texto tecnico.

### 7.1.2 Eliminar duplicacao entre `primary_message` e `direct_answer`

Recomendacao:

- se `direct_answer` for igual ou muito parecido com `primary_message`, nao renderizar de novo no frontend;
- se `short_chat_message == direct_answer` no fallback, preencher apenas um dos campos.

Impacto:

- reduz redundancia imediata.

### 7.1.3 Limitar `supporting_points` a 2 itens nao redundantes

Recomendacao:

- no backend, compor `supporting_points` a partir de evidencias selecionadas e nao da uniao cega entre `user_friendly_findings` e `key_findings`;
- no frontend, mostrar no maximo 2.

### 7.1.4 Preservar paragrafos no chat

Recomendacao:

- converter `\n` em `<br>` ou renderizar markdown/paragrafos de verdade em `Chat.tsx`.

Impacto:

- melhora legibilidade sem alterar logica analitica.

### 7.1.5 Parar de usar o primeiro finding como resposta

Recomendacao:

- ajuste minimo em `_compose_analyst_answer()`:
  - se existir uma quebra dimensional com ordenacao descendente por metrica e `limit` pequeno, extrair top row;
  - se existir pergunta do tipo "qual e o maior/mais/mais querido", responder com o valor do top row;
  - usar `executive_summary` apenas como apoio, nao como `answer`.

Impacto:

- e a mudanca mais importante de curto prazo.

## 7.2 Fase 1: adicionar camada de `Result Interpreter`

### Objetivo

Criar um modulo novo, por exemplo:

- `apps/api/app/modules/bi_agent/agent/result_interpreter.py`

Responsabilidade:

- receber:
  - `question`
  - `question_analysis`
  - `query_candidates`
  - `queries_executed`
  - `label_index`
- devolver um objeto estruturado do tipo:
  - `answer_type`
  - `direct_answer`
  - `supporting_facts`
  - `caveats`
  - `selected_query_candidate_id`
  - `selected_rows`

### Answer types sugeridos

- `top_dimension`
- `bottom_dimension`
- `ranking_summary`
- `trend_summary`
- `comparison_summary`
- `metric_definition`
- `insufficient_evidence`
- `needs_clarification`

### Exemplo para a pergunta da estacao

Input interpretado:

- `answer_type = top_dimension`
- `dimension = estacao`
- `metric = share_preferencia` ou metrica equivalente resolvida
- `winner = BYD SAGA 2`
- `winner_value = 12,92%`

Output desejado:

- `direct_answer = "A estacao mais querida e a BYD SAGA 2."`
- `supporting_facts = ["Ela lidera a quebra por estacao no indicador disponivel.", "No recorte atual, representa 12,92% do indicador usado para estimar preferencia."]`
- `caveat = "Estou assumindo que 'mais querida' significa a estacao com maior uso/preferencia no indicador disponivel."`

### Beneficios

- reduz drasticamente resposta colada;
- diminui dependencia da LLM para fazer interpretacao basica;
- melhora confiabilidade;
- reduz custo da sintese final.

## 7.3 Fase 2: melhorar a interpretacao da pergunta

### 7.3.1 Introduzir `answer_shape` ja no `question_analysis`

Adicionar um campo como:

- `expected_answer_shape`

Valores:

- `single_best`
- `single_worst`
- `trend`
- `drivers`
- `comparison`
- `definition`
- `dashboard_plan`
- `open_exploration`

Isso deve nascer da pergunta, nao da query.

### 7.3.2 Usar `lens.search_metrics_and_dimensions` quando o mapeamento for fraco

Heuristica sugerida:

- se `mentioned_metrics` vazio e `mentioned_dimensions` vazio;
- ou se a pergunta usar termos subjetivos/sinonimos ("mais querido", "mais popular", "mais usado", "melhor", "pior", "mais relevante");
- rodar `lens.search_metrics_and_dimensions` antes de gerar candidatos.

### 7.3.3 Reduzir inferencia automatica cega

Trocar a estrategia atual:

- "nao achei metrica, vou usar a primeira"

por algo mais seguro:

- "nao achei metrica, vou tentar retrieval";
- "se ainda nao achar, vou perguntar";
- "so infiro automaticamente quando houver forte sinal semantico".

## 7.4 Fase 3: melhorar a geracao de QuerySpec

Hoje o sistema tem candidatos genericos. Sugiro incluir candidatos mais aderentes ao tipo de pergunta:

### Novos templates sugeridos

- `cand_top_dimension`
- `cand_bottom_dimension`
- `cand_dimension_share`
- `cand_dimension_rank`
- `cand_metric_comparison`
- `cand_trend_delta`

### Regras simples

- perguntas com "qual e o mais/maior/melhor/mais querido" -> candidate top-1 por dimensao;
- perguntas com "qual e o menos/pior" -> candidate bottom-1;
- perguntas com "participacao/share" -> quebra por dimensao com percentual;
- perguntas com "o que explica" -> temporal + dimensao + ranking de contribuidores;
- perguntas com "como evoluiu" -> trend.

### Beneficio

- a query ja nasce mais proxima da resposta esperada.

## 7.5 Fase 4: trocar o criterio de selecao de evidencia

Em vez de selecionar "a query mais forte genericamente", selecionar "a query que melhor responde a pergunta".

### Novo score sugerido

Adicionar em `rank_query_evidence()`:

- `answer_fit_score`
- `question_shape_fit_score`
- `top_row_interpretable_score`
- `redundancy_penalty`

### Regra de ouro

Para resposta final:

- uma query de alta answer-fit deve ganhar de uma query com maior cobertura, se ela responder diretamente ao usuario.

## 7.6 Fase 5: reescrever a composicao da resposta

### Substituir `_compose_analyst_answer()` por duas etapas

1. `interpret_result(...)`
2. `compose_answer_payload(...)`

### Estrutura sugerida

- `direct_answer`
- `executive_summary`
- `supporting_points`
- `limitations`
- `recommended_next_step`

Regra:

- `direct_answer` deve sempre tentar responder em uma frase curta;
- `executive_summary` deve resumir a leitura;
- `supporting_points` deve trazer no maximo 2 itens.

## 8. Melhorias de qualidade de resposta

## 8.1 Estrutura ideal de resposta

Para quase todas as perguntas de negocio, a resposta ideal deveria seguir:

1. **Resposta direta**
2. **2 evidencias no maximo**
3. **1 ressalva, apenas se necessaria**
4. **1 proximo passo opcional**

Exemplo:

> A estacao mais querida e a BYD SAGA 2.  
> Ela lidera a quebra por estacao no indicador disponivel e aparece com 12,92% no recorte atual.  
> Se voce quiser, eu tambem posso mostrar essa preferencia por periodo ou por perfil de usuario.

## 8.2 Regras de formatacao

Regras propostas:

- no maximo 4 frases;
- primeira frase deve responder a pergunta;
- sem "Resumo executivo:" no chat principal;
- sem prefixo de candidate title;
- sem `Campo = valor; Campo = valor` como formato padrao;
- no maximo 2 numeros por resposta, salvo pergunta explicitamente numerica;
- sem repetir a mesma informacao em `primary_message`, `direct_answer` e `supporting_points`.

## 8.3 Estrategia de fallback

Hoje o fallback local e seguro, mas ainda feio.

Novo fallback recomendado:

- se `answer_type` conhecido:
  - gerar resposta por template deterministico;
- se `answer_type` desconhecido e baixa confianca:
  - responder que nao foi possivel concluir;
  - explicar 1 motivo;
  - fazer 1 pergunta objetiva;
- nunca concatenar resumo tecnico bruto.

## 8.4 Reducao de alucinacao

Medidas recomendadas:

- responder apenas com base na query selecionada como `selected_answer_query`;
- proibir inferencias que nao estejam no resultado interpretado;
- se a pergunta depender de um conceito nao mapeado ("mais querida"), explicitar a metrica assumida;
- usar o LLM apenas para reescrita, nao para inventar ligacoes entre evidencias.

## 8.5 Aumento de objetividade

Medidas recomendadas:

- primeira frase obrigatoriamente orientada a pergunta;
- limite de tokens na sintese final;
- schema de saida mais restrito;
- deduplicacao semantica entre campos;
- no frontend, renderizar apenas a camada canonica.

## 8.6 UX conversacional

Melhorias:

- follow-up sempre como pergunta real, nao como acao imperativa;
- follow-up deve depender do `response_status`;
- quando houver ambiguidade, fazer **1 pergunta objetiva**, nao 4 variacoes do mesmo tema;
- quando houver resposta boa, follow-up deve ser opcional e util:
  - "Quer ver por periodo?"
  - "Quer comparar com outra estacao?"

## 9. Prompts novos sugeridos

## 9.1 Prompt novo para sintese final (`final_answer_synthesis_v3`)

### System prompt sugerido

```text
Voce e o redator final de um assistente de BI para usuarios de negocio.

Sua tarefa e transformar um resultado analitico JA INTERPRETADO em uma resposta curta, objetiva e util.

Regras obrigatorias:
1. Responda primeiro a pergunta do usuario em uma frase curta.
2. Use linguagem de negocio, em portugues, sem jargao tecnico.
3. Nao mencione trace_id, schema, tool calls, validation errors, candidate ids ou aliases como m0/m1.
4. Nao repita a mesma informacao em campos diferentes.
5. Se houver baixa confianca ou ambiguidade relevante, diga isso de forma direta e faca no maximo 2 perguntas de esclarecimento.
6. Nao invente metricas, dimensoes, valores, periodos ou causalidade.
7. Use no maximo 2 pontos de apoio.
8. Se houver resposta direta suportada, o campo direct_answer deve ser preenchido.
9. Se nao houver resposta suficiente, o campo direct_answer deve ficar vazio.
10. Retorne apenas JSON valido no schema informado.
```

### Payload de entrada recomendado

Em vez de mandar `technical_answer` bruto e `key_findings` brutos, mandar:

```json
{
  "question": "...",
  "response_status_hint": "answered",
  "interpreted_result": {
    "answer_type": "top_dimension",
    "direct_answer": "A estacao mais querida e a BYD SAGA 2.",
    "supporting_facts": [
      "Ela lidera a quebra por estacao no indicador de preferencia disponivel.",
      "No recorte atual, aparece com 12,92% do indicador."
    ],
    "caveat": "Estou assumindo que 'mais querida' significa a estacao com maior uso/preferencia no indicador disponivel."
  },
  "confidence": {
    "score": 0.78,
    "band": "high"
  },
  "clarification_options": [],
  "recommended_next_step": "Posso mostrar a preferencia por periodo ou por perfil de usuario."
}
```

### Schema recomendado

```json
{
  "response_status": "answered | needs_clarification | insufficient_evidence",
  "primary_message": "string",
  "direct_answer": "string | null",
  "supporting_points": ["string"],
  "caveat": "string | null",
  "follow_up_questions": ["string"],
  "recommended_next_step": "string | null",
  "confidence_message": "string | null"
}
```

## 9.2 Prompt novo para resolucao semantica da pergunta (`semantic_resolution_v1`)

Esse prompt so deve rodar quando a heuristica local tiver baixa confianca.

### Objetivo

Resolver:

- qual metrica parece representar o conceito do usuario;
- qual dimensao esta em foco;
- qual formato de resposta o usuario espera.

### System prompt sugerido

```text
Voce resolve perguntas de negocio para um assistente de BI de dataset unico.

Mapeie a pergunta do usuario para:
- intencao analitica
- metricas candidatas
- dimensoes candidatas
- expected_answer_shape
- ambiguidades relevantes

Voce deve priorizar a interpretacao que melhor responda a pergunta literal do usuario.

Exemplos de expected_answer_shape:
- single_best
- single_worst
- trend
- comparison
- drivers
- definition
- dashboard_plan
- open_exploration

Se a pergunta usar termos de negocio subjetivos como "mais querida", "mais popular", "mais relevante", "melhor", "pior", tente mapea-los para metricas e dimensoes do catalogo. Se nao houver base suficiente, marque ambiguidade em vez de inventar.

Retorne apenas JSON valido no schema informado.
```

## 10. Arquitetura recomendada

## 10.1 Arquitetura alvo

### Camada 1: Input Understanding

- pergunta
- memoria curta
- semantic retrieval quando necessario
- saida: `QuestionIntent + ExpectedAnswerShape + EntityResolution`

### Camada 2: Query Planning

- gera candidatos aderentes ao answer shape
- seleciona candidatos principais

### Camada 3: Query Execution

- executor atual
- adaptive loop atual

### Camada 4: Result Interpretation

- nova camada
- extrai resposta objetiva dos resultados
- determina `answer_type`

### Camada 5: Response Composition

- deterministic templates para casos comuns
- LLM barato apenas para polimento conversacional quando necessario

### Camada 6: Frontend Rendering

- um unico contrato user-facing
- abas tecnicas separadas

## 10.2 Separacao recomendada de responsabilidades entre LLMs

### Opcao simples e boa para producao

- LLM 1: apenas para semantic resolution em casos ambiguos
- LLM 2: apenas para rewrite final quando houver resultado interpretado

### O que deve ficar deterministicamente local

- execucao de tools
- selecao de query
- interpretacao basica de top-1 / ranking / trend / comparacao
- deduplicacao
- fallback

### Beneficio

- menor custo
- menor latencia
- menos variabilidade
- melhor auditabilidade

## 11. Mudancas concretas por arquivo

## 11.1 `apps/api/app/modules/bi_agent/agent/question_analysis.py`

Mudar:

- adicionar `expected_answer_shape`
- reduzir inferencia automatica cega
- identificar superlativos e perguntas de ranking
- identificar termos subjetivos que exigem retrieval ou clarificacao

## 11.2 `apps/api/app/modules/bi_agent/agent/query_candidates.py`

Mudar:

- adicionar novos templates de query aderentes ao answer shape
- nao cair em `schema_fields[0]` como metrica de forma tao facil
- parametrizar melhor top-1, ranking e share

## 11.3 `apps/api/app/modules/bi_agent/agent/evidence_selection.py`

Mudar:

- substituir leitura da primeira linha por interpretadores por tipo;
- adicionar `answer_fit_score`;
- evitar findings no formato dump.

## 11.4 `apps/api/app/modules/bi_agent/bi_agent_orchestrator.py`

Mudar:

- inserir `result_interpreter` entre evidence ranking e answer synthesis;
- parar de usar primeiro finding como `answer`;
- separar payload tecnico de payload conversacional.

## 11.5 `apps/api/app/modules/bi_agent/answer_synthesis.py`

Mudar:

- receber `interpreted_result` em vez de `technical_answer` bruto;
- simplificar fallback local;
- impedir duplicacao estrutural entre campos.

## 11.6 `apps/web/src/components/builder/biAgentChatResponse.ts`

Mudar:

- nao concatenar `primary_message` + `direct_answer` se forem equivalentes;
- usar apenas o contrato canonico de resposta;
- limitar supporting points.

## 11.7 `apps/web/src/components/builder/BiAgentPanel.tsx`

Mudar:

- aba "Resposta" deve usar apenas o payload final user-facing;
- mover `answer` e `executive_summary` crus para auditoria;
- opcionalmente expor flags de experimento como `enable_reasoning_adapter`.

## 11.8 `apps/web/src/components/shared/Chat.tsx`

Mudar:

- preservar paragrafos;
- idealmente renderizar markdown simples.

## 12. Plano de implementacao por etapas

## Etapa 1 - 1 a 2 dias - Ganhos rapidos

- tornar `chat_presentation` contrato canonico no frontend;
- evitar duplicacao entre `primary_message` e `direct_answer`;
- preservar paragrafos no chat;
- reduzir quantidade de pontos de apoio;
- esconder `answer` bruto da aba principal.

### Impacto esperado

- melhora perceptivel imediata de UX;
- pouca mudanca de risco.

## Etapa 2 - 2 a 4 dias - Melhorar resposta sem reescrever tudo

- criar `result_interpreter.py`;
- implementar answer types:
  - `top_dimension`
  - `trend_summary`
  - `comparison_summary`
  - `insufficient_evidence`
- trocar `_compose_analyst_answer()` para usar interpretador.

### Impacto esperado

- maior ganho real de qualidade.

## Etapa 3 - 2 a 3 dias - Melhorar retrieval semantico

- usar `lens.search_metrics_and_dimensions` no pipeline;
- adicionar `expected_answer_shape`;
- reduzir inferencia agressiva.

### Impacto esperado

- melhor aderencia a perguntas em linguagem natural.

## Etapa 4 - 2 dias - Reescrever sintese e fallback

- novo prompt de sintese;
- novo schema;
- fallback deterministico limpo.

### Impacto esperado

- respostas mais consistentes e menos variaveis.

## Etapa 5 - 2 a 3 dias - Qualidade e observabilidade

- nova golden suite focada em aderencia;
- testes com perguntas reais;
- metricas de qualidade:
  - resposta direta na primeira frase
  - taxa de duplicacao
  - taxa de jargao
  - taxa de `needs_clarification`
  - satisfacao do usuario

## 13. Suite de qualidade recomendada

Sugiro incluir testes que validem:

### 13.1 Aderencia literal

Para pergunta:

- "Qual e a estacao mais querida dos usuarios?"

Esperar algo como:

- primeira frase contem "estacao" e o nome de uma estacao;
- nao contem "Resumo executivo";
- nao contem data irrelevante se a pergunta nao for temporal.

### 13.2 Objetividade

Esperar:

- no maximo 4 frases;
- no maximo 2 supporting points.

### 13.3 Nao redundancia

Esperar:

- `primary_message` diferente de `direct_answer`, ou `direct_answer` nulo.

### 13.4 Relevancia

Esperar:

- se pergunta for ranking, a resposta deve citar ranking/top-1;
- se pergunta for temporal, a resposta deve citar periodo/tendencia;
- se pergunta for explicacao, a resposta deve citar causa/driver ou admitir que nao sabe.

## 14. Prioridade final recomendada

Se eu tivesse que escolher apenas 5 acoes agora, faria nesta ordem:

1. Criar `result_interpreter` e parar de usar primeiro finding como resposta.
2. Usar `lens.search_metrics_and_dimensions` quando a pergunta vier com baixa resolucao semantica.
3. Tornar `chat_presentation` o unico contrato user-facing.
4. Reescrever o fallback local para nao duplicar resposta.
5. Reforcar a golden suite com aderencia semantica a perguntas reais.

## 15. Conclusao final

O assistente atual esta mais perto de um **executor auditavel de exploracao analitica** do que de um **assistente que responde perguntas de negocio com clareza**.

Isso nao exige uma reescrita total.

O caminho mais eficiente e:

- manter planner/executor/critic;
- inserir uma camada de interpretacao de resultado;
- simplificar a camada final de resposta;
- reduzir a exposicao de artefatos tecnicos na UI;
- testar qualidade pela pergunta do usuario, nao apenas pela integridade do pipeline.

Se essas mudancas forem feitas, o sistema tende a ficar:

- mais objetivo
- mais util
- mais claro
- mais conversacional
- mais confiavel
- mais pronto para producao
