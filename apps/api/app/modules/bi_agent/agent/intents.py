from __future__ import annotations

from app.modules.bi_agent.agent.intent_taxonomy import classify_intent_by_taxonomy
from app.modules.bi_agent.schemas import BiAgentIntent


def classify_intent(question: str) -> BiAgentIntent:
    return classify_intent_by_taxonomy(question)
