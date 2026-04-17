from __future__ import annotations

from app.modules.bi_agent.schemas import BiAgentAmbiguityItem, BiAgentIntent, BiQuestionAnalysis, BiResponseStatus

_AMBIGUITY_QUESTION_BY_CODE = {
    "missing_metric_reference": "Qual metrica voce quer priorizar nesta analise?",
    "missing_dimension_reference": "Qual dimensao voce quer usar como recorte principal?",
    "temporal_signal_without_temporal_field": "Qual coluna representa o periodo para esta analise?",
    "low_semantic_signal": "Pode detalhar metrica e recorte que voce quer analisar?",
    "underspecified_question": "Pode detalhar melhor o que voce quer analisar neste dataset?",
}

_INTENT_FOLLOWUP_LIBRARY: dict[BiAgentIntent, list[str]] = {
    "kpi_summary": [
        "Quer que eu detalhe esses KPIs por periodo?",
        "Quer focar em uma metrica especifica primeiro?",
    ],
    "exploratory_analysis": [
        "Quer que eu aprofunde em algum corte especifico?",
        "Prefere ver essa analise por periodo ou por dimensao?",
    ],
    "dashboard_generation": [
        "Quer que eu monte um plano de dashboard executivo com esses achados?",
        "Qual publico vai consumir esse dashboard?",
    ],
    "visualization_help": [
        "Voce quer comparar categorias, tendencia no tempo ou composicao?",
        "Quer que eu sugira 2 opcoes de grafico e seus trade-offs?",
    ],
    "diagnostic_analysis": [
        "Quer que eu compare os periodos de maior queda antes e depois?",
        "Qual dimensao deve ser priorizada para explicar a queda?",
    ],
    "metric_explanation": [
        "Quer exemplos praticos de como interpretar essa metrica?",
        "Quer comparar essa metrica com outra complementar?",
    ],
}


def build_ambiguity_questions(
    *,
    ambiguities: list[BiAgentAmbiguityItem],
    intent: BiAgentIntent | str,
) -> list[str]:
    questions: list[str] = []
    for item in ambiguities:
        by_code = _AMBIGUITY_QUESTION_BY_CODE.get(item.code)
        if by_code:
            questions.append(by_code)
        if item.suggested_refinement:
            questions.append(_as_question(item.suggested_refinement))
        for alt in item.alternatives[:2]:
            questions.append(_as_question(f"Voce quer seguir por {alt}"))

    if not questions and ambiguities:
        questions.extend(_INTENT_FOLLOWUP_LIBRARY.get(intent, [])[:2])

    return _dedupe(questions)[:4]


def build_followup_questions(
    *,
    intent: BiAgentIntent | str,
    response_status: BiResponseStatus,
    question_analysis: BiQuestionAnalysis | None,
    ambiguities: list[BiAgentAmbiguityItem],
    next_best_actions: list[str],
) -> list[str]:
    questions: list[str] = []

    if response_status == "needs_clarification":
        questions.extend(build_ambiguity_questions(ambiguities=ambiguities, intent=intent))

    if response_status != "needs_clarification":
        questions.extend(_INTENT_FOLLOWUP_LIBRARY.get(intent, [])[:2])

    if question_analysis and question_analysis.requires_temporal and response_status != "needs_clarification":
        questions.append("Quer que eu inclua uma comparacao temporal na proxima iteracao?")
    if question_analysis and question_analysis.requires_comparison and response_status != "needs_clarification":
        questions.append("Quer comparar periodos ou segmentos especificos?")

    for action in next_best_actions[:2]:
        if "mode='plan'" in action:
            questions.append("Quer que eu retorne um plano de dashboard agora?")
        elif "validation_errors" in action.lower():
            questions.append("Quer que eu destaque o que precisa ser ajustado para repetir a analise?")
        elif "refinar pergunta" in action.lower():
            questions.append("Qual metrica, periodo e dimensao devo priorizar na proxima pergunta?")

    return _dedupe([_as_question(item) for item in questions])[:6]


def _as_question(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.endswith("?"):
        return text
    return f"{text}?"


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for item in items:
        cleaned = str(item or "").strip()
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        deduped.append(cleaned)
    return deduped
