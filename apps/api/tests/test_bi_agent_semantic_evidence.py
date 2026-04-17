from __future__ import annotations

from app.modules.bi_agent.agent.evidence_selection import rank_query_evidence
from app.modules.bi_agent.agent.semantic_normalization import (
    build_semantic_label_index,
    resolve_field_label,
    resolve_metric_label,
)
from app.modules.bi_agent.schemas import (
    BiAgentQueryEvidence,
    BiQueryCandidate,
    BiQueryMetricSpec,
    BiQuestionAnalysis,
)


def test_semantic_normalization_uses_business_labels() -> None:
    label_index = build_semantic_label_index(
        catalog={
            "metrics": [{"name": "receita_total", "description": "Receita total"}],
            "dimensions": [{"name": "canal", "description": "Canal de venda"}],
        },
        schema={"fields": [{"name": "created_at", "description": "Data da venda"}]},
        semantic_layer=None,
    )
    assert resolve_field_label(label_index, "receita_total") == "Receita Total"
    assert "Receita Total" in resolve_metric_label(index=label_index, field_name="receita_total", agg="sum")
    assert resolve_field_label(label_index, "created_at") == "Data da venda"


def test_evidence_selection_prioritizes_intent_alignment() -> None:
    analysis = BiQuestionAnalysis(
        intent="diagnostic_analysis",
        requires_temporal=True,
        requires_diagnostic=True,
        mentioned_metrics=["receita_total"],
        inferred_dimensions=["canal"],
    )
    label_index = build_semantic_label_index(
        catalog={
            "metrics": [{"name": "receita_total", "unit": "brl"}],
            "dimensions": [{"name": "canal"}],
        },
        schema={"fields": [{"name": "created_at", "semantic_type": "temporal"}]},
        semantic_layer=None,
    )
    candidates = [
        BiQueryCandidate(
            candidate_id="cand_overview",
            title="Visao geral",
            hypothesis="...",
            metrics=[BiQueryMetricSpec(field="receita_total", agg="sum")],
            dimensions=[],
            priority=90,
            cost_score=15,
        ),
        BiQueryCandidate(
            candidate_id="cand_temporal_dimension",
            title="Tempo x canal",
            hypothesis="...",
            metrics=[BiQueryMetricSpec(field="receita_total", agg="sum")],
            dimensions=["created_at", "canal"],
            priority=82,
            cost_score=55,
        ),
    ]
    executed = [
        BiAgentQueryEvidence(
            candidate_id="cand_overview",
            candidate_title="Visao geral",
            query_spec={"metrics": [{"field": "receita_total", "agg": "sum"}], "dimensions": []},
            row_count=1,
            columns=["m0"],
            rows_preview=[{"m0": 100.0}],
        ),
        BiAgentQueryEvidence(
            candidate_id="cand_temporal_dimension",
            candidate_title="Tempo x canal",
            query_spec={"metrics": [{"field": "receita_total", "agg": "sum"}], "dimensions": ["created_at", "canal"]},
            row_count=3,
            columns=["created_at", "canal", "m0"],
            rows_preview=[{"created_at": "2026-01-01", "canal": "App", "m0": 90.0}],
        ),
    ]
    ranked = rank_query_evidence(
        analysis=analysis,
        queries_executed=executed,
        query_candidates=candidates,
        label_index=label_index,
        max_items=2,
    )
    assert ranked[0].query.candidate_id == "cand_temporal_dimension"
    assert any("Receita Total" in item.finding for item in ranked)
    assert any("01/01/2026" in item.finding for item in ranked)
    assert any("R$" in item.finding for item in ranked)
