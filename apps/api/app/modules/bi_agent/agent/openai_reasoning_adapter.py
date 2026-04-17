from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.modules.bi_agent.agent.reasoning_adapter import AdapterNextActionSuggestion, ReasoningAdapter
from app.modules.bi_agent.schemas import (
    BiAgentAmbiguityItem,
    BiAgentHypothesis,
    BiAgentIntent,
    BiEvidenceGap,
    BiNextQueryCandidate,
    BiQueryCandidate,
    BiQuestionAnalysis,
    BiReasoningAdapterContribution,
)
from app.modules.openai_adapter.client import OpenAIAdapterClient, OpenAIRuntimeConfig, get_openai_adapter_client
from app.modules.openai_adapter.errors import OpenAIAdapterError, OpenAIAdapterSchemaError
from app.modules.openai_adapter.schemas import (
    CandidateRerankingResult,
    HypothesisSuggestionResult,
    IntentClassificationResult,
    NextActionSuggestionResult,
    OpenAITraceMetadata,
    QuestionAnalysisResult,
)
from app.modules.openai_adapter.tooling import is_openai_tool_suggestion_allowed

PROMPTS_DIR = Path(__file__).resolve().parents[3] / "prompts" / "assistant_lens"

INTENT_CLASSIFICATION_PROMPT_PATH = PROMPTS_DIR / "bi_agent_intent_classification_system.txt"
QUESTION_ANALYSIS_PROMPT_PATH = PROMPTS_DIR / "bi_agent_question_analysis_system.txt"
CANDIDATE_RERANKING_PROMPT_PATH = PROMPTS_DIR / "bi_agent_candidate_reranking_system.txt"
HYPOTHESIS_SUGGESTION_PROMPT_PATH = PROMPTS_DIR / "bi_agent_hypothesis_suggestion_system.txt"
NEXT_ACTION_PROMPT_PATH = PROMPTS_DIR / "bi_agent_next_action_system.txt"


@lru_cache(maxsize=8)
def _load_prompt(path: Path, fallback: str) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except Exception:
        return fallback
    return value or fallback


