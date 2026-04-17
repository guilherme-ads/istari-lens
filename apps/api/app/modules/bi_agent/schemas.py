from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.openai_adapter.schemas import OpenAITraceMetadata

BiAgentIntent = Literal[
    "kpi_summary",
    "exploratory_analysis",
    "dashboard_generation",
    "visualization_help",
    "diagnostic_analysis",
    "metric_explanation",
]
BiAgentMode = Literal["answer", "plan", "draft"]
BiAmbiguityLevel = Literal["low", "medium", "high"]
BiHypothesisStatus = Literal["open", "supported", "inconclusive", "rejected"]
BiEvidenceGapPriority = Literal["high", "medium", "low"]
BiResponseStatus = Literal["answered", "needs_clarification", "insufficient_evidence"]
BiExpectedAnswerShape = Literal[
    "single_best",
    "single_worst",
    "trend",
    "comparison",
    "drivers",
    "definition",
    "dashboard_plan",
    "open_exploration",
]
BiInterpretedAnswerType = Literal[
    "top_dimension",
    "bottom_dimension",
    "trend_summary",
    "comparison_summary",
    "drivers_summary",
    "definition",
    "insufficient_evidence",
    "needs_clarification",
]
BiQualityTraceStage = Literal[
    "memory",
    "semantic_resolution",
    "answerability",
    "evidence_selection",
    "synthesis",
    "fallback",
    "finalization",
]
BiConversationRole = Literal["user", "assistant", "ai"]


class BiConversationTurn(BaseModel):
    role: BiConversationRole
    content: str = Field(min_length=1, max_length=4000)


class BiConversationMemory(BaseModel):
    applied: bool = False
    original_question: str
    resolved_question: str
    references_used: list[str] = Field(default_factory=list)
    inferred_metric: str | None = None
    inferred_dimension: str | None = None
    source_turns_count: int = 0
    notes: list[str] = Field(default_factory=list)


class BiAgentRunRequest(BaseModel):
    dataset_id: int = Field(gt=0)
    question: str
    mode: BiAgentMode = "answer"
    apply_changes: bool = False
    adaptive_mode: bool = True
    max_evidence_steps: int = Field(default=6, ge=1, le=20)
    enable_reasoning_adapter: bool = False
    dashboard_id: int | None = Field(default=None, gt=0)
    trace_id: str | None = None
    conversation_history: list[BiConversationTurn] = Field(default_factory=list, max_length=12)
    max_steps: int = Field(default=20, ge=4, le=100)
    max_retries: int = Field(default=1, ge=0, le=4)


class BiAgentEvidenceItem(BaseModel):
    tool: str
    summary: str
    timestamp: datetime
    data: dict[str, Any] = Field(default_factory=dict)


class BiAgentAmbiguityItem(BaseModel):
    code: str
    description: str
    alternatives: list[str] = Field(default_factory=list)
    suggested_refinement: str | None = None


class BiQuestionAnalysis(BaseModel):
    intent: BiAgentIntent
    expected_answer_shape: BiExpectedAnswerShape = "open_exploration"
    mentioned_metrics: list[str] = Field(default_factory=list)
    inferred_metrics: list[str] = Field(default_factory=list)
    mentioned_dimensions: list[str] = Field(default_factory=list)
    inferred_dimensions: list[str] = Field(default_factory=list)
    requires_temporal: bool = False
    requires_comparison: bool = False
    requires_diagnostic: bool = False
    requires_visualization: bool = False
    requires_dashboard: bool = False
    ambiguity_level: BiAmbiguityLevel = "low"
    should_request_refinement: bool = False
    assumptions: list[str] = Field(default_factory=list)
    ambiguities: list[BiAgentAmbiguityItem] = Field(default_factory=list)


class BiQueryMetricSpec(BaseModel):
    field: str
    agg: str


class BiQueryFilterSpec(BaseModel):
    field: str
    op: str
    value: list[Any] | None = None


class BiQuerySortSpec(BaseModel):
    field: str
    dir: str


