from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

AgentIntent = Literal[
    "kpi_summary",
    "exploratory_analysis",
    "dashboard_generation",
    "visualization_help",
    "diagnostic_analysis",
    "metric_explanation",
]
AmbiguityLevel = Literal["low", "medium", "high"]
GapPriority = Literal["high", "medium", "low"]
ExpectedAnswerShape = Literal[
    "single_best",
    "single_worst",
    "trend",
    "comparison",
    "drivers",
    "definition",
    "dashboard_plan",
    "open_exploration",
]


class OpenAITraceMetadata(BaseModel):
    call_id: str
    lens_trace_id: str
    task: str
    model: str
    schema_name: str | None = None
    request_id: str | None = None
    response_id: str | None = None
    success: bool = True
    accepted: bool = True
    used_fallback: bool = False
    fallback_reason: str | None = None
    attempts: int = 1
    latency_ms: int = 0
    error_code: str | None = None
    error_message: str | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    metadata: dict[str, Any] = Field(default_factory=dict)


class IntentClassificationResult(BaseModel):
    intent: AgentIntent
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str | None = None


class QuestionAnalysisResult(BaseModel):
    intent: AgentIntent
    expected_answer_shape: ExpectedAnswerShape = "open_exploration"
    mentioned_metrics: list[str] = Field(default_factory=list)
    inferred_metrics: list[str] = Field(default_factory=list)
    mentioned_dimensions: list[str] = Field(default_factory=list)
    inferred_dimensions: list[str] = Field(default_factory=list)
    requires_temporal: bool = False
    requires_comparison: bool = False
    requires_diagnostic: bool = False
    requires_visualization: bool = False
    requires_dashboard: bool = False
    ambiguity_level: AmbiguityLevel = "low"
    should_request_refinement: bool = False
    assumptions: list[str] = Field(default_factory=list)
    ambiguities: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class HypothesisSuggestionItem(BaseModel):
    statement: str
    priority: GapPriority = "medium"
    supporting_signal: str | None = None


class EvidenceGapSuggestionItem(BaseModel):
    code: str
    description: str
    priority: GapPriority = "medium"


class HypothesisSuggestionResult(BaseModel):
    hypotheses: list[HypothesisSuggestionItem] = Field(default_factory=list)
    evidence_gaps: list[EvidenceGapSuggestionItem] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class CandidateScoreItem(BaseModel):
    candidate_id: str
    score: float = Field(ge=0.0, le=1.0)
    reason: str


class CandidateRerankingResult(BaseModel):
    ranked_candidate_ids: list[str] = Field(default_factory=list)
    scores: list[CandidateScoreItem] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class NextActionSuggestionResult(BaseModel):
    candidate_id: str | None = None
    tool_name: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)
    hypothesis_to_test: str | None = None
    reason: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
