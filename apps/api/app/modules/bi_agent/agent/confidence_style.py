from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.modules.bi_agent.agent.answerability import confidence_band_for
from app.modules.bi_agent.schemas import BiResponseStatus

ConfidenceBand = Literal["low", "medium", "high"]


@dataclass
class ConfidenceStyle:
    band: ConfidenceBand
    tone_hint: str
    confidence_explanation: str


def build_confidence_style(*, confidence: float, response_status: BiResponseStatus) -> ConfidenceStyle:
    band = confidence_band_for(confidence)
    if response_status == "insufficient_evidence" or band == "low":
        return ConfidenceStyle(
            band="low",
            tone_hint="cautious",
            confidence_explanation="Ainda tenho baixa confianca nesta resposta e preciso de mais evidencias para concluir.",
        )
    if response_status == "needs_clarification" or band == "medium":
        return ConfidenceStyle(
            band="medium",
            tone_hint="balanced",
            confidence_explanation="Tenho uma boa indicacao inicial, mas um refinamento ajuda a responder com mais precisao.",
        )
    return ConfidenceStyle(
        band="high",
        tone_hint="direct",
        confidence_explanation="Estou confiante nesta resposta porque os sinais observados foram consistentes.",
    )

