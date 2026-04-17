from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from sqlalchemy.orm import Session

from app.modules.bi_agent.agent.confidence_style import ConfidenceStyle, build_confidence_style
from app.modules.bi_agent.agent.followups import build_ambiguity_questions, build_followup_questions
from app.modules.bi_agent.agent.semantic_normalization import (
    SemanticLabelIndex,
    build_semantic_label_index,
    resolve_field_label,
    resolve_metric_label,
)
from app.modules.bi_agent.schemas import (
    BiAgentAmbiguityItem,
    BiAgentQueryEvidence,
    BiFinalAnswerSynthesis,
    BiInterpretedAnswer,
    BiResponseStatus,
)
from app.modules.openai_adapter.client import (
    OpenAIAdapterClient,
    OpenAIRuntimeConfig,
    get_openai_adapter_client,
    resolve_active_openai_runtime,
)
from app.modules.openai_adapter.errors import OpenAIAdapterError, OpenAIAdapterSchemaError
from app.modules.openai_adapter.schemas import OpenAITraceMetadata

_M_TOKEN_PATTERN = re.compile(r"\bm\d+\b", flags=re.IGNORECASE)
_TECHNICAL_JARGON_PATTERN = re.compile(
    r"\b(trace_id|schema|validation_errors?|tool_calls?|json cru|payload tecnico)\b",
    flags=re.IGNORECASE,
)
FINAL_ANSWER_SYNTHESIS_SCHEMA_NAME = "bi_final_answer_synthesis"
FINAL_ANSWER_SYNTHESIS_SCHEMA_VERSION = "v1"
FINAL_ANSWER_SYNTHESIS_PROMPT_VERSION = "v2"
FINAL_ANSWER_SYNTHESIS_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompts" / "assistant_lens" / "bi_agent_final_answer_synthesis_system.txt"


@lru_cache(maxsize=2)
def _load_final_answer_system_prompt() -> str:
    fallback = (
        "Voce sintetiza a resposta final de um BI Agent para usuario final de negocio. "
        "Priorize resposta direta e linguagem natural em portugues, sem jargao tecnico. "
        "Quando existir interpreted_result, use-o como base principal para a resposta. "
        "Nunca invente metricas, dimensoes, valores ou causalidade. "
        "Respeite ambiguidades, confianca e limitacoes antes de afirmar conclusoes. "
        "Nao use termos tecnicos internos como trace_id, schema ou validation_errors no texto final. "
        "Nao exponha aliases opacos (m0, m1, etc.) no texto final. "
        "Retorne apenas JSON valido no schema informado."
    )
    try:
        loaded = FINAL_ANSWER_SYNTHESIS_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return fallback
    return loaded or fallback


@dataclass
class FinalAnswerSynthesisResult:
    payload: BiFinalAnswerSynthesis
    trace: OpenAITraceMetadata
    fallback_used: bool
    fallback_reason: str | None = None


