from __future__ import annotations

import asyncio

from app.modules.bi_agent.answer_synthesis import BIFinalAnswerSynthesizer
from app.modules.bi_agent.schemas import (
    BiAgentAmbiguityItem,
    BiAgentQueryEvidence,
)
from app.modules.openai_adapter.client import OpenAIRuntimeConfig
from app.modules.openai_adapter.errors import OpenAIAdapterError, OpenAIAdapterSchemaError
from app.modules.openai_adapter.schemas import OpenAITraceMetadata


def _runtime() -> OpenAIRuntimeConfig:
    return OpenAIRuntimeConfig(api_key="sk-test", model="gpt-4o-mini", integration_id=99)


def _trace(*, trace_id: str = "trace-test") -> OpenAITraceMetadata:
    return OpenAITraceMetadata(
        call_id="call-test",
        lens_trace_id=trace_id,
        task="final_answer_synthesis",
        model="gpt-4o-mini",
        schema_name="bi_final_answer_synthesis",
    )


def _base_kwargs() -> dict:
    return {
        "db": None,
        "trace_id": "trace-test",
        "question": "Quais dimensoes explicam a queda da receita?",
        "answer": "A queda foi maior no canal X.",
        "executive_summary": "Canal X concentrou a queda.",
        "key_findings": ["Canal X contribuiu com maior variacao negativa."],
        "limitations": [],
        "ambiguities": [],
        "answer_confidence": 0.82,
        "assumptions": ["Receita_total foi tratada como metrica principal."],
        "evidence": [],
        "next_best_actions": ["Analisar por periodo mensal."],
        "intent": "diagnostic_analysis",
        "response_status_hint": "answered",
        "queries_executed": [],
    }


def test_answer_synthesis_answered_success() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "response_status": "answered",
                    "short_chat_message": "A queda de receita veio principalmente do canal X.",
                    "direct_answer": "Canal X foi o principal driver da queda.",
                    "why_not_fully_answered": None,
                    "assumptions_used": ["Receita_total como metrica principal."],
                    "clarifying_questions": [],
                    "recommended_next_step": "Comparar canal X por periodo mensal.",
                    "confidence_explanation": "Confianca alta por cobertura temporal e dimensional.",
                    "user_friendly_findings": ["Canal X concentrou a maior perda relativa."],
                },
                _trace(trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(synthesizer.synthesize(**_base_kwargs()))
    assert result.fallback_used is False
    assert result.payload.response_status == "answered"
    assert "canal x" in result.payload.short_chat_message.lower()
    assert result.trace.metadata.get("prompt_version") == "v2"
    assert result.trace.metadata.get("schema_version") == "v1"


def test_answer_synthesis_needs_clarification() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "response_status": "needs_clarification",
                    "short_chat_message": "Sua pergunta tem ambiguidade de metrica.",
                    "direct_answer": None,
                    "why_not_fully_answered": "Nao ficou claro se a metrica alvo e receita ou margem.",
                    "assumptions_used": ["Assumi receita_total para avancar."],
                    "clarifying_questions": ["Qual metrica voce quer analisar?"],
                    "recommended_next_step": "Definir metrica alvo.",
                    "confidence_explanation": "Confianca moderada pela ambiguidade.",
                    "user_friendly_findings": ["Existe queda em pelo menos um segmento."],
                },
                _trace(trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            ambiguities=[
                BiAgentAmbiguityItem(
                    code="ambiguous_metric",
                    description="Nao ficou claro qual metrica analisar",
                    alternatives=["receita", "margem"],
                    suggested_refinement="Qual metrica voce quer analisar",
                )
            ],
            response_status_hint="needs_clarification",
        )
    )
    assert result.fallback_used is False
    assert result.payload.response_status == "needs_clarification"
    assert len(result.payload.clarifying_questions) >= 1


def test_answer_synthesis_accepts_answered_with_single_non_critical_ambiguity() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "response_status": "answered",
                    "short_chat_message": "Os principais sinais apontam queda no canal X.",
                    "direct_answer": "Canal X lidera a queda observada.",
                    "why_not_fully_answered": None,
                    "assumptions_used": ["Receita como metrica principal"],
                    "clarifying_questions": [],
                    "recommended_next_step": "Detalhar por periodo mensal.",
                    "confidence_explanation": "Resposta consistente com os cortes executados.",
                    "user_friendly_findings": ["Canal X apresentou maior contribuicao negativa."],
                },
                _trace(trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            ambiguities=[
                BiAgentAmbiguityItem(
                    code="missing_metric_reference",
                    description="Metrica nao explicita",
                    alternatives=["receita_total", "margem"],
                    suggested_refinement="Qual metrica devo priorizar",
                )
            ],
            answer_confidence=0.78,
            response_status_hint="answered",
        )
    )
    assert result.fallback_used is False
    assert result.payload.response_status == "answered"


