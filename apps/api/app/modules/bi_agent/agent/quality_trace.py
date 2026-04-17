from __future__ import annotations

from app.modules.bi_agent.schemas import BiQualityTraceEvent, BiQualityTraceStage


def make_quality_event(
    *,
    stage: BiQualityTraceStage,
    decision: str,
    detail: str | None = None,
    metadata: dict | None = None,
) -> BiQualityTraceEvent:
    return BiQualityTraceEvent(
        stage=stage,
        decision=decision,
        detail=detail,
        metadata=metadata or {},
    )