class BIFinalAnswerSynthesizer:
    def __init__(
        self,
        *,
        client: OpenAIAdapterClient | None = None,
        runtime_resolver: Callable[[Session], OpenAIRuntimeConfig | None] = resolve_active_openai_runtime,
    ) -> None:
        self.client = client or get_openai_adapter_client()
        self.runtime_resolver = runtime_resolver

    async def synthesize(
        self,
        *,
        db: Session,
        trace_id: str,
        question: str,
        answer: str,
        executive_summary: str | None,
        key_findings: list[str],
        limitations: list[str],
        ambiguities: list[BiAgentAmbiguityItem],
        answer_confidence: float,
        assumptions: list[str],
        evidence: list[dict[str, Any]],
        next_best_actions: list[str],
        intent: str,
        response_status_hint: BiResponseStatus,
        queries_executed: list[BiAgentQueryEvidence],
        interpreted_answer: BiInterpretedAnswer | None = None,
        catalog: dict[str, Any] | None = None,
        schema: dict[str, Any] | None = None,
        semantic_layer: dict[str, Any] | None = None,
    ) -> FinalAnswerSynthesisResult:
        label_index = build_semantic_label_index(catalog=catalog, schema=schema, semantic_layer=semantic_layer)
        alias_map, alias_gaps = self._extract_alias_map(queries_executed=queries_executed, label_index=label_index)
        confidence_style = build_confidence_style(confidence=answer_confidence, response_status=response_status_hint)
        ambiguity_questions = build_ambiguity_questions(ambiguities=ambiguities, intent=intent)
        fallback_payload = self._build_fallback(
            question=question,
            answer=answer,
            executive_summary=executive_summary,
            key_findings=key_findings,
            limitations=limitations,
            ambiguities=ambiguities,
            assumptions=assumptions,
            next_best_actions=next_best_actions,
            response_status=response_status_hint,
            alias_map=alias_map,
            alias_gaps=alias_gaps,
            intent=intent,
            ambiguity_questions=ambiguity_questions,
            confidence_style=confidence_style,
            interpreted_answer=interpreted_answer,
        )

        runtime = self.runtime_resolver(db)
        if runtime is None:
            return FinalAnswerSynthesisResult(
                payload=fallback_payload,
                trace=self._fallback_trace(
                    trace_id=trace_id,
                    model="local-fallback",
                    fallback_reason="no_active_openai_runtime",
                    error_code="openai_runtime_missing",
                    error_message="No active OpenAI integration",
                ),
                fallback_used=True,
                fallback_reason="no_active_openai_runtime",
            )

        synthesis_payload = self._build_synthesis_payload(
            question=question,
            answer=answer,
            executive_summary=executive_summary,
            key_findings=key_findings,
            limitations=limitations,
            ambiguities=ambiguities,
            assumptions=assumptions,
            answer_confidence=answer_confidence,
            evidence=evidence,
            next_best_actions=next_best_actions,
            intent=intent,
            response_status_hint=response_status_hint,
            alias_map=alias_map,
            alias_gaps=alias_gaps,
            queries_executed=queries_executed,
            ambiguity_questions=ambiguity_questions,
            confidence_style=confidence_style,
            interpreted_answer=interpreted_answer,
        )

        synthesis_schema = {
            "name": FINAL_ANSWER_SYNTHESIS_SCHEMA_NAME,
            "strict": True,
            "schema": BiFinalAnswerSynthesis.model_json_schema(),
        }
        input_payload = [
            {
                "role": "system",
                "content": _load_final_answer_system_prompt(),
            },
            {
                "role": "user",
                "content": json.dumps(synthesis_payload, ensure_ascii=False),
            },
        ]

        try:
            parsed, trace = await self.client.responses_structured(
                runtime=runtime,
                input_payload=input_payload,
                lens_trace_id=trace_id,
                task="final_answer_synthesis",
                schema_name=FINAL_ANSWER_SYNTHESIS_SCHEMA_NAME,
                schema=synthesis_schema,
                output_model=BiFinalAnswerSynthesis,
            )
            trace = self._augment_trace_metadata(
                trace=trace,
                metadata={
                    "prompt_version": FINAL_ANSWER_SYNTHESIS_PROMPT_VERSION,
                    "schema_version": FINAL_ANSWER_SYNTHESIS_SCHEMA_VERSION,
                    "response_status_hint": response_status_hint,
                    "intent": intent,
                },
            )
            synthesized = BiFinalAnswerSynthesis.model_validate(parsed)
            consistency_error = self._validate_consistency(
                synthesized=synthesized,
                answer_confidence=answer_confidence,
                ambiguities=ambiguities,
            )
            if consistency_error is not None:
                rejected_trace = self._augment_trace_metadata(
                    trace=trace.model_copy(
                        update={
                            "accepted": False,
                            "used_fallback": True,
                            "fallback_reason": consistency_error,
                        }
                    ),
                    metadata={"consistency_error": consistency_error},
                )
                return FinalAnswerSynthesisResult(
                    payload=fallback_payload,
                    trace=rejected_trace,
                    fallback_used=True,
                    fallback_reason=consistency_error,
                )
            return FinalAnswerSynthesisResult(
                payload=synthesized,
                trace=trace,
                fallback_used=False,
                fallback_reason=None,
            )
        except (OpenAIAdapterError, OpenAIAdapterSchemaError) as exc:
            return FinalAnswerSynthesisResult(
                payload=fallback_payload,
                trace=self._fallback_trace(
                    trace_id=trace_id,
                    model=runtime.model,
                    fallback_reason="openai_synthesis_error",
                    error_code=getattr(exc, "code", "openai_adapter_error"),
                    error_message=str(exc),
                    integration_id=runtime.integration_id,
                ),
                fallback_used=True,
                fallback_reason="openai_synthesis_error",
            )

    def _build_synthesis_payload(
        self,
        *,
        question: str,
        answer: str,
        executive_summary: str | None,
        key_findings: list[str],
        limitations: list[str],
        ambiguities: list[BiAgentAmbiguityItem],
        assumptions: list[str],
        answer_confidence: float,
        evidence: list[dict[str, Any]],
        next_best_actions: list[str],
        intent: str,
        response_status_hint: BiResponseStatus,
        alias_map: dict[str, str],
        alias_gaps: list[str],
        queries_executed: list[BiAgentQueryEvidence],
        ambiguity_questions: list[str],
        confidence_style: ConfidenceStyle,
        interpreted_answer: BiInterpretedAnswer | None,
    ) -> dict[str, Any]:
        enriched_limitations = list(limitations)
        if alias_gaps:
            enriched_limitations.append(
                "Nem todos os aliases tecnicos (ex.: m0/m1) puderam ser traduzidos com seguranca."
            )

        return {
            "question": question,
            "technical_answer": self._sanitize_text(answer, alias_map=alias_map),
            "executive_summary": self._sanitize_text(executive_summary or "", alias_map=alias_map),
            "key_findings": [self._sanitize_text(item, alias_map=alias_map) for item in key_findings],
            "limitations": [self._sanitize_text(item, alias_map=alias_map) for item in enriched_limitations],
            "ambiguities": [
                {
                    "code": item.code,
                    "description": self._sanitize_text(item.description, alias_map=alias_map),
                    "alternatives": [self._sanitize_text(alt, alias_map=alias_map) for alt in item.alternatives],
                    "suggested_refinement": self._sanitize_text(item.suggested_refinement or "", alias_map=alias_map),
                }
                for item in ambiguities
            ],
            "assumptions": [self._sanitize_text(item, alias_map=alias_map) for item in assumptions],
            "answer_confidence": round(float(answer_confidence), 4),
            "next_best_actions": [self._sanitize_text(item, alias_map=alias_map) for item in next_best_actions],
            "suggested_followup_questions": ambiguity_questions,
            "intent": intent,
            "response_status_hint": response_status_hint,
            "interpreted_result": interpreted_answer.model_dump(mode="json") if interpreted_answer is not None else None,
            "conversation_policy": {
                "audience": "business_user",
                "style": "clear_direct_conversational",
                "confidence_band": confidence_style.band,
                "tone_hint": confidence_style.tone_hint,
                "avoid_technical_terms": ["m0", "m1", "score tecnico", "schema"],
            },
            "evidence": evidence[:12],
            "queries_executed": [
                {
                    "candidate_id": item.candidate_id,
                    "candidate_title": item.candidate_title,
                    "row_count": item.row_count,
                    "columns": [alias_map.get(column, column) for column in item.columns],
                    "rows_preview": [
                        {
                            alias_map.get(key, key): value
                            for key, value in row.items()
                        }
                        for row in item.rows_preview[:3]
                    ],
                }
                for item in queries_executed[:8]
            ],
            "alias_map": alias_map,
            "alias_gaps": alias_gaps,
        }

    def _build_fallback(
        self,
        *,
        question: str,
        answer: str,
        executive_summary: str | None,
        key_findings: list[str],
        limitations: list[str],
        ambiguities: list[BiAgentAmbiguityItem],
        assumptions: list[str],
        next_best_actions: list[str],
        response_status: BiResponseStatus,
        alias_map: dict[str, str],
        alias_gaps: list[str],
        intent: str,
        ambiguity_questions: list[str],
        confidence_style: ConfidenceStyle,
        interpreted_answer: BiInterpretedAnswer | None,
    ) -> BiFinalAnswerSynthesis:
        _ = question
        safe_answer = self._sanitize_text(answer, alias_map=alias_map)
        safe_summary = self._sanitize_text(executive_summary or "", alias_map=alias_map)
        safe_findings = [self._sanitize_text(item, alias_map=alias_map) for item in key_findings[:4]]
        safe_limitations = [self._sanitize_text(item, alias_map=alias_map) for item in limitations]

        if alias_gaps:
            safe_limitations.append("Algumas metricas tecnicas (m0/m1) nao puderam ser nomeadas com seguranca.")

        interpreted_direct = self._sanitize_text(interpreted_answer.direct_answer or "", alias_map=alias_map) if interpreted_answer else ""
        if response_status == "answered":
            primary_candidate = interpreted_direct or safe_summary or safe_answer
            short_message = primary_candidate or "Consegui responder sua pergunta com base nas evidencias disponiveis."
            why_not = None
        elif response_status == "needs_clarification":
            short_message = "Consegui um sinal inicial, mas preciso de um refinamento para responder com precisao."
            why_not = safe_limitations[0] if safe_limitations else "A pergunta permite mais de uma interpretacao valida."
        else:
            short_message = "Ainda nao encontrei evidencia suficiente para responder com seguranca."
            why_not = safe_limitations[0] if safe_limitations else "As evidencias coletadas foram insuficientes para conclusao segura."

        fallback_followups = build_followup_questions(
            intent=intent,
            response_status=response_status,
            question_analysis=None,
            ambiguities=ambiguities,
            next_best_actions=next_best_actions,
        )
        clarifying_questions = self._dedupe([*ambiguity_questions, *fallback_followups])

        recommended_next_step = next_best_actions[0] if next_best_actions else None
        confidence_explanation = confidence_style.confidence_explanation
        direct_answer = safe_answer if response_status == "answered" else None
        if direct_answer and short_message and direct_answer.strip().lower() == short_message.strip().lower():
            direct_answer = None

        return BiFinalAnswerSynthesis(
            response_status=response_status,
            short_chat_message=short_message,
            direct_answer=direct_answer,
            why_not_fully_answered=why_not,
            assumptions_used=assumptions[:4],
            clarifying_questions=self._dedupe([self._as_question(item) for item in clarifying_questions])[:4],
            recommended_next_step=recommended_next_step,
            confidence_explanation=confidence_explanation,
            user_friendly_findings=self._dedupe(safe_findings)[:2],
        )

    def _extract_alias_map(
        self,
        *,
        queries_executed: list[BiAgentQueryEvidence],
        label_index: SemanticLabelIndex,
    ) -> tuple[dict[str, str], list[str]]:
        alias_map: dict[str, str] = {}
        unresolved_aliases: set[str] = set()

        for query in queries_executed:
            metrics = []
            if isinstance(query.query_spec, dict):
                raw_metrics = query.query_spec.get("metrics")
                if isinstance(raw_metrics, list):
                    metrics = raw_metrics

            for index, metric in enumerate(metrics):
                if not isinstance(metric, dict):
                    continue
                raw_alias = metric.get("alias")
                alias = str(raw_alias).strip() if isinstance(raw_alias, str) and raw_alias.strip() else f"m{index}"
                raw_field = metric.get("field")
                raw_agg = metric.get("agg")
                field = str(raw_field).strip() if isinstance(raw_field, str) else "metrica"
                agg = str(raw_agg).strip() if isinstance(raw_agg, str) else "valor"
                alias_map[alias] = resolve_metric_label(index=label_index, field_name=field, agg=agg)

            for row in query.rows_preview[:3]:
                if not isinstance(row, dict):
                    continue
                for key in row.keys():
                    if not isinstance(key, str):
                        continue
                    if _M_TOKEN_PATTERN.fullmatch(key) and key not in alias_map:
                        unresolved_aliases.add(key)
                    elif key not in alias_map:
                        alias_map[key] = resolve_field_label(label_index, key)

        return alias_map, sorted(unresolved_aliases)

    def _validate_consistency(
        self,
        *,
        synthesized: BiFinalAnswerSynthesis,
        answer_confidence: float,
        ambiguities: list[BiAgentAmbiguityItem],
    ) -> str | None:
        if synthesized.response_status == "answered" and float(answer_confidence) < 0.35:
            return "answered_with_low_confidence"

        if synthesized.response_status == "answered" and not (synthesized.direct_answer or synthesized.short_chat_message):
            return "missing_direct_answer"

        if synthesized.response_status != "answered" and not synthesized.why_not_fully_answered:
            return "missing_why_not_answered"

        if (
            len(ambiguities) > 0
            and synthesized.response_status == "answered"
            and len(synthesized.clarifying_questions) == 0
            and (len(ambiguities) > 1 or float(answer_confidence) < 0.5)
        ):
            return "hidden_critical_ambiguity"

        if synthesized.response_status == "needs_clarification" and len(synthesized.clarifying_questions) == 0:
            return "missing_clarifying_questions"

        if synthesized.response_status == "insufficient_evidence" and synthesized.direct_answer:
            return "insufficient_evidence_with_direct_answer"

        if synthesized.response_status == "needs_clarification" and not synthesized.why_not_fully_answered:
            return "needs_clarification_without_reason"

        if (
            synthesized.direct_answer
            and synthesized.short_chat_message
            and synthesized.direct_answer.strip().lower() == synthesized.short_chat_message.strip().lower()
        ):
            return "duplicated_primary_and_direct_answer"

        chat_texts = [
            synthesized.short_chat_message,
            synthesized.direct_answer or "",
            synthesized.why_not_fully_answered or "",
            synthesized.recommended_next_step or "",
            *synthesized.clarifying_questions,
        ]
        if any(_TECHNICAL_JARGON_PATTERN.search(text or "") for text in chat_texts):
            return "technical_jargon_leaked"

        texts_to_check = [
            synthesized.short_chat_message,
            synthesized.direct_answer or "",
            synthesized.why_not_fully_answered or "",
            *synthesized.user_friendly_findings,
        ]
        if any(_M_TOKEN_PATTERN.search(text or "") for text in texts_to_check):
            return "opaque_metric_alias_leaked"

        return None

    def _augment_trace_metadata(self, *, trace: OpenAITraceMetadata, metadata: dict[str, Any]) -> OpenAITraceMetadata:
        current = dict(trace.metadata or {})
        current.update(metadata)
        return trace.model_copy(update={"metadata": current})

    def _sanitize_text(self, value: str, *, alias_map: dict[str, str]) -> str:
        text = str(value or "").strip()
        if not text:
            return ""

        def _replace(match: re.Match[str]) -> str:
            token = match.group(0)
            return alias_map.get(token, "metrica agregada")

        sanitized = _M_TOKEN_PATTERN.sub(_replace, text)
        return re.sub(r"\s+", " ", sanitized).strip()

    def _as_question(self, value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if text.endswith("?"):
            return text
        return f"{text}?"

    def _dedupe(self, items: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for item in items:
            normalized = str(item or "").strip()
            if not normalized:
                continue
            key = normalized.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(normalized)
        return out

    def _fallback_trace(
        self,
        *,
        trace_id: str,
        model: str,
        fallback_reason: str,
        error_code: str,
        error_message: str,
        integration_id: int | None = None,
    ) -> OpenAITraceMetadata:
        metadata: dict[str, Any] = {}
        if integration_id is not None:
            metadata["integration_id"] = integration_id
        metadata["prompt_version"] = FINAL_ANSWER_SYNTHESIS_PROMPT_VERSION
        metadata["schema_version"] = FINAL_ANSWER_SYNTHESIS_SCHEMA_VERSION
        return OpenAITraceMetadata(
            call_id=uuid4().hex,
            lens_trace_id=trace_id,
            task="final_answer_synthesis",
            model=model,
            schema_name=FINAL_ANSWER_SYNTHESIS_SCHEMA_NAME,
            success=False,
            accepted=False,
            used_fallback=True,
            fallback_reason=fallback_reason,
            error_code=error_code,
            error_message=error_message,
            metadata=metadata,
        )