class BiQueryCandidate(BaseModel):
    candidate_id: str
    title: str
    hypothesis: str
    metrics: list[BiQueryMetricSpec] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[BiQueryFilterSpec] = Field(default_factory=list)
    sort: list[BiQuerySortSpec] = Field(default_factory=list)
    limit: int = 25
    offset: int = 0
    priority: int = 50
    cost_score: int = 50
    tags: list[str] = Field(default_factory=list)


class BiAgentToolCallItem(BaseModel):
    step_id: str
    tool: str
    category: str
    success: bool
    attempt: int = 1
    skipped: bool = False
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    validation_errors_count: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)
    executed_at: datetime


class BiAgentQueryEvidence(BaseModel):
    tool: str = "lens.run_query"
    candidate_id: str | None = None
    candidate_title: str | None = None
    query_spec: dict[str, Any] = Field(default_factory=dict)
    row_count: int = 0
    columns: list[str] = Field(default_factory=list)
    rows_preview: list[dict[str, Any]] = Field(default_factory=list)


class BiAgentDashboardPlan(BaseModel):
    title: str | None = None
    explanation: str | None = None
    planning_steps: list[str] = Field(default_factory=list)
    native_filters: list[dict[str, Any]] = Field(default_factory=list)
    sections: list[dict[str, Any]] = Field(default_factory=list)


class BiAgentDashboardDraftResult(BaseModel):
    dry_run: bool = True
    applied: bool = False
    dashboard_id: int | None = None
    dashboard_id_source: Literal["input", "created", "none"] = "none"
    snapshot: dict[str, Any] = Field(default_factory=dict)
    actions: list[str] = Field(default_factory=list)


class BiEvidenceScoring(BaseModel):
    valid_queries_score: float = 0.0
    diversity_score: float = 0.0
    question_alignment_score: float = 0.0
    temporal_coverage_score: float = 0.0
    dimensional_coverage_score: float = 0.0
    risk_penalty: float = 0.0
    final_score: float = 0.0


class BiAgentHypothesis(BaseModel):
    hypothesis_id: str
    statement: str
    status: BiHypothesisStatus = "open"
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence_query_ids: list[str] = Field(default_factory=list)
    notes: str | None = None


class BiEvidenceGap(BaseModel):
    code: str
    description: str
    priority: BiEvidenceGapPriority = "medium"
    resolved: bool = False
    resolved_by_candidate_ids: list[str] = Field(default_factory=list)


class BiNextQueryCandidate(BaseModel):
    candidate_id: str
    title: str
    score: float = 0.0
    reason: str
    estimated_gain: float = 0.0
    estimated_cost: float = 0.0
    novelty_score: float = 0.0
    blocked: bool = False


class BiAdaptiveDecision(BaseModel):
    iteration: int
    selected_candidate_id: str | None = None
    selected_tool: str = "lens.run_query"
    status: Literal["executed", "stopped", "skipped"] = "executed"
    reason: str
    estimated_gain: float = 0.0
    estimated_cost: float = 0.0
    novelty_score: float = 0.0
    score_breakdown: dict[str, float] = Field(default_factory=dict)
    confidence_before: float | None = None
    confidence_after: float | None = None
    marginal_gain: float | None = None


class BiReasoningAdapterContribution(BaseModel):
    contribution_type: Literal[
        "intent_classification",
        "question_analysis",
        "candidate_rerank",
        "rerank",
        "hypothesis_suggestion",
        "hypothesis_refinement",
        "next_action",
    ]
    applied: bool = False
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)


class BiAnalysisState(BaseModel):
    question: str
    intent: BiAgentIntent
    ambiguity_level: BiAmbiguityLevel = "low"
    covered_candidate_ids: list[str] = Field(default_factory=list)
    covered_dimensions: list[str] = Field(default_factory=list)
    temporal_coverage: bool = False
    dimensional_coverage: bool = False
    hypotheses: list[BiAgentHypothesis] = Field(default_factory=list)
    evidence_gaps: list[BiEvidenceGap] = Field(default_factory=list)
    current_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    last_decision_reason: str | None = None
    open_ambiguities_count: int = 0


