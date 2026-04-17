# Prompts do Assistente Lens

Esta pasta concentra os prompts usados no ciclo do assistente AI.

## BI Agent (OpenAI Reasoning Adapter)

- `bi_agent_intent_classification_system.txt`
- `bi_agent_question_analysis_system.txt`
- `bi_agent_candidate_reranking_system.txt`
- `bi_agent_hypothesis_suggestion_system.txt`
- `bi_agent_next_action_system.txt`

## BI Agent (Answer Synthesis)

- `bi_agent_final_answer_synthesis_system.txt`

## Dashboard AI Generation

- `dashboard_generation_system_prompt.txt`
- `dashboard_generation_system_fallback_prompt.txt`
- `dashboard_generation_legacy_json_instruction.txt`
- `dashboard_generation_user_task.txt`
- `dashboard_generation_default_user_prompt.txt`

## Snapshots Conversacionais (nao-LMM)

- `bi_agent_ambiguity_questions_snapshot.txt`
- `bi_agent_followup_library_snapshot.txt`

## Observacoes

- O codigo tenta ler estes arquivos em runtime.
- Se um arquivo estiver ausente, o sistema usa fallback interno.
- Ajustes nos arquivos desta pasta passam a refletir no comportamento do assistente sem precisar editar string inline no codigo.
- Os arquivos `*_snapshot.txt` sao referencia de revisao (nao sao carregados automaticamente em runtime).
