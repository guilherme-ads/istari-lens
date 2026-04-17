from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from app.modules.bi_agent.answer_synthesis import BIFinalAnswerSynthesizer
from app.modules.bi_agent.agent.adaptive_loop import AdaptiveEvidenceLoop
from app.modules.bi_agent.agent.answerability import decide_answerability
from app.modules.bi_agent.agent.confidence_style import build_confidence_style
from app.modules.bi_agent.agent.conversation_memory import resolve_question_with_memory
from app.modules.bi_agent.agent.critic import BIAgentCritic
from app.modules.bi_agent.agent.evidence_selection import RankedEvidence, rank_query_evidence
from app.modules.bi_agent.agent.executor import BIExecutorState, BIPlanExecutor
from app.modules.bi_agent.agent.followups import build_followup_questions
from app.modules.bi_agent.agent.intents import classify_intent
from app.modules.bi_agent.agent.openai_reasoning_adapter import OpenAIReasoningAdapter
from app.modules.bi_agent.agent.planner import BIExecutionPlan, PlannedToolStep, build_context_steps, build_execution_plan
from app.modules.bi_agent.agent.query_candidates import generate_query_candidates
from app.modules.bi_agent.agent.quality_trace import make_quality_event
from app.modules.bi_agent.agent.question_analysis import analyze_question
from app.modules.bi_agent.agent.reasoning_adapter import DefaultReasoningAdapter, ReasoningAdapter
from app.modules.bi_agent.agent.result_interpreter import interpret_query_results
from app.modules.bi_agent.agent.semantic_normalization import SemanticLabelIndex, build_semantic_label_index, resolve_field_label
from app.modules.bi_agent.schemas import (
    BiAdaptiveDecision,
    BiAgentEvidenceItem,
    BiAgentDashboardDraftResult,
    BiAgentDashboardPlan,
    BiAgentHypothesis,
    BiAgentToolCallItem,
    BiAgentRunRequest,
    BiAgentRunResponse,
    BiAnalysisState,
    BiChatPresentation,
    BiConversationMemory,
    BiEvidenceGap,
    BiFinalAnswerSynthesis,
    BiHumanReviewSummary,
    BiInterpretedAnswer,
    BiNextQueryCandidate,
    BiQueryCandidate,
    BiQuestionAnalysis,
    BiQualityTraceEvent,
    BiReasoningAdapterContribution,
)
from app.modules.core.legacy.models import User
from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.mcp.tool_registry import tool_registry
from app.modules.openai_adapter.client import resolve_active_openai_runtime
from app.modules.openai_adapter.schemas import OpenAITraceMetadata


