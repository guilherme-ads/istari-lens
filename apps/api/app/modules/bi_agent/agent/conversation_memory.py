from __future__ import annotations

import re
from typing import Any

from app.modules.bi_agent.schemas import BiConversationMemory, BiConversationTurn

_REFERENTIAL_HINTS = (
    "essa metrica",
    "essa dimensão",
    "essa dimensao",
    "isso",
    "agora",
    "tambem",
    "também",
    "e por",
    "e agora",
    "esse resultado",
    "neste caso",
)


def resolve_question_with_memory(
    *,
    question: str,
    conversation_history: list[BiConversationTurn],
    catalog: dict[str, Any] | None,
    max_turns: int = 4,
) -> BiConversationMemory:
    original = str(question or "").strip()
    if not original:
        return BiConversationMemory(applied=False, original_question="", resolved_question="")

    if not conversation_history:
        return BiConversationMemory(
            applied=False,
            original_question=original,
            resolved_question=original,
        )

    turns = [item for item in conversation_history if str(item.content or "").strip()][-max_turns * 2 :]
    last_user = next((item.content.strip() for item in reversed(turns) if item.role == "user" and item.content.strip()), "")
    last_assistant = next((item.content.strip() for item in reversed(turns) if item.role in {"assistant", "ai"} and item.content.strip()), "")

    should_apply = _has_referential_signal(original)
    inferred_metric = _infer_metric_from_history(question=original, turns=turns, catalog=catalog)
    inferred_dimension = _infer_dimension_from_history(question=original, turns=turns, catalog=catalog)

    references_used: list[str] = []
    notes: list[str] = []
    resolved_question = original

    if should_apply and last_user:
        references_used.append("previous_user_question")
        notes.append("Pergunta atual foi interpretada com contexto da pergunta anterior.")
        resolved_question = (
            f"{original}\n\n"
            f"Contexto de memoria curta:\n"
            f"- Pergunta anterior do usuario: {last_user}"
        )
        if last_assistant:
            references_used.append("previous_assistant_answer")
            notes.append("Resposta anterior do assistente foi usada como contexto.")
            resolved_question += f"\n- Resposta anterior do assistente: {last_assistant}"

    if inferred_metric:
        references_used.append("metric_reference")
        notes.append(f"Metrica de referencia inferida do contexto: {inferred_metric}.")
        resolved_question += f"\n- Metrica de referencia: {inferred_metric}"

    if inferred_dimension:
        references_used.append("dimension_reference")
        notes.append(f"Dimensao de referencia inferida do contexto: {inferred_dimension}.")
        resolved_question += f"\n- Dimensao de referencia: {inferred_dimension}"

    applied = should_apply or bool(inferred_metric or inferred_dimension)
    return BiConversationMemory(
        applied=applied,
        original_question=original,
        resolved_question=resolved_question if applied else original,
        references_used=list(dict.fromkeys(references_used)),
        inferred_metric=inferred_metric,
        inferred_dimension=inferred_dimension,
        source_turns_count=len(turns),
        notes=notes,
    )


def _has_referential_signal(question: str) -> bool:
    normalized = _normalize(question)
    return any(token in normalized for token in _REFERENTIAL_HINTS)


def _infer_metric_from_history(
    *,
    question: str,
    turns: list[BiConversationTurn],
    catalog: dict[str, Any] | None,
) -> str | None:
    if not _should_infer_metric(question):
        return None
    metrics = _catalog_names(catalog=catalog, key="metrics")
    return _find_reference_from_turns(turns=turns, candidates=metrics)


def _infer_dimension_from_history(
    *,
    question: str,
    turns: list[BiConversationTurn],
    catalog: dict[str, Any] | None,
) -> str | None:
    if not _should_infer_dimension(question):
        return None
    dimensions = _catalog_names(catalog=catalog, key="dimensions")
    return _find_reference_from_turns(turns=turns, candidates=dimensions)


def _should_infer_metric(question: str) -> bool:
    normalized = _normalize(question)
    return any(token in normalized for token in ("metrica", "métrica", "kpi", "indicador", "isso"))


def _should_infer_dimension(question: str) -> bool:
    normalized = _normalize(question)
    return any(token in normalized for token in ("dimens", "por ", "segment", "canal", "regiao", "região", "categoria", "estacao", "estação"))


def _find_reference_from_turns(*, turns: list[BiConversationTurn], candidates: list[str]) -> str | None:
    if not candidates:
        return None
    lowered_candidates = [(item, _normalize(item)) for item in candidates]
    for turn in reversed(turns):
        content = _normalize(turn.content)
        for original, normalized in lowered_candidates:
            if normalized and re.search(rf"\b{re.escape(normalized)}\b", content):
                return original
    return None


def _catalog_names(*, catalog: dict[str, Any] | None, key: str) -> list[str]:
    if not isinstance(catalog, dict):
        return []
    items = catalog.get(key)
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
        synonyms = item.get("synonyms")
        if isinstance(synonyms, list):
            names.extend([str(value).strip() for value in synonyms if isinstance(value, str) and value.strip()])
    return list(dict.fromkeys(names))


def _normalize(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())

