from __future__ import annotations

import asyncio

import pytest

from app.modules.bi_agent.agent.openai_reasoning_adapter import OpenAIReasoningAdapter
from app.modules.bi_agent.schemas import BiNextQueryCandidate, BiQuestionAnalysis
from app.modules.openai_adapter.client import OpenAIAdapterClient, OpenAIRuntimeConfig
from app.modules.openai_adapter.errors import OpenAIAdapterSchemaError
from app.modules.openai_adapter.schemas import IntentClassificationResult, OpenAITraceMetadata
from app.modules.openai_adapter.tooling import is_openai_tool_suggestion_allowed, list_openai_compatible_read_tools


def _runtime() -> OpenAIRuntimeConfig:
    return OpenAIRuntimeConfig(api_key="sk-test", model="gpt-4o-mini", integration_id=1)


def _trace(*, task: str, trace_id: str = "trace-test") -> OpenAITraceMetadata:
    return OpenAITraceMetadata(
        call_id="call-test",
        lens_trace_id=trace_id,
        task=task,
        model="gpt-4o-mini",
        schema_name=task,
    )


def test_openai_adapter_structured_output_parsing(monkeypatch) -> None:
    client = OpenAIAdapterClient()

    async def _fake_responses_request(**kwargs):  # noqa: ANN003
        _ = kwargs
        return (
            {"output_text": '{"intent":"kpi_summary","confidence":0.91,"rationale":"ok"}'},
            _trace(task="intent_classification"),
        )

    monkeypatch.setattr(client, "responses_request", _fake_responses_request)

    parsed, trace = asyncio.run(
        client.responses_structured(
            runtime=_runtime(),
            input_payload=[{"role": "user", "content": "test"}],
            lens_trace_id="trace-test",
            task="intent_classification",
            schema_name="intent_classification",
            schema={
                "name": "intent_classification",
                "strict": True,
                "schema": IntentClassificationResult.model_json_schema(),
            },
            output_model=IntentClassificationResult,
        )
    )

    assert parsed["intent"] == "kpi_summary"
    assert trace.task == "intent_classification"


def test_openai_adapter_structured_output_schema_error(monkeypatch) -> None:
    client = OpenAIAdapterClient()

    async def _fake_responses_request(**kwargs):  # noqa: ANN003
        _ = kwargs
        return ({"output_text": '{"intent":"kpi_summary"}'}, _trace(task="intent_classification"))

    monkeypatch.setattr(client, "responses_request", _fake_responses_request)

    with pytest.raises(OpenAIAdapterSchemaError):
        asyncio.run(
            client.responses_structured(
                runtime=_runtime(),
                input_payload=[{"role": "user", "content": "test"}],
                lens_trace_id="trace-test",
                task="intent_classification",
                schema_name="intent_classification",
                schema={
                    "name": "intent_classification",
                    "strict": True,
                    "schema": IntentClassificationResult.model_json_schema(),
                },
                output_model=IntentClassificationResult,
            )
        )


def test_openai_reasoning_next_action_rejected_by_guardrail() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "candidate_id": "cand_overview",
                    "tool_name": "lens.add_dashboard_widget",
                    "arguments": {"dashboard_id": 1},
                    "hypothesis_to_test": "invalid",
                    "reason": "try mutable tool",
                    "confidence": 0.93,
                },
                _trace(task="next_action_suggestion", trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    adapter = OpenAIReasoningAdapter(runtime=_runtime(), client=StubClient(), confidence_threshold=0.5)
    analysis = BiQuestionAnalysis(intent="diagnostic_analysis")
    candidates = [
        BiNextQueryCandidate(
            candidate_id="cand_overview",
            title="Overview",
            score=0.9,
            reason="top",
        )
    ]

    suggestion = asyncio.run(
        adapter.suggest_next_candidate(
            analysis=analysis,
            ranked_candidates=candidates,
            execution_context={"iteration": 1},
            trace_id="trace-guardrail",
        )
    )

    assert suggestion is None
    contributions = adapter.consume_reasoning_contributions()
    traces = adapter.consume_openai_trace_events()
    assert any(item.contribution_type == "next_action" and item.applied is False for item in contributions)
    assert any(item.lens_trace_id == "trace-guardrail" and item.used_fallback is True for item in traces)


def test_openai_reasoning_next_action_accepted() -> None:
    class StubClient:
        async def responses_structured(self, **kwargs):  # noqa: ANN003
            return (
                {
                    "candidate_id": "cand_overview",
                    "tool_name": "lens.run_query",
                    "arguments": {"limit": 25},
                    "hypothesis_to_test": "overview_signal",
                    "reason": "best first query",
                    "confidence": 0.88,
                },
                _trace(task="next_action_suggestion", trace_id=kwargs.get("lens_trace_id", "trace-test")),
            )

    adapter = OpenAIReasoningAdapter(runtime=_runtime(), client=StubClient(), confidence_threshold=0.5)
    analysis = BiQuestionAnalysis(intent="kpi_summary")
    candidates = [
        BiNextQueryCandidate(
            candidate_id="cand_overview",
            title="Overview",
            score=0.85,
            reason="top",
        )
    ]

    suggestion = asyncio.run(
        adapter.suggest_next_candidate(
            analysis=analysis,
            ranked_candidates=candidates,
            execution_context={"iteration": 1},
            trace_id="trace-accept",
        )
    )

    assert suggestion is not None
    assert suggestion.candidate_id == "cand_overview"
    assert suggestion.tool_name == "lens.run_query"
    contributions = adapter.consume_reasoning_contributions()
    traces = adapter.consume_openai_trace_events()
    assert any(item.contribution_type == "next_action" and item.applied is True for item in contributions)
    assert any(item.lens_trace_id == "trace-accept" and item.accepted is True for item in traces)


def test_openai_tooling_allowlist_is_read_only() -> None:
    assert is_openai_tool_suggestion_allowed("lens.run_query") is True
    assert is_openai_tool_suggestion_allowed("lens.add_dashboard_widget") is False
    mapped = list_openai_compatible_read_tools()
    names = {item["name"] for item in mapped}
    assert "lens.run_query" in names
    assert "lens.add_dashboard_widget" not in names