class BiHumanReviewSummary(BaseModel):
    question: str
    intent: BiAgentIntent
    ambiguity_notes: list[str] = Field(default_factory=list)
    hypothesis_notes: list[str] = Field(default_factory=list)
    query_trace: list[str] = Field(default_factory=list)
    stopping_reason: str | None = None
    final_confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class BiInterpretedAnswer(BaseModel):
    answer_type: BiInterpretedAnswerType
    response_status_hint: BiResponseStatus = "answered"
    selected_candidate_id: str | None = None
    direct_answer: str | None = None
    supporting_facts: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    recommended_next_step: str | None = None


class BiFinalAnswerSynthesis(BaseModel):
    response_status: BiResponseStatus
    short_chat_message: str
    direct_answer: str | None = None
    why_not_fully_answered: str | None = None
    assumptions_used: list[str] = Field(default_factory=list)
    clarifying_questions: list[str] = Field(default_factory=list)
    recommended_next_step: str | None = None
    confidence_explanation: str | None = None
    user_friendly_findings: list[str] = Field(default_factory=list)


class BiChatPresentation(BaseModel):
    response_status: BiResponseStatus
    primary_message: str
    direct_answer: str | None = None
    supporting_points: list[str] = Field(default_factory=list)
    follow_up_questions: list[str] = Field(default_factory=list)
    recommended_next_step: str | None = None
    confidence_message: str | None = None


class BiQualityTraceEvent(BaseModel):
    stage: BiQualityTraceStage
    decision: str
    detail: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class BiAgentRunResponse(BaseModel):
    success: bool = True
    error: str | None = None
    answer: str
    executive_summary: str | None = None
    key_findings: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    ambiguities: list[BiAgentAmbiguityItem] = Field(default_factory=list)
    answer_confidence: float = Field(ge=0.0, le=1.0)
    dataset_id: int
    intent: BiAgentIntent
    mode: BiAgentMode
    dry_run: bool = True
    question_analysis: BiQuestionAnalysis | None = None
    query_candidates: list[BiQueryCandidate] = Field(default_factory=list)
    analysis_state: BiAnalysisState | None = None
    hypotheses: list[BiAgentHypothesis] = Field(default_factory=list)
    evidence_gaps: list[BiEvidenceGap] = Field(default_factory=list)
    stopping_reason: str | None = None
    next_query_candidates: list[BiNextQueryCandidate] = Field(default_factory=list)
    adaptive_decisions: list[BiAdaptiveDecision] = Field(default_factory=list)
    reasoning_adapter_contributions: list[BiReasoningAdapterContribution] = Field(default_factory=list)
    openai_trace: list[OpenAITraceMetadata] = Field(default_factory=list)
    human_review_summary: BiHumanReviewSummary | None = None
    evidence: list[BiAgentEvidenceItem] = Field(default_factory=list)
    tool_calls: list[BiAgentToolCallItem] = Field(default_factory=list)
    queries_executed: list[BiAgentQueryEvidence] = Field(default_factory=list)
    evidence_scoring: BiEvidenceScoring | None = None
    warnings: list[str] = Field(default_factory=list)
    validation_errors: list[MCPToolValidationError] = Field(default_factory=list)
    dashboard_plan: BiAgentDashboardPlan | None = None
    dashboard_draft: BiAgentDashboardDraftResult | None = None
    recommended_followup_questions: list[str] = Field(default_factory=list)
    next_best_actions: list[str] = Field(default_factory=list)
    interpreted_answer: BiInterpretedAnswer | None = None
    final_answer: BiFinalAnswerSynthesis | None = None
    chat_presentation: BiChatPresentation | None = None
    conversation_memory: BiConversationMemory | None = None
    response_status: BiResponseStatus | None = None
    short_chat_message: str | None = None
    clarifying_questions: list[str] = Field(default_factory=list)
    recommended_next_step: str | None = None
    confidence_explanation: str | None = None
    user_friendly_findings: list[str] = Field(default_factory=list)
    answer_synthesis_trace: OpenAITraceMetadata | None = None
    answer_synthesis_fallback_used: bool = False
    quality_trace: list[BiQualityTraceEvent] = Field(default_factory=list)
    trace_id: str
