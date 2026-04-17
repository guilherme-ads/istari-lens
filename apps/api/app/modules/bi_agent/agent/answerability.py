from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.modules.bi_agent.schemas import BiResponseStatus

ConfidenceBand = Literal["low", "medium", "high"]


@dataclass
class AnswerabilityDecision:
    status: BiResponseStatus
    confidence_band: ConfidenceBand
    reasons: list[str] = field(default_factory=list)
    should_ask_clarification: bool = False
    minimum_evidence_met: bool = False


def confidence_band_for(confidence: float) -> ConfidenceBand:
    value = max(0.0, min(1.0, float(confidence)))
    if value >= 0.75:
        return "high"
    if value >= 0.45:
        return "medium"
    return "low"


def decide_answerability(
    *,
    success: bool,
    confidence: float,
    has_minimum_evidence: bool,
    ambiguity_level: str,
    ambiguity_count: int,
    should_request_refinement: bool,
    non_empty_query_count: int,
    validation_errors_count: int,
) -> AnswerabilityDecision:
    band = confidence_band_for(confidence)
    reasons: list[str] = []

    if validation_errors_count > 0:
        reasons.append("Existem erros de validacao que podem afetar a confiabilidade da resposta.")

    if not has_minimum_evidence or non_empty_query_count == 0:
        reasons.append("Ainda nao ha evidencia suficiente para uma resposta conclusiva.")

    high_ambiguity = ambiguity_level == "high" or (ambiguity_count > 0 and should_request_refinement)
    medium_ambiguity = ambiguity_level == "medium" and ambiguity_count > 0

    if high_ambiguity and band != "high":
        reasons.append("A pergunta ainda permite interpretacoes diferentes que mudam a resposta.")
        return AnswerabilityDecision(
            status="needs_clarification",
            confidence_band=band,
            reasons=reasons,
            should_ask_clarification=True,
            minimum_evidence_met=bool(has_minimum_evidence),
        )

    if (not has_minimum_evidence or not success) and band == "low":
        return AnswerabilityDecision(
            status="insufficient_evidence",
            confidence_band=band,
            reasons=reasons,
            should_ask_clarification=high_ambiguity or medium_ambiguity,
            minimum_evidence_met=False,
        )

    if medium_ambiguity and band == "low":
        reasons.append("A ambiguidade restante reduz a confianca da conclusao.")
        return AnswerabilityDecision(
            status="needs_clarification",
            confidence_band=band,
            reasons=reasons,
            should_ask_clarification=True,
            minimum_evidence_met=bool(has_minimum_evidence),
        )

    return AnswerabilityDecision(
        status="answered",
        confidence_band=band,
        reasons=reasons,
        should_ask_clarification=medium_ambiguity and band != "high",
        minimum_evidence_met=bool(has_minimum_evidence),
    )