class OpenAIReasoningAdapter(ReasoningAdapter):
    def __init__(
        self,
        *,
        runtime: OpenAIRuntimeConfig,
        client: OpenAIAdapterClient | None = None,
        confidence_threshold: float = 0.55,
    ) -> None:
        self.runtime = runtime
        self.client = client or get_openai_adapter_client()
        self.confidence_threshold = float(confidence_threshold)
        self._contributions: list[BiReasoningAdapterContribution] = []
        self._trace_events: list[OpenAITraceMetadata] = []

    async def classify_intent(
        self,
        *,
        question: str,
        allowed_intents: list[BiAgentIntent],
        trace_id: str,
    ) -> BiAgentIntent | None:
        schema = {
            "name": "intent_classification",
            "strict": True,
            "schema": IntentClassificationResult.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_prompt(
                    INTENT_CLASSIFICATION_PROMPT_PATH,
                    (
                        "Classifique a intencao analitica do usuario. "
                        "Retorne apenas JSON no schema, sem texto livre."
                    ),
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "question": question,
                        "allowed_intents": allowed_intents,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            parsed, trace = await self.client.responses_structured(
                runtime=self.runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="intent_classification",
                schema_name="intent_classification",
                schema=schema,
                output_model=IntentClassificationResult,
            )
            model = IntentClassificationResult.model_validate(parsed)
            if model.intent not in allowed_intents or float(model.confidence) < self.confidence_threshold:
                self._record_rejected(
                    trace=trace,
                    contribution_type="intent_classification",
                    summary="Intent classification rejected due guardrails/confidence.",
                    payload={"intent": model.intent, "confidence": model.confidence},
                    fallback_reason="low_confidence_or_invalid_intent",
                )
                return None
            self._record_accepted(
                trace=trace,
                contribution_type="intent_classification",
                summary="Intent classification accepted from OpenAI.",
                payload={"intent": model.intent, "confidence": model.confidence},
            )
            return model.intent
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            self._record_exception(
                task="intent_classification",
                trace_id=trace_id,
                contribution_type="intent_classification",
                summary="Intent classification fallback to heuristic.",
                exc=exc,
            )
            return None

    async def enrich_question_analysis(
        self,
        *,
        question: str,
        analysis: BiQuestionAnalysis,
        context: dict[str, Any],
        trace_id: str,
    ) -> BiQuestionAnalysis:
        schema = {
            "name": "question_analysis",
            "strict": True,
            "schema": QuestionAnalysisResult.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_prompt(
                    QUESTION_ANALYSIS_PROMPT_PATH,
                    (
                        "Analise a pergunta do usuario para BI em dataset unico. "
                        "Retorne JSON estrito seguindo o schema."
                    ),
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "question": question,
                        "heuristic_analysis": analysis.model_dump(mode="json"),
                        "context": context,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            parsed, trace = await self.client.responses_structured(
                runtime=self.runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="question_analysis",
                schema_name="question_analysis",
                schema=schema,
                output_model=QuestionAnalysisResult,
            )
            model = QuestionAnalysisResult.model_validate(parsed)
            if float(model.confidence) < self.confidence_threshold:
                self._record_rejected(
                    trace=trace,
                    contribution_type="question_analysis",
                    summary="Question analysis rejected due low confidence.",
                    payload={"confidence": model.confidence},
                    fallback_reason="low_confidence",
                )
                return analysis
            mapped = BiQuestionAnalysis(
                intent=model.intent,
                expected_answer_shape=model.expected_answer_shape,
                mentioned_metrics=model.mentioned_metrics,
                inferred_metrics=model.inferred_metrics,
                mentioned_dimensions=model.mentioned_dimensions,
                inferred_dimensions=model.inferred_dimensions,
                requires_temporal=model.requires_temporal,
                requires_comparison=model.requires_comparison,
                requires_diagnostic=model.requires_diagnostic,
                requires_visualization=model.requires_visualization,
                requires_dashboard=model.requires_dashboard,
                ambiguity_level=model.ambiguity_level,
                should_request_refinement=model.should_request_refinement,
                assumptions=model.assumptions,
                ambiguities=[
                    BiAgentAmbiguityItem(
                        code=f"openai_ambiguity_{index + 1}",
                        description=item,
                        alternatives=[],
                        suggested_refinement=None,
                    )
                    for index, item in enumerate(model.ambiguities)
                    if isinstance(item, str) and item.strip()
                ],
            )
            self._record_accepted(
                trace=trace,
                contribution_type="question_analysis",
                summary="Question analysis accepted from OpenAI structured output.",
                payload={"confidence": model.confidence},
            )
            return mapped
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            self._record_exception(
                task="question_analysis",
                trace_id=trace_id,
                contribution_type="question_analysis",
                summary="Question analysis fallback to heuristic.",
                exc=exc,
            )
            return analysis

    async def rerank_query_candidates(
        self,
        *,
        analysis: BiQuestionAnalysis,
        candidates: list[BiQueryCandidate],
        trace_id: str,
    ) -> list[BiQueryCandidate]:
        schema = {
            "name": "candidate_reranking",
            "strict": True,
            "schema": CandidateRerankingResult.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_prompt(
                    CANDIDATE_RERANKING_PROMPT_PATH,
                    "Reranqueie candidatos de query para ganho de evidencia. Retorne JSON estrito.",
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "analysis": analysis.model_dump(mode="json"),
                        "candidates": [item.model_dump(mode="json") for item in candidates],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            parsed, trace = await self.client.responses_structured(
                runtime=self.runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="candidate_reranking",
                schema_name="candidate_reranking",
                schema=schema,
                output_model=CandidateRerankingResult,
            )
            model = CandidateRerankingResult.model_validate(parsed)
            if model.confidence < self.confidence_threshold:
                self._record_rejected(
                    trace=trace,
                    contribution_type="candidate_rerank",
                    summary="Candidate reranking rejected due low confidence.",
                    payload={"confidence": model.confidence},
                    fallback_reason="low_confidence",
                )
                return list(candidates)
            current_map = {item.candidate_id: item for item in candidates}
            if set(model.ranked_candidate_ids) != set(current_map.keys()):
                self._record_rejected(
                    trace=trace,
                    contribution_type="candidate_rerank",
                    summary="Candidate reranking rejected due id mismatch.",
                    payload={"ranked_candidate_ids": model.ranked_candidate_ids},
                    fallback_reason="id_mismatch",
                )
                return list(candidates)
            ordered = [current_map[item] for item in model.ranked_candidate_ids]
            self._record_accepted(
                trace=trace,
                contribution_type="candidate_rerank",
                summary="Candidate reranking accepted from OpenAI.",
                payload={"confidence": model.confidence, "ranked_candidate_ids": model.ranked_candidate_ids},
            )
            return ordered
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            self._record_exception(
                task="candidate_reranking",
                trace_id=trace_id,
                contribution_type="candidate_rerank",
                summary="Candidate reranking fallback to heuristic.",
                exc=exc,
            )
            return list(candidates)

    async def refine_hypotheses(
        self,
        *,
        analysis: BiQuestionAnalysis,
        hypotheses: list[BiAgentHypothesis],
        evidence_gaps: list[BiEvidenceGap],
        trace_id: str,
    ) -> tuple[list[BiAgentHypothesis], list[BiEvidenceGap]]:
        schema = {
            "name": "hypothesis_suggestion",
            "strict": True,
            "schema": HypothesisSuggestionResult.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_prompt(
                    HYPOTHESIS_SUGGESTION_PROMPT_PATH,
                    (
                        "Sugira hipoteses e lacunas de evidencia para analise BI em dataset unico. "
                        "Retorne JSON estrito no schema."
                    ),
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "analysis": analysis.model_dump(mode="json"),
                        "hypotheses": [item.model_dump(mode="json") for item in hypotheses],
                        "evidence_gaps": [item.model_dump(mode="json") for item in evidence_gaps],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            parsed, trace = await self.client.responses_structured(
                runtime=self.runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="hypothesis_suggestion",
                schema_name="hypothesis_suggestion",
                schema=schema,
                output_model=HypothesisSuggestionResult,
            )
            model = HypothesisSuggestionResult.model_validate(parsed)
            if float(model.confidence) < self.confidence_threshold:
                self._record_rejected(
                    trace=trace,
                    contribution_type="hypothesis_suggestion",
                    summary="Hypothesis suggestion rejected due low confidence.",
                    payload={"confidence": model.confidence},
                    fallback_reason="low_confidence",
                )
                return list(hypotheses), list(evidence_gaps)

            merged_hypotheses = list(hypotheses)
            existing_hypothesis_statements = {item.statement.strip().lower() for item in merged_hypotheses if item.statement}
            for index, item in enumerate(model.hypotheses[:4]):
                statement = str(item.statement or "").strip()
                if not statement or statement.lower() in existing_hypothesis_statements:
                    continue
                existing_hypothesis_statements.add(statement.lower())
                merged_hypotheses.append(
                    BiAgentHypothesis(
                        hypothesis_id=f"openai_hyp_{index + 1}",
                        statement=statement,
                        status="open",
                        confidence=max(0.2, min(0.8, round(float(model.confidence) * 0.8, 2))),
                        notes=(str(item.supporting_signal).strip() if item.supporting_signal else None),
                    )
                )

            merged_gaps = list(evidence_gaps)
            existing_gap_codes = {item.code for item in merged_gaps}
            for item in model.evidence_gaps[:5]:
                code = str(item.code or "").strip()
                description = str(item.description or "").strip()
                if not code or not description or code in existing_gap_codes:
                    continue
                existing_gap_codes.add(code)
                merged_gaps.append(
                    BiEvidenceGap(
                        code=code,
                        description=description,
                        priority=item.priority,
                        resolved=False,
                    )
                )

            self._record_accepted(
                trace=trace,
                contribution_type="hypothesis_suggestion",
                summary="Hypothesis suggestions accepted from OpenAI.",
                payload={
                    "confidence": model.confidence,
                    "added_hypotheses": max(0, len(merged_hypotheses) - len(hypotheses)),
                    "added_evidence_gaps": max(0, len(merged_gaps) - len(evidence_gaps)),
                },
            )
            return merged_hypotheses, merged_gaps
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            self._record_exception(
                task="hypothesis_suggestion",
                trace_id=trace_id,
                contribution_type="hypothesis_suggestion",
                summary="Hypothesis suggestion fallback to local heuristics.",
                exc=exc,
            )
            return list(hypotheses), list(evidence_gaps)

    async def suggest_next_candidate(
        self,
        *,
        analysis: BiQuestionAnalysis,
        ranked_candidates: list[BiNextQueryCandidate],
        execution_context: dict[str, Any],
        trace_id: str,
    ) -> AdapterNextActionSuggestion | None:
        schema = {
            "name": "next_action_suggestion",
            "strict": True,
            "schema": NextActionSuggestionResult.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_prompt(
                    NEXT_ACTION_PROMPT_PATH,
                    (
                        "Sugira a proxima melhor acao analitica em JSON estrito. "
                        "Apenas tools de leitura/analise sao permitidas."
                    ),
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "analysis": analysis.model_dump(mode="json"),
                        "ranked_candidates": [item.model_dump(mode="json") for item in ranked_candidates],
                        "execution_context": execution_context,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        try:
            parsed, trace = await self.client.responses_structured(
                runtime=self.runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="next_action_suggestion",
                schema_name="next_action_suggestion",
                schema=schema,
                output_model=NextActionSuggestionResult,
            )
            model = NextActionSuggestionResult.model_validate(parsed)
            if model.confidence < self.confidence_threshold:
                self._record_rejected(
                    trace=trace,
                    contribution_type="next_action",
                    summary="Next action suggestion rejected due low confidence.",
                    payload={"confidence": model.confidence},
                    fallback_reason="low_confidence",
                )
                return None
            tool_name = str(model.tool_name or "lens.run_query")
            if not is_openai_tool_suggestion_allowed(tool_name):
                self._record_rejected(
                    trace=trace,
                    contribution_type="next_action",
                    summary="Next action suggestion rejected by tool allowlist guardrail.",
                    payload={"tool_name": tool_name},
                    fallback_reason="tool_not_allowed",
                )
                return None
            if not model.candidate_id:
                self._record_rejected(
                    trace=trace,
                    contribution_type="next_action",
                    summary="Next action suggestion rejected due missing candidate_id.",
                    payload={},
                    fallback_reason="missing_candidate_id",
                )
                return None
            suggestion = AdapterNextActionSuggestion(
                candidate_id=model.candidate_id,
                reason=model.reason,
                tool_name=tool_name,
                arguments=model.arguments,
                hypothesis_to_test=model.hypothesis_to_test,
                confidence=model.confidence,
                metadata={},
            )
            self._record_accepted(
                trace=trace,
                contribution_type="next_action",
                summary="Next action suggestion accepted from OpenAI.",
                payload={"candidate_id": model.candidate_id, "tool_name": tool_name, "confidence": model.confidence},
            )
            return suggestion
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            self._record_exception(
                task="next_action_suggestion",
                trace_id=trace_id,
                contribution_type="next_action",
                summary="Next action suggestion fallback to heuristic.",
                exc=exc,
            )
            return None

    def consume_reasoning_contributions(self) -> list[BiReasoningAdapterContribution]:
        items = list(self._contributions)
        self._contributions.clear()
        return items

    def consume_openai_trace_events(self) -> list[OpenAITraceMetadata]:
        items = list(self._trace_events)
        self._trace_events.clear()
        return items

    def _record_accepted(
        self,
        *,
        trace: OpenAITraceMetadata,
        contribution_type: str,
        summary: str,
        payload: dict[str, Any],
    ) -> None:
        self._trace_events.append(trace.model_copy(update={"accepted": True, "used_fallback": False, "fallback_reason": None}))
        self._contributions.append(
            BiReasoningAdapterContribution(
                contribution_type=contribution_type,  # type: ignore[arg-type]
                applied=True,
                summary=summary,
                payload=payload,
            )
        )

    def _record_rejected(
        self,
        *,
        trace: OpenAITraceMetadata,
        contribution_type: str,
        summary: str,
        payload: dict[str, Any],
        fallback_reason: str,
    ) -> None:
        self._trace_events.append(
            trace.model_copy(
                update={
                    "accepted": False,
                    "used_fallback": True,
                    "fallback_reason": fallback_reason,
                }
            )
        )
        self._contributions.append(
            BiReasoningAdapterContribution(
                contribution_type=contribution_type,  # type: ignore[arg-type]
                applied=False,
                summary=summary,
                payload={**payload, "fallback_reason": fallback_reason},
            )
        )

    def _record_exception(
        self,
        *,
        task: str,
        trace_id: str,
        contribution_type: str,
        summary: str,
        exc: Exception,
    ) -> None:
        self._trace_events.append(
            OpenAITraceMetadata(
                call_id=f"error-{task}-{trace_id}"[:120],
                lens_trace_id=trace_id,
                task=task,
                model=self.runtime.model,
                schema_name=task,
                success=False,
                accepted=False,
                used_fallback=True,
                fallback_reason="openai_error",
                error_code=getattr(exc, "code", "openai_adapter_error"),
                error_message=str(exc),
                metadata={"integration_id": self.runtime.integration_id},
            )
        )
        self._contributions.append(
            BiReasoningAdapterContribution(
                contribution_type=contribution_type,  # type: ignore[arg-type]
                applied=False,
                summary=summary,
                payload={"error": str(exc), "fallback_reason": "openai_error"},
            )
        )
