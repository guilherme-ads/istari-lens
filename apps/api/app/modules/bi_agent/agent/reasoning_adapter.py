from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from typing import Protocol

from app.modules.bi_agent.schemas import BiAgentIntent, BiReasoningAdapterContribution
from app.modules.openai_adapter.schemas import OpenAITraceMetadata
from app.modules.bi_agent.schemas import (
    BiAgentHypothesis,
    BiEvidenceGap,
    BiNextQueryCandidate,
    BiQueryCandidate,
    BiQuestionAnalysis,
)


@dataclass
class AdapterNextActionSuggestion:
    candidate_id: str
    reason: str
    tool_name: str = "lens.run_query"
    arguments: dict[str, Any] | None = None
    hypothesis_to_test: str | None = None
    confidence: float = 0.0
    metadata: dict[str, Any] | None = None


class ReasoningAdapter(Protocol):
    async def classify_intent(
        self,
        *,
        question: str,
        allowed_intents: list[BiAgentIntent],
        trace_id: str,
    ) -> BiAgentIntent | None:
        ...

    async def enrich_question_analysis(
        self,
        *,
        question: str,
        analysis: BiQuestionAnalysis,
        context: dict[str, Any],
        trace_id: str,
    ) -> BiQuestionAnalysis:
        ...

    async def rerank_query_candidates(
        self,
        *,
        analysis: BiQuestionAnalysis,
        candidates: list[BiQueryCandidate],
        trace_id: str,
    ) -> list[BiQueryCandidate]:
        ...

    async def refine_hypotheses(
        self,
        *,
        analysis: BiQuestionAnalysis,
        hypotheses: list[BiAgentHypothesis],
        evidence_gaps: list[BiEvidenceGap],
        trace_id: str,
    ) -> tuple[list[BiAgentHypothesis], list[BiEvidenceGap]]:
        ...

    async def suggest_next_candidate(
        self,
        *,
        analysis: BiQuestionAnalysis,
        ranked_candidates: list[BiNextQueryCandidate],
        execution_context: dict[str, Any],
        trace_id: str,
    ) -> AdapterNextActionSuggestion | None:
        ...

    def consume_reasoning_contributions(self) -> list[BiReasoningAdapterContribution]:
        ...

    def consume_openai_trace_events(self) -> list[OpenAITraceMetadata]:
        ...


@dataclass
class DefaultReasoningAdapter:
    async def classify_intent(
        self,
        *,
        question: str,
        allowed_intents: list[BiAgentIntent],
        trace_id: str,
    ) -> BiAgentIntent | None:
        _ = question, allowed_intents, trace_id
        return None

    async def enrich_question_analysis(
        self,
        *,
        question: str,
        analysis: BiQuestionAnalysis,
        context: dict[str, Any],
        trace_id: str,
    ) -> BiQuestionAnalysis:
        _ = question, context, trace_id
        return analysis

    async def rerank_query_candidates(
        self,
        *,
        analysis: BiQuestionAnalysis,
        candidates: list[BiQueryCandidate],
        trace_id: str,
    ) -> list[BiQueryCandidate]:
        _ = analysis, trace_id
        return list(candidates)

    async def refine_hypotheses(
        self,
        *,
        analysis: BiQuestionAnalysis,
        hypotheses: list[BiAgentHypothesis],
        evidence_gaps: list[BiEvidenceGap],
        trace_id: str,
    ) -> tuple[list[BiAgentHypothesis], list[BiEvidenceGap]]:
        _ = analysis, trace_id
        return list(hypotheses), list(evidence_gaps)

    async def suggest_next_candidate(
        self,
        *,
        analysis: BiQuestionAnalysis,
        ranked_candidates: list[BiNextQueryCandidate],
        execution_context: dict[str, Any],
        trace_id: str,
    ) -> AdapterNextActionSuggestion | None:
        _ = analysis, ranked_candidates, execution_context, trace_id
        return None

    def consume_reasoning_contributions(self) -> list[BiReasoningAdapterContribution]:
        return []

    def consume_openai_trace_events(self) -> list[OpenAITraceMetadata]:
        return []