class BIAgentOrchestrator:
    def __init__(
        self,
        *,
        reasoning_adapter: ReasoningAdapter | None = None,
        answer_synthesizer: BIFinalAnswerSynthesizer | None = None,
    ) -> None:
        self.reasoning_adapter = reasoning_adapter
        self.answer_synthesizer = answer_synthesizer or BIFinalAnswerSynthesizer()

    async def run(
        self,
        *,
        request: BiAgentRunRequest,
        db: Session,
        current_user: User,
    ) -> BiAgentRunResponse:
        question = (request.question or "").strip()
        trace_id = request.trace_id.strip() if isinstance(request.trace_id, str) and request.trace_id.strip() else uuid4().hex
        dry_run = not bool(request.apply_changes)
        conversation_memory = BiConversationMemory(
            applied=False,
            original_question=question,
            resolved_question=question,
        )
        if not question:
            return BiAgentRunResponse(
                success=False,
                error="Question cannot be empty",
                answer="Nao foi possivel executar: pergunta vazia.",
                executive_summary="Pergunta vazia.",
                answer_confidence=0.0,
                dataset_id=int(request.dataset_id),
                intent="exploratory_analysis",
                mode=request.mode,
                dry_run=dry_run,
                validation_errors=[
                    MCPToolValidationError(
                        code="empty_question",
                        field="question",
                        message="Question cannot be empty",
                    )
                ],
                conversation_memory=conversation_memory,
                trace_id=trace_id,
            )

        state = BIExecutorState(
            trace_id=trace_id,
            dataset_id=int(request.dataset_id),
            question=question,
            intent="exploratory_analysis",
            mode=request.mode,
            dry_run=dry_run,
            apply_changes=bool(request.apply_changes),
            dashboard_id=int(request.dashboard_id) if request.dashboard_id is not None else None,
        )
        executor = BIPlanExecutor(max_steps=request.max_steps, max_retries=request.max_retries)
        plans_for_required_check: list[BIExecutionPlan] = []
        reasoning_adapter_contributions: list[BiReasoningAdapterContribution] = []
        openai_trace_events: list[OpenAITraceMetadata] = []
        quality_trace: list[BiQualityTraceEvent] = []

        active_reasoning_adapter = self._resolve_reasoning_adapter(
            request=request,
            db=db,
            warnings_sink=state.warnings,
        )
        self._drain_reasoning_adapter_events(
            adapter=active_reasoning_adapter,
            contributions_sink=reasoning_adapter_contributions,
            trace_sink=openai_trace_events,
        )

        context_plan = BIExecutionPlan(
            intent="context_bootstrap",
            mode=request.mode,
            strategy_name="context_bootstrap",
            selected_candidate_ids=[],
            steps=build_context_steps(dataset_id=request.dataset_id),
        )
        plans_for_required_check.append(context_plan)
        state = await executor.execute(plan=context_plan, state=state, db=db, current_user=current_user)

        conversation_memory = resolve_question_with_memory(
            question=question,
            conversation_history=request.conversation_history,
            catalog=state.context_catalog,
        )
        question_for_analysis = conversation_memory.resolved_question if conversation_memory.applied else question
        quality_trace.append(
            make_quality_event(
                stage="memory",
                decision="applied" if conversation_memory.applied else "not_applied",
                detail="Memoria curta avaliada antes da classificacao de intencao.",
                metadata={
                    "source_turns_count": conversation_memory.source_turns_count,
                    "references_used": conversation_memory.references_used,
                    "inferred_metric": conversation_memory.inferred_metric,
                    "inferred_dimension": conversation_memory.inferred_dimension,
                },
            )
        )

        detected_intent = classify_intent(question_for_analysis)
        if request.enable_reasoning_adapter:
            suggested_intent = await active_reasoning_adapter.classify_intent(
                question=question_for_analysis,
                allowed_intents=[
                    "kpi_summary",
                    "exploratory_analysis",
                    "dashboard_generation",
                    "visualization_help",
                    "diagnostic_analysis",
                    "metric_explanation",
                ],
                trace_id=trace_id,
            )
            self._drain_reasoning_adapter_events(
                adapter=active_reasoning_adapter,
                contributions_sink=reasoning_adapter_contributions,
                trace_sink=openai_trace_events,
            )
            if suggested_intent is not None:
                detected_intent = suggested_intent

        question_analysis = analyze_question(
            question=question_for_analysis,
            semantic_layer=state.context_semantic,
            schema=state.context_schema,
            catalog=state.context_catalog,
            intent_override=detected_intent,
        )
        if request.enable_reasoning_adapter:
            question_analysis = await active_reasoning_adapter.enrich_question_analysis(
                question=question_for_analysis,
                analysis=question_analysis,
                context={
                    "dataset_id": int(request.dataset_id),
                    "semantic_layer": state.context_semantic or {},
                    "schema": state.context_schema or {},
                    "catalog": state.context_catalog or {},
                },
                trace_id=trace_id,
            )
            self._drain_reasoning_adapter_events(
                adapter=active_reasoning_adapter,
                contributions_sink=reasoning_adapter_contributions,
                trace_sink=openai_trace_events,
            )
        question_analysis = await self._apply_semantic_discovery(
            state=state,
            analysis=question_analysis,
            question=question_for_analysis,
            db=db,
            current_user=current_user,
            trace_id=trace_id,
            quality_trace=quality_trace,
        )
        state.question_analysis = question_analysis
        state.intent = question_analysis.intent

        query_candidates = generate_query_candidates(
            question_analysis=question_analysis,
            semantic_layer=state.context_semantic,
            schema=state.context_schema,
            catalog=state.context_catalog,
            max_candidates=8,
        )
        if request.enable_reasoning_adapter:
            reranked_candidates = await active_reasoning_adapter.rerank_query_candidates(
                analysis=question_analysis,
                candidates=query_candidates,
                trace_id=trace_id,
            )
            self._drain_reasoning_adapter_events(
                adapter=active_reasoning_adapter,
                contributions_sink=reasoning_adapter_contributions,
                trace_sink=openai_trace_events,
            )
            changed = [item.candidate_id for item in reranked_candidates] != [item.candidate_id for item in query_candidates]
            reasoning_adapter_contributions.append(
                BiReasoningAdapterContribution(
                    contribution_type="candidate_rerank",
                    applied=changed,
                    summary="Adapter reranked query candidates." if changed else "Adapter reviewed candidate ranking with no changes.",
                    payload={
                        "before": [item.candidate_id for item in query_candidates],
                        "after": [item.candidate_id for item in reranked_candidates],
                    },
                )
            )
            query_candidates = reranked_candidates
        state.query_candidates = query_candidates

        analysis_state: BiAnalysisState | None = None
        hypotheses: list[BiAgentHypothesis] = []
        evidence_gaps: list[BiEvidenceGap] = []
        stopping_reason = "static_plan_completed"
        next_query_candidates: list[BiNextQueryCandidate] = []
        adaptive_decisions: list[BiAdaptiveDecision] = []

        if bool(request.adaptive_mode) and state.intent != "metric_explanation":
            loop = AdaptiveEvidenceLoop(max_evidence_steps=request.max_evidence_steps)
            loop_outcome = await loop.run(
                state=state,
                analysis=question_analysis,
                candidates=query_candidates,
                executor=executor,
                db=db,
                current_user=current_user,
                reasoning_adapter=active_reasoning_adapter,
                enable_reasoning_adapter=bool(request.enable_reasoning_adapter),
                trace_id=trace_id,
            )
            state = loop_outcome.state
            analysis_state = loop_outcome.analysis_state
            hypotheses = loop_outcome.hypotheses
            evidence_gaps = loop_outcome.evidence_gaps
            stopping_reason = loop_outcome.stopping_reason
            next_query_candidates = loop_outcome.next_query_candidates
            adaptive_decisions = loop_outcome.adaptive_decisions
            reasoning_adapter_contributions.extend(loop_outcome.reasoning_adapter_contributions)
            self._drain_reasoning_adapter_events(
                adapter=active_reasoning_adapter,
                contributions_sink=reasoning_adapter_contributions,
                trace_sink=openai_trace_events,
            )

            post_plan = self._build_post_analysis_plan(
                dataset_id=request.dataset_id,
                intent=state.intent,
                mode=request.mode,
                apply_changes=bool(request.apply_changes),
                requires_visualization=question_analysis.requires_visualization,
                requires_dashboard=question_analysis.requires_dashboard,
            )
            if post_plan is not None and len(post_plan.steps) > 0:
                plans_for_required_check.append(post_plan)
                state = await executor.execute(plan=post_plan, state=state, db=db, current_user=current_user)
        else:
            analysis_plan = build_execution_plan(
                dataset_id=request.dataset_id,
                analysis=question_analysis,
                candidates=query_candidates,
                mode=request.mode,
                apply_changes=bool(request.apply_changes),
            )
            analysis_plan.steps = [item for item in analysis_plan.steps if not item.step_id.startswith("context.")]
            plans_for_required_check.append(analysis_plan)
            state = await executor.execute(plan=analysis_plan, state=state, db=db, current_user=current_user)
            stopping_reason = state.halt_reason or "static_plan_completed"
            analysis_state = self._build_static_analysis_state(state=state, stopping_reason=stopping_reason)
            next_query_candidates = self._build_static_next_candidates(state=state, query_candidates=query_candidates)

        dashboard_plan = self._compose_evidence_dashboard_plan(state=state, query_candidates=query_candidates)
        if dashboard_plan is not None:
            state.dashboard_plan_evidence = dashboard_plan

        critic = BIAgentCritic().review(state=state)
        warnings = [*state.warnings, *critic.warnings]
        validation_errors = list(state.validation_errors)
        has_failed_required_call = any(self._has_failed_required_steps(plan=plan, calls=state.tool_calls) for plan in plans_for_required_check)
        success = bool(critic.has_minimum_evidence and not has_failed_required_call and not state.halted)

        label_index = build_semantic_label_index(
            catalog=state.context_catalog,
            schema=state.context_schema,
            semantic_layer=state.context_semantic,
        )
        ranked_evidence = rank_query_evidence(
            analysis=state.question_analysis,
            queries_executed=state.queries_executed,
            query_candidates=state.query_candidates,
            label_index=label_index,
            max_items=5,
        )
        quality_trace.append(
            make_quality_event(
                stage="evidence_selection",
                decision="ranked_query_evidence",
                detail=f"{len(ranked_evidence)} evidencias priorizadas para composicao da resposta.",
                metadata={
                    "top_candidates": [item.query.candidate_id for item in ranked_evidence[:3]],
                    "top_scores": [item.score for item in ranked_evidence[:3]],
                },
            )
        )
        interpreted_answer = interpret_query_results(
            analysis=state.question_analysis,
            ranked_evidence=ranked_evidence,
            queries_executed=state.queries_executed,
            label_index=label_index,
        )
        executive_summary, key_findings, answer = self._compose_analyst_answer(
            state=state,
            critic_confidence=critic.confidence,
            interpreted_answer=interpreted_answer,
            ranked_evidence=ranked_evidence,
            label_index=label_index,
        )
        if not critic.has_minimum_evidence and not interpreted_answer.direct_answer:
            answer = (
                "Evidencia insuficiente para uma conclusao forte. "
                "As hipoteses abaixo devem ser validadas com cortes adicionais."
            )

        limitations = list(dict.fromkeys([*critic.limitations, *self._derive_limitations(state=state)]))
        assumptions = state.question_analysis.assumptions if state.question_analysis else []
        ambiguities = state.question_analysis.ambiguities if state.question_analysis else []

        next_best_actions = list(dict.fromkeys([*critic.next_best_actions, *self._default_next_actions(state=state, request=request)]))
        answerability = decide_answerability(
            success=success,
            confidence=critic.confidence,
            has_minimum_evidence=critic.has_minimum_evidence,
            ambiguity_level=state.question_analysis.ambiguity_level if state.question_analysis else "low",
            ambiguity_count=len(ambiguities),
            should_request_refinement=bool(state.question_analysis.should_request_refinement) if state.question_analysis else False,
            non_empty_query_count=len([item for item in state.queries_executed if item.row_count > 0]),
            validation_errors_count=len(validation_errors),
        )
        response_status_hint = answerability.status
        if (
            response_status_hint == "answered"
            and interpreted_answer.response_status_hint in {"needs_clarification", "insufficient_evidence"}
            and critic.confidence < 0.7
        ):
            response_status_hint = interpreted_answer.response_status_hint
            if interpreted_answer.caveats:
                limitations = list(dict.fromkeys([*limitations, *interpreted_answer.caveats]))
        if response_status_hint != "answered":
            limitations = list(dict.fromkeys([*limitations, *answerability.reasons]))
        quality_trace.append(
            make_quality_event(
                stage="answerability",
                decision=response_status_hint,
                detail="Decisao de status final da resposta antes da sintese conversacional.",
                metadata={
                    "confidence": round(float(critic.confidence), 3),
                    "confidence_band": answerability.confidence_band,
                    "interpreter_status_hint": interpreted_answer.response_status_hint,
                    "ambiguity_level": state.question_analysis.ambiguity_level if state.question_analysis else "low",
                    "ambiguity_count": len(ambiguities),
                    "minimum_evidence_met": answerability.minimum_evidence_met,
                    "reasons": answerability.reasons,
                },
            )
        )

        followup_questions = build_followup_questions(
            intent=state.intent,  # type: ignore[arg-type]
            response_status=response_status_hint,
            question_analysis=state.question_analysis,
            ambiguities=ambiguities,
            next_best_actions=next_best_actions,
        )
        try:
            synthesis_result = await self.answer_synthesizer.synthesize(
                db=db,
                trace_id=trace_id,
                question=question,
                answer=answer,
                executive_summary=executive_summary,
                key_findings=key_findings,
                limitations=limitations,
                ambiguities=ambiguities,
                answer_confidence=critic.confidence,
                assumptions=assumptions,
                evidence=[item.model_dump(mode="json") for item in state.evidence],
                next_best_actions=next_best_actions,
                intent=state.intent,
                response_status_hint=response_status_hint,
                queries_executed=state.queries_executed,
                interpreted_answer=interpreted_answer,
                catalog=state.context_catalog,
                schema=state.context_schema,
                semantic_layer=state.context_semantic,
            )
            openai_trace_events.append(synthesis_result.trace)
            quality_trace.append(
                make_quality_event(
                    stage="synthesis",
                    decision="accepted" if not synthesis_result.fallback_used else "fallback",
                    detail="Sintese final da resposta executada.",
                    metadata={
                        "response_status": synthesis_result.payload.response_status,
                        "fallback_used": synthesis_result.fallback_used,
                        "fallback_reason": synthesis_result.fallback_reason,
                        "model": synthesis_result.trace.model,
                        "schema_name": synthesis_result.trace.schema_name,
                        "trace_call_id": synthesis_result.trace.call_id,
                    },
                )
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            fallback_style = build_confidence_style(confidence=critic.confidence, response_status=response_status_hint)
            fallback_payload = BiFinalAnswerSynthesis(
                response_status=response_status_hint,
                short_chat_message=answer or executive_summary or "Nao foi possivel sintetizar resposta final.",
                direct_answer=answer if response_status_hint == "answered" else None,
                why_not_fully_answered=limitations[0] if response_status_hint != "answered" and limitations else None,
                assumptions_used=assumptions[:4],
                clarifying_questions=followup_questions[:3],
                recommended_next_step=next_best_actions[0] if next_best_actions else None,
                confidence_explanation=fallback_style.confidence_explanation,
                user_friendly_findings=key_findings[:4],
            )
            synthesis_result = SimpleNamespace(
                payload=fallback_payload,
                trace=OpenAITraceMetadata(
                    call_id=uuid4().hex,
                    lens_trace_id=trace_id,
                    task="final_answer_synthesis",
                    model="local-fallback",
                    schema_name="bi_final_answer_synthesis",
                    success=False,
                    accepted=False,
                    used_fallback=True,
                    fallback_reason="unexpected_synthesis_exception",
                    error_code="unexpected_synthesis_exception",
                    error_message=str(exc),
                ),
                fallback_used=True,
            )
            warnings.append("Final answer synthesis failed unexpectedly; local fallback was used.")
            openai_trace_events.append(synthesis_result.trace)
            quality_trace.append(
                make_quality_event(
                    stage="fallback",
                    decision="unexpected_synthesis_exception",
                    detail="Fallback local ativado por excecao inesperada na sintese.",
                    metadata={"error": str(exc)},
                )
            )

        error = None
        if not success:
            failed_call = next((item for item in state.tool_calls if not item.success and not item.skipped), None)
            error = failed_call.error if failed_call else (state.halt_reason or "Agent execution did not reach minimum evidence")

        dashboard_plan_payload = self._to_dashboard_plan(state=state)
        dashboard_draft = self._to_dashboard_draft(state=state, request=request)
        human_review = self._build_human_review_summary(
            state=state,
            stopping_reason=stopping_reason,
            confidence=critic.confidence,
            hypotheses=hypotheses,
        )
        self._drain_reasoning_adapter_events(
            adapter=active_reasoning_adapter,
            contributions_sink=reasoning_adapter_contributions,
            trace_sink=openai_trace_events,
        )
        quality_trace.append(
            make_quality_event(
                stage="finalization",
                decision="success" if success else "failure",
                detail="Execucao do BI Agent finalizada.",
                metadata={
                    "stopping_reason": stopping_reason,
                    "tool_calls": len(state.tool_calls),
                    "queries_executed": len(state.queries_executed),
                    "response_status": synthesis_result.payload.response_status,
                    "answer_synthesis_fallback_used": synthesis_result.fallback_used,
                },
            )
        )
        chat_presentation = self._build_chat_presentation(
            synthesis=synthesis_result.payload,
            answer=answer,
            executive_summary=executive_summary,
            key_findings=key_findings,
            followup_questions=followup_questions,
        )
        return BiAgentRunResponse(
            success=success,
            error=error,
            answer=answer,
            executive_summary=executive_summary,
            key_findings=key_findings,
            limitations=limitations,
            assumptions=assumptions,
            ambiguities=ambiguities,
            answer_confidence=critic.confidence,
            dataset_id=int(request.dataset_id),
            intent=state.intent,  # type: ignore[arg-type]
            mode=request.mode,
            dry_run=dry_run,
            question_analysis=question_analysis,
            query_candidates=query_candidates,
            analysis_state=analysis_state,
            hypotheses=hypotheses,
            evidence_gaps=evidence_gaps,
            stopping_reason=stopping_reason,
            next_query_candidates=next_query_candidates,
            adaptive_decisions=adaptive_decisions,
            reasoning_adapter_contributions=reasoning_adapter_contributions,
            openai_trace=openai_trace_events,
            human_review_summary=human_review,
            evidence=state.evidence,
            tool_calls=state.tool_calls,
            queries_executed=state.queries_executed,
            evidence_scoring=critic.scoring,
            warnings=warnings,
            validation_errors=validation_errors,
            dashboard_plan=dashboard_plan_payload,
            dashboard_draft=dashboard_draft,
            recommended_followup_questions=followup_questions,
            next_best_actions=next_best_actions,
            interpreted_answer=interpreted_answer,
            final_answer=synthesis_result.payload,
            chat_presentation=chat_presentation,
            conversation_memory=conversation_memory,
            response_status=synthesis_result.payload.response_status,
            short_chat_message=synthesis_result.payload.short_chat_message,
            clarifying_questions=synthesis_result.payload.clarifying_questions,
            recommended_next_step=synthesis_result.payload.recommended_next_step,
            confidence_explanation=synthesis_result.payload.confidence_explanation,
            user_friendly_findings=synthesis_result.payload.user_friendly_findings,
            answer_synthesis_trace=synthesis_result.trace,
            answer_synthesis_fallback_used=synthesis_result.fallback_used,
            quality_trace=quality_trace,
            trace_id=trace_id,
        )

    async def _apply_semantic_discovery(
        self,
        *,
        state: BIExecutorState,
        analysis: BiQuestionAnalysis,
        question: str,
        db: Session,
        current_user: User,
        trace_id: str,
        quality_trace: list[BiQualityTraceEvent],
    ) -> BiQuestionAnalysis:
        if not self._should_run_semantic_discovery(analysis=analysis, question=question):
            return analysis

        response = await tool_registry.execute(
            tool_name="lens.search_metrics_and_dimensions",
            raw_arguments={
                "dataset_id": int(state.dataset_id),
                "query": question,
                "limit": 12,
            },
            db=db,
            current_user=current_user,
            trace_id=trace_id,
        )
        state.tool_calls.append(
            BiAgentToolCallItem(
                step_id="semantic.discovery.search",
                tool=response.tool,
                category=response.category,
                success=bool(response.output.success),
                attempt=1,
                skipped=False,
                error=response.output.error,
                warnings=list(response.output.warnings or []),
                validation_errors_count=len(response.output.validation_errors or []),
                metadata=response.output.metadata or {},
                executed_at=response.executed_at,
            )
        )
        if response.output.warnings:
            state.warnings.extend(response.output.warnings)
        if not response.output.success:
            quality_trace.append(
                make_quality_event(
                    stage="semantic_resolution",
                    decision="semantic_discovery_failed",
                    detail="Busca semantica nao executou com sucesso.",
                    metadata={"error": response.output.error or "unknown"},
                )
            )
            return analysis

        data = response.output.data or {}
        metrics_hits = []
        dimensions_hits = []
        raw_metrics = data.get("metrics")
        raw_dimensions = data.get("dimensions")
        if isinstance(raw_metrics, list):
            for item in raw_metrics:
                if isinstance(item, dict) and isinstance(item.get("name"), str) and str(item.get("name")).strip():
                    metrics_hits.append(str(item.get("name")).strip())
        if isinstance(raw_dimensions, list):
            for item in raw_dimensions:
                if isinstance(item, dict) and isinstance(item.get("name"), str) and str(item.get("name")).strip():
                    dimensions_hits.append(str(item.get("name")).strip())

        if metrics_hits or dimensions_hits:
            state.evidence.append(
                BiAgentEvidenceItem(
                    tool="lens.search_metrics_and_dimensions",
                    summary=(
                        f"Busca semantica retornou {len(metrics_hits)} metricas e {len(dimensions_hits)} dimensoes candidatas."
                    ),
                    timestamp=datetime.utcnow(),
                    data={
                        "query": question,
                        "metrics": metrics_hits[:6],
                        "dimensions": dimensions_hits[:6],
                    },
                )
            )

        inferred_metrics = list(analysis.inferred_metrics)
        inferred_dimensions = list(analysis.inferred_dimensions)
        assumptions = list(analysis.assumptions)

        if len(analysis.mentioned_metrics) == 0 and metrics_hits:
            inferred_metrics = self._merge_unique([metrics_hits[0], *inferred_metrics])
            assumptions = self._merge_unique(
                [f"Metrica inferida por busca semantica: '{metrics_hits[0]}'.", *assumptions]
            )
        if (
            len(analysis.mentioned_dimensions) == 0
            and analysis.expected_answer_shape in {"single_best", "single_worst", "comparison", "drivers", "trend"}
            and dimensions_hits
        ):
            inferred_dimensions = self._merge_unique([dimensions_hits[0], *inferred_dimensions])
            assumptions = self._merge_unique(
                [f"Dimensao inferida por busca semantica: '{dimensions_hits[0]}'.", *assumptions]
            )

        unresolved_ambiguities = []
        for item in analysis.ambiguities:
            if item.code == "missing_metric_reference" and (analysis.mentioned_metrics or inferred_metrics):
                continue
            if item.code == "missing_dimension_reference" and (analysis.mentioned_dimensions or inferred_dimensions):
                continue
            unresolved_ambiguities.append(item)

        ambiguity_level = analysis.ambiguity_level
        if len(unresolved_ambiguities) == 0:
            ambiguity_level = "low"
        elif len(unresolved_ambiguities) == 1 and ambiguity_level == "high":
            ambiguity_level = "medium"

        quality_trace.append(
            make_quality_event(
                stage="semantic_resolution",
                decision="semantic_discovery_applied",
                detail="Busca semantica aplicada antes da geracao de candidatos.",
                metadata={
                    "metric_hits": metrics_hits[:4],
                    "dimension_hits": dimensions_hits[:4],
                    "ambiguity_level_before": analysis.ambiguity_level,
                    "ambiguity_level_after": ambiguity_level,
                },
            )
        )
        return analysis.model_copy(
            update={
                "inferred_metrics": inferred_metrics,
                "inferred_dimensions": inferred_dimensions,
                "assumptions": assumptions,
                "ambiguities": unresolved_ambiguities,
                "ambiguity_level": ambiguity_level,
                "should_request_refinement": ambiguity_level == "high",
            }
        )

    def _should_run_semantic_discovery(self, *, analysis: BiQuestionAnalysis, question: str) -> bool:
        if analysis.intent == "metric_explanation":
            return False
        low_resolution = len(analysis.mentioned_metrics) == 0
        dimension_missing_for_shape = (
            analysis.expected_answer_shape in {"single_best", "single_worst", "comparison", "drivers"}
            and len(analysis.mentioned_dimensions) == 0
        )
        subjective_tokens = ("mais querida", "mais popular", "mais relevante", "mais usada", "melhor", "pior")
        has_subjective_language = any(token in question.lower() for token in subjective_tokens)
        return bool(low_resolution or dimension_missing_for_shape or has_subjective_language)

    def _merge_unique(self, values: list[str]) -> list[str]:
        seen: set[str] = set()
        output: list[str] = []
        for item in values:
            token = str(item or "").strip()
            if not token:
                continue
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            output.append(token)
        return output

    def _resolve_reasoning_adapter(
        self,
        *,
        request: BiAgentRunRequest,
        db: Session,
        warnings_sink: list[str],
    ) -> ReasoningAdapter:
        if self.reasoning_adapter is not None:
            return self.reasoning_adapter
        if not request.enable_reasoning_adapter:
            return DefaultReasoningAdapter()
        runtime = resolve_active_openai_runtime(db)
        if runtime is None:
            warnings_sink.append("Reasoning adapter requested, but no active OpenAI integration was found. Using local heuristics.")
            return DefaultReasoningAdapter()
        return OpenAIReasoningAdapter(runtime=runtime)

    def _drain_reasoning_adapter_events(
        self,
        *,
        adapter: ReasoningAdapter,
        contributions_sink: list[BiReasoningAdapterContribution],
        trace_sink: list[OpenAITraceMetadata],
    ) -> None:
        contributions_sink.extend(adapter.consume_reasoning_contributions())
        trace_sink.extend(adapter.consume_openai_trace_events())

    def _build_post_analysis_plan(
        self,
        *,
        dataset_id: int,
        intent: str,
        mode: str,
        apply_changes: bool,
        requires_visualization: bool,
        requires_dashboard: bool,
    ) -> BIExecutionPlan | None:
        steps: list[PlannedToolStep] = []
        if requires_visualization or intent in {"visualization_help", "dashboard_generation"}:
            steps.append(
                PlannedToolStep(
                    step_id="adaptive.validation.visualization",
                    tool_name="lens.suggest_best_visualization",
                    purpose="Suggest visualization after adaptive evidence collection.",
                    required=False,
                    arguments={"dataset_id": int(dataset_id)},
                )
            )
        if mode in {"plan", "draft"} or intent == "dashboard_generation":
            steps.append(
                PlannedToolStep(
                    step_id="adaptive.builder.plan",
                    tool_name="lens.generate_dashboard_plan",
                    purpose="Generate dashboard plan after adaptive evidence loop.",
                    required=False,
                    arguments={"dataset_id": int(dataset_id)},
                )
            )
        if mode == "draft" and requires_dashboard and apply_changes:
            steps.extend(
                [
                    PlannedToolStep(
                        step_id="adaptive.builder.create_draft",
                        tool_name="lens.create_dashboard_draft",
                        purpose="Create dashboard draft from adaptive loop recommendations.",
                        required=False,
                        mutable=True,
                        arguments={"dataset_id": int(dataset_id)},
                    ),
                    PlannedToolStep(
                        step_id="adaptive.builder.add_section",
                        tool_name="lens.add_dashboard_section",
                        purpose="Add evidence section in dashboard draft.",
                        required=False,
                        mutable=True,
                        arguments={"dataset_id": int(dataset_id)},
                    ),
                    PlannedToolStep(
                        step_id="adaptive.builder.add_widget",
                        tool_name="lens.add_dashboard_widget",
                        purpose="Add prioritized evidence widget in dashboard draft.",
                        required=False,
                        mutable=True,
                        arguments={"dataset_id": int(dataset_id)},
                    ),
                    PlannedToolStep(
                        step_id="adaptive.validation.draft",
                        tool_name="lens.validate_dashboard_draft",
                        purpose="Validate dashboard draft after adaptive builder steps.",
                        required=False,
                        arguments={"dataset_id": int(dataset_id)},
                    ),
                ]
            )
        if len(steps) == 0:
            return None
        return BIExecutionPlan(
            intent=intent,
            mode=mode,  # type: ignore[arg-type]
            strategy_name="adaptive_post_processing",
            selected_candidate_ids=[],
            steps=steps,
        )

    def _has_failed_required_steps(self, *, plan: BIExecutionPlan, calls) -> bool:
        latest_call_by_step = {}
        for item in calls:
            if item.skipped:
                continue
            latest_call_by_step[item.step_id] = item
        return any(
            step.required and step.step_id in latest_call_by_step and not latest_call_by_step[step.step_id].success
            for step in plan.steps
        )

    def _build_static_analysis_state(self, *, state: BIExecutorState, stopping_reason: str) -> BiAnalysisState:
        covered_candidate_ids = [item.candidate_id for item in state.queries_executed if item.candidate_id]
        covered_dimensions: list[str] = []
        temporal_coverage = False
        dimensional_coverage = False
        for item in state.queries_executed:
            query_dimensions = item.query_spec.get("dimensions", []) if isinstance(item.query_spec, dict) else []
            if isinstance(query_dimensions, list):
                for dim in query_dimensions:
                    if isinstance(dim, str) and dim not in covered_dimensions:
                        covered_dimensions.append(dim)
            if item.candidate_id in {"cand_temporal_trend", "cand_temporal_dimension"}:
                temporal_coverage = True
            if item.candidate_id in {
                "cand_dimension_breakdown",
                "cand_top_contributors",
                "cand_temporal_dimension",
                "cand_top_dimension",
                "cand_bottom_dimension",
            }:
                dimensional_coverage = True
        return BiAnalysisState(
            question=state.question,
            intent=state.intent,  # type: ignore[arg-type]
            ambiguity_level=state.question_analysis.ambiguity_level if state.question_analysis else "low",
            covered_candidate_ids=[item for item in covered_candidate_ids if item is not None],
            covered_dimensions=covered_dimensions,
            temporal_coverage=temporal_coverage,
            dimensional_coverage=dimensional_coverage,
            hypotheses=[],
            evidence_gaps=[],
            current_confidence=BIAgentCritic().review(state=state).confidence,
            last_decision_reason=stopping_reason,
            open_ambiguities_count=len(state.question_analysis.ambiguities) if state.question_analysis else 0,
        )

    def _build_static_next_candidates(self, *, state: BIExecutorState, query_candidates: list[BiQueryCandidate]) -> list[BiNextQueryCandidate]:
        executed = {item.candidate_id for item in state.queries_executed if item.candidate_id}
        output: list[BiNextQueryCandidate] = []
        for candidate in query_candidates:
            blocked = candidate.candidate_id in executed
            output.append(
                BiNextQueryCandidate(
                    candidate_id=candidate.candidate_id,
                    title=candidate.title,
                    score=0.0 if blocked else 0.5,
                    reason="Candidate already executed." if blocked else "Candidate not executed in static mode.",
                    estimated_gain=0.0 if blocked else 0.3,
                    estimated_cost=round(float(candidate.cost_score) / 100.0, 3),
                    novelty_score=0.0 if blocked else 1.0,
                    blocked=blocked,
                )
            )
        return output[:5]

    def _compose_analyst_answer(
        self,
        *,
        state: BIExecutorState,
        critic_confidence: float,
        interpreted_answer: BiInterpretedAnswer,
        ranked_evidence: list[RankedEvidence],
        label_index: SemanticLabelIndex,
    ) -> tuple[str, list[str], str]:
        fallback_findings = [item.finding for item in ranked_evidence if item.finding][:4]
        key_findings = list(
            dict.fromkeys(
                [
                    *interpreted_answer.supporting_facts,
                    *fallback_findings,
                    *interpreted_answer.caveats,
                ]
            )
        )[:6]
        if not key_findings and state.question_analysis and state.question_analysis.ambiguities:
            key_findings.append("A analise ainda esta limitada por ambiguidade da pergunta e sinal insuficiente de dados.")

        if state.intent == "diagnostic_analysis":
            key_findings.append("Leitura diagnostica e correlacional; nao implica causalidade direta sem validacao adicional.")
        if state.intent == "dashboard_generation" and state.dashboard_plan_evidence:
            key_findings.append("O plano de dashboard foi montado com referencia explicita a evidencias observadas.")
        key_findings = list(dict.fromkeys(key_findings))[:6]

        if interpreted_answer.direct_answer:
            answer = interpreted_answer.direct_answer
        elif state.intent == "kpi_summary":
            top_metrics = self._top_metric_labels(state=state, label_index=label_index)
            answer = (
                "Os principais KPIs deste dataset sao: " + ", ".join(top_metrics[:4]) + "."
                if top_metrics
                else "Nao foi possivel montar uma leitura de KPI com sinal suficiente."
            )
        elif state.intent == "visualization_help":
            if state.visualization_suggestions:
                top = state.visualization_suggestions[0]
                answer = (
                    f"Recomendacao principal: usar '{top.get('widget_type', 'table')}'. "
                    f"Justificativa: {top.get('reason', 'aderencia ao fenomeno analisado')}."
                )
            else:
                answer = "Nao foi possivel produzir recomendacao de visualizacao com seguranca."
        elif state.intent == "metric_explanation":
            metric_evidence = next((item for item in state.evidence if item.tool == "lens.explain_metric"), None)
            answer = metric_evidence.summary if metric_evidence else "Nao foi possivel explicar a metrica com evidencias suficientes."
        elif state.intent == "dashboard_generation":
            if state.dashboard_plan_evidence:
                sections = len(state.dashboard_plan_evidence.get("sections", []))
                answer = f"Foi gerado um plano de dashboard defensavel com {sections} secoes e widgets embasados em evidencias."
            else:
                answer = "Intencao de dashboard detectada, mas faltaram evidencias para plano defensavel completo."
        else:
            answer = "Nao foi possivel derivar uma resposta direta com as evidencias atuais."

        executive_seed = key_findings[0] if key_findings else answer
        executive_summary = self._build_executive_summary(state=state, key_findings=[executive_seed], confidence=critic_confidence)
        return executive_summary, key_findings, answer

    def _build_executive_summary(self, *, state: BIExecutorState, key_findings: list[str], confidence: float) -> str:
        confidence_band = "alta" if confidence >= 0.75 else ("moderada" if confidence >= 0.45 else "baixa")
        if key_findings:
            return f"Resumo executivo: {key_findings[0]} Confianca {confidence_band} nesta leitura."
        if state.queries_executed:
            return f"Resumo executivo: foram executadas {len(state.queries_executed)} consultas, mas sem achado conclusivo forte."
        return "Resumo executivo: nao houve evidencia suficiente para uma leitura conclusiva."

    def _top_metric_labels(self, *, state: BIExecutorState, label_index: SemanticLabelIndex) -> list[str]:
        if not (state.context_catalog and isinstance(state.context_catalog.get("metrics"), list)):
            return []
        labels: list[str] = []
        for item in state.context_catalog["metrics"]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            labels.append(resolve_field_label(label_index, name))
        return list(dict.fromkeys(labels))

    def _derive_limitations(self, *, state: BIExecutorState) -> list[str]:
        limits: list[str] = []
        if state.question_analysis and state.question_analysis.ambiguity_level in {"medium", "high"}:
            limits.append("Pergunta ambigua; o agente precisou assumir metrica/dimensao para avancar.")
        if len(state.queries_executed) == 0:
            limits.append("Nenhuma query analitica executada com sucesso.")
        if any(item.row_count == 0 for item in state.queries_executed):
            limits.append("Parte das queries retornou zero linhas, reduzindo robustez inferencial.")
        if state.validation_errors:
            limits.append("Erros de validacao nas tools podem ter reduzido cobertura da analise.")
        return limits

    def _compose_evidence_dashboard_plan(
        self,
        *,
        state: BIExecutorState,
        query_candidates: list[BiQueryCandidate],
    ) -> dict[str, Any] | None:
        if state.intent not in {"dashboard_generation", "visualization_help", "diagnostic_analysis"} and state.mode == "answer":
            return None

        non_empty = [item for item in state.queries_executed if item.row_count > 0]
        if len(non_empty) == 0 and not state.dashboard_plan:
            return None

        sections: list[dict[str, Any]] = []
        widgets: list[dict[str, Any]] = []
        for index, item in enumerate(non_empty[:4]):
            widget_type = "table"
            if state.visualization_suggestions:
                widget_type = str(state.visualization_suggestions[min(index, len(state.visualization_suggestions) - 1)].get("widget_type") or "table")
            widgets.append(
                {
                    "id": f"evidence-widget-{index + 1}",
                    "type": widget_type,
                    "title": item.candidate_title or f"Widget {index + 1}",
                    "justification": f"Baseado em candidate '{item.candidate_id}' com row_count={item.row_count}.",
                    "evidence_query_ids": [item.candidate_id] if item.candidate_id else [],
                    "config_hint": {
                        "columns": item.columns[:8],
                        "query_spec": item.query_spec,
                    },
                }
            )

        if widgets:
            sections.append(
                {
                    "id": "sec-executive",
                    "title": "Resumo Executivo",
                    "narrative": "Visao consolidada dos principais sinais quantitativos observados.",
                    "widgets": widgets[:2],
                }
            )
            if len(widgets) > 2:
                sections.append(
                    {
                        "id": "sec-drivers",
                        "title": "Drivers e Variacoes",
                        "narrative": "Quebras dimensionais/temporais para explicar variacoes observadas.",
                        "widgets": widgets[2:],
                    }
                )

        native_filters: list[dict[str, Any]] = []
        if state.question_analysis:
            for dimension in state.question_analysis.mentioned_dimensions[:2]:
                native_filters.append({"column": dimension, "op": "eq", "value": None, "visible": True})

        if not native_filters:
            for candidate in query_candidates:
                if candidate.dimensions:
                    native_filters.append({"column": candidate.dimensions[0], "op": "eq", "value": None, "visible": True})
                if len(native_filters) >= 2:
                    break

        return {
            "title": f"Plano de Dashboard - {state.question[:64]}",
            "explanation": "Plano orientado por evidencias de queries executadas no dataset atual.",
            "planning_steps": [
                "Consolidar visao geral agregada",
                "Incluir cortes de maior variacao observada",
                "Aplicar filtros nativos para navegacao analitica",
            ],
            "native_filters": native_filters,
            "sections": sections,
        }

    def _to_dashboard_plan(self, *, state: BIExecutorState) -> BiAgentDashboardPlan | None:
        source = state.dashboard_plan_evidence or state.dashboard_plan
        if not isinstance(source, dict):
            return None
        return BiAgentDashboardPlan(
            title=source.get("title"),
            explanation=source.get("explanation"),
            planning_steps=source.get("planning_steps") if isinstance(source.get("planning_steps"), list) else [],
            native_filters=source.get("native_filters") if isinstance(source.get("native_filters"), list) else [],
            sections=source.get("sections") if isinstance(source.get("sections"), list) else [],
        )

    def _to_dashboard_draft(self, *, state: BIExecutorState, request: BiAgentRunRequest) -> BiAgentDashboardDraftResult | None:
        if request.mode != "draft":
            return None
        if request.dashboard_id is not None:
            source = "input"
        elif state.dashboard_id is not None:
            source = "created"
        else:
            source = "none"
        actions = [
            f"{item.tool}:{'skipped' if item.skipped else 'executed'}"
            for item in state.tool_calls
            if item.tool.startswith("lens.") and item.category == "builder"
        ]
        return BiAgentDashboardDraftResult(
            dry_run=state.dry_run,
            applied=bool(request.apply_changes and state.dashboard_id is not None),
            dashboard_id=state.dashboard_id,
            dashboard_id_source=source,
            snapshot=state.dashboard_draft_snapshot or {},
            actions=actions,
        )

    def _build_human_review_summary(
        self,
        *,
        state: BIExecutorState,
        stopping_reason: str,
        confidence: float,
        hypotheses: list[BiAgentHypothesis],
    ) -> BiHumanReviewSummary:
        ambiguity_notes = [item.description for item in (state.question_analysis.ambiguities if state.question_analysis else [])]
        hypothesis_notes = [f"{item.hypothesis_id}:{item.status}:{round(item.confidence, 2)}" for item in hypotheses]
        query_trace = [
            f"{item.candidate_id or 'query'} -> rows={item.row_count}"
            for item in state.queries_executed
        ]
        return BiHumanReviewSummary(
            question=state.question,
            intent=state.intent,  # type: ignore[arg-type]
            ambiguity_notes=ambiguity_notes,
            hypothesis_notes=hypothesis_notes,
            query_trace=query_trace,
            stopping_reason=stopping_reason,
            final_confidence=confidence,
        )

    def _build_chat_presentation(
        self,
        *,
        synthesis: BiFinalAnswerSynthesis,
        answer: str,
        executive_summary: str | None,
        key_findings: list[str],
        followup_questions: list[str],
    ) -> BiChatPresentation:
        primary = synthesis.short_chat_message or answer or executive_summary or "Nao foi possivel compor resposta para o chat."
        direct_answer = synthesis.direct_answer
        if direct_answer and direct_answer.strip().lower() == primary.strip().lower():
            direct_answer = None
        supporting_points = list(dict.fromkeys([*synthesis.user_friendly_findings, *key_findings]))[:2]
        final_followups = list(dict.fromkeys([*synthesis.clarifying_questions, *followup_questions]))[:5]
        return BiChatPresentation(
            response_status=synthesis.response_status,
            primary_message=primary,
            direct_answer=direct_answer,
            supporting_points=supporting_points,
            follow_up_questions=final_followups,
            recommended_next_step=synthesis.recommended_next_step,
            confidence_message=synthesis.confidence_explanation,
        )

    def _default_next_actions(self, *, state: BIExecutorState, request: BiAgentRunRequest) -> list[str]:
        actions: list[str] = []
        if not state.queries_executed and state.intent in {"kpi_summary", "exploratory_analysis", "diagnostic_analysis"}:
            actions.append("Executar nova iteracao com candidatos de query alternativos para aumentar evidencia.")
        if state.intent == "dashboard_generation" and request.mode == "answer":
            actions.append("Use mode='plan' para retornar plano de dashboard estruturado.")
        if request.mode == "draft" and not request.apply_changes:
            actions.append("Defina apply_changes=true para persistir draft no dashboard.")
        if request.mode == "draft" and state.intent != "dashboard_generation":
            actions.append("Pergunta atual e analitica; use pergunta de dashboard para habilitar criacao de draft.")
        if state.validation_errors:
            actions.append("Corrigir validation_errors e repetir a execucao.")
        if state.question_analysis and state.question_analysis.should_request_refinement:
            actions.append("Refinar pergunta com metrica, periodo e dimensao alvo para reduzir ambiguidade.")
        return actions