def test_answer_synthesis_insufficient_evidence() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "response_status": "insufficient_evidence",
                    "short_chat_message": "Ainda nao existe evidencia suficiente para concluir com seguranca.",
                    "direct_answer": None,
                    "why_not_fully_answered": "As consultas retornaram sinal insuficiente.",
                    "assumptions_used": [],
                    "clarifying_questions": ["Qual periodo voce quer analisar?"],
                    "recommended_next_step": "Executar corte temporal adicional.",
                    "confidence_explanation": "Confianca baixa por cobertura incompleta.",
                    "user_friendly_findings": ["Sem sinal consistente na amostra atual."],
                },
                _trace(trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            answer="",
            answer_confidence=0.21,
            response_status_hint="insufficient_evidence",
        )
    )
    assert result.fallback_used is False
    assert result.payload.response_status == "insufficient_evidence"


def test_answer_synthesis_fallback_on_openai_error() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterError("OpenAI indisponivel", code="openai_unavailable")

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(synthesizer.synthesize(**_base_kwargs()))
    assert result.fallback_used is True
    assert result.trace.used_fallback is True
    assert result.payload.short_chat_message != ""
    assert "schema" not in (result.payload.confidence_explanation or "").lower()


def test_answer_synthesis_fallback_on_schema_error() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterSchemaError("Schema invalido")

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(synthesizer.synthesize(**_base_kwargs()))
    assert result.fallback_used is True
    assert result.trace.fallback_reason == "openai_synthesis_error"
    assert result.trace.metadata.get("prompt_version") == "v2"
    assert result.trace.metadata.get("schema_version") == "v1"


def test_answer_synthesis_handles_missing_alias_for_m_tokens() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterError("Force fallback", code="forced_fallback")

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            key_findings=["Visao agregada: m0=82.98"],
            response_status_hint="insufficient_evidence",
            answer_confidence=0.2,
            queries_executed=[
                BiAgentQueryEvidence(
                    candidate_id="cand_overview",
                    candidate_title="Overview",
                    query_spec={},
                    row_count=1,
                    columns=["m0"],
                    rows_preview=[{"m0": 82.98}],
                )
            ],
        )
    )
    assert result.fallback_used is True
    assert all("m0" not in item.lower() for item in result.payload.user_friendly_findings)
    assert "metrica" in (result.payload.why_not_fully_answered or "").lower()


def test_answer_synthesis_uses_semantic_label_for_metric_alias() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterError("Force fallback", code="forced_fallback")

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            key_findings=["Visao agregada: m0=82.98"],
            queries_executed=[
                BiAgentQueryEvidence(
                    candidate_id="cand_overview",
                    candidate_title="Overview",
                    query_spec={"metrics": [{"field": "receita_total", "agg": "sum"}]},
                    row_count=1,
                    columns=["m0"],
                    rows_preview=[{"m0": 82.98}],
                )
            ],
            catalog={"metrics": [{"name": "receita_total", "description": "Receita total"}]},
        )
    )
    assert result.fallback_used is True
    assert any("Receita Total".lower() in item.lower() for item in result.payload.user_friendly_findings)


def test_answer_synthesis_rejects_technical_jargon_and_fallbacks() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "response_status": "answered",
                    "short_chat_message": "Resposta pronta. Veja o trace_id e validation_errors para detalhes.",
                    "direct_answer": "Resposta direta com trace_id.",
                    "why_not_fully_answered": None,
                    "assumptions_used": [],
                    "clarifying_questions": [],
                    "recommended_next_step": "Abrir o schema tecnico.",
                    "confidence_explanation": "Confianca alta.",
                    "user_friendly_findings": ["Achado principal."],
                },
                _trace(trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(synthesizer.synthesize(**_base_kwargs()))
    assert result.fallback_used is True
    assert result.fallback_reason == "technical_jargon_leaked"


def test_answer_synthesis_fallback_avoids_duplicate_short_message_and_direct_answer() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterError("Force fallback", code="forced_fallback")

    synthesizer = BIFinalAnswerSynthesizer(client=StubClient(), runtime_resolver=lambda _db: _runtime())
    result = asyncio.run(
        synthesizer.synthesize(
            **_base_kwargs(),
            answer="A estacao mais usada e BYD SAGA 2.",
            executive_summary="A estacao mais usada e BYD SAGA 2.",
            response_status_hint="answered",
        )
    )
    assert result.fallback_used is True
    assert result.payload.short_chat_message != ""
    if result.payload.direct_answer:
        assert result.payload.direct_answer.strip().lower() != result.payload.short_chat_message.strip().lower()
