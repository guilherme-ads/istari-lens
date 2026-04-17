from __future__ import annotations

from app.modules.bi_agent.agent.evidence_selection import RankedEvidence
from app.modules.bi_agent.agent.question_analysis import analyze_question
from app.modules.bi_agent.agent.result_interpreter import interpret_query_results
from app.modules.bi_agent.agent.semantic_normalization import build_semantic_label_index
from app.modules.bi_agent.schemas import BiAgentQueryEvidence


def _context() -> tuple[dict, dict, dict]:
    semantic_layer = {
        "semantic_columns": [
            {"name": "estacao_mais_usada", "type": "text", "description": "Estacao"},
            {"name": "data_recarga", "type": "temporal", "description": "Data"},
            {"name": "peso_rs_percentual_minimo", "type": "numeric", "description": "Percentual"},
        ]
    }
    schema = {
        "fields": [
            {"name": "estacao_mais_usada", "semantic_type": "text", "description": "Estacao"},
            {"name": "data_recarga", "semantic_type": "temporal", "description": "Data"},
            {"name": "peso_rs_percentual_minimo", "semantic_type": "numeric", "description": "Percentual"},
        ]
    }
    catalog = {
        "metrics": [
            {
                "name": "peso_rs_percentual_minimo",
                "description": "Percentual minimo",
                "unit": "%",
            }
        ],
        "dimensions": [
            {"name": "estacao_mais_usada", "description": "Estacao"},
            {"name": "data_recarga", "description": "Data"},
        ],
    }
    return semantic_layer, schema, catalog


def test_question_analysis_detects_single_best_shape() -> None:
    semantic_layer, schema, catalog = _context()
    analysis = analyze_question(
        question="Qual e a estacao mais querida dos usuarios?",
        semantic_layer=semantic_layer,
        schema=schema,
        catalog=catalog,
        intent_override="kpi_summary",
    )
    assert analysis.expected_answer_shape == "single_best"


def test_question_analysis_detects_trend_shape() -> None:
    semantic_layer, schema, catalog = _context()
    analysis = analyze_question(
        question="Como evoluiu o percentual minimo ao longo do tempo?",
        semantic_layer=semantic_layer,
        schema=schema,
        catalog=catalog,
        intent_override="exploratory_analysis",
    )
    assert analysis.expected_answer_shape == "trend"


def test_result_interpreter_single_best() -> None:
    semantic_layer, schema, catalog = _context()
    analysis = analyze_question(
        question="Qual e a estacao mais querida dos usuarios?",
        semantic_layer=semantic_layer,
        schema=schema,
        catalog=catalog,
        intent_override="kpi_summary",
    )
    label_index = build_semantic_label_index(catalog=catalog, schema=schema, semantic_layer=semantic_layer)
    query = BiAgentQueryEvidence(
        candidate_id="cand_top_dimension",
        candidate_title="Melhor Dimensao",
        query_spec={
            "metrics": [{"field": "peso_rs_percentual_minimo", "agg": "sum", "alias": "m0"}],
            "dimensions": ["estacao_mais_usada"],
        },
        row_count=2,
        columns=["estacao_mais_usada", "m0"],
        rows_preview=[
            {"estacao_mais_usada": "BYD SAGA 2", "m0": 12.92},
            {"estacao_mais_usada": "ESTACAO B", "m0": 10.05},
        ],
    )
    interpreted = interpret_query_results(
        analysis=analysis,
        ranked_evidence=[RankedEvidence(query=query, score=0.98, reasons=["answer_fit"], finding="")],
        queries_executed=[query],
        label_index=label_index,
    )
    assert interpreted.answer_type == "top_dimension"
    assert interpreted.response_status_hint == "answered"
    assert "BYD SAGA 2" in (interpreted.direct_answer or "")


def test_result_interpreter_trend() -> None:
    semantic_layer, schema, catalog = _context()
    analysis = analyze_question(
        question="Mostre a tendencia do percentual minimo por data",
        semantic_layer=semantic_layer,
        schema=schema,
        catalog=catalog,
        intent_override="exploratory_analysis",
    )
    label_index = build_semantic_label_index(catalog=catalog, schema=schema, semantic_layer=semantic_layer)
    query = BiAgentQueryEvidence(
        candidate_id="cand_temporal_trend",
        candidate_title="Evolucao Temporal",
        query_spec={
            "metrics": [{"field": "peso_rs_percentual_minimo", "agg": "sum", "alias": "m0"}],
            "dimensions": ["data_recarga"],
        },
        row_count=3,
        columns=["data_recarga", "m0"],
        rows_preview=[
            {"data_recarga": "2026-01-01", "m0": 10.0},
            {"data_recarga": "2026-02-01", "m0": 11.5},
            {"data_recarga": "2026-03-01", "m0": 12.3},
        ],
    )
    interpreted = interpret_query_results(
        analysis=analysis,
        ranked_evidence=[RankedEvidence(query=query, score=0.94, reasons=["answer_fit"], finding="")],
        queries_executed=[query],
        label_index=label_index,
    )
    assert interpreted.answer_type == "trend_summary"
    assert interpreted.response_status_hint == "answered"
    assert "tendencia" in (interpreted.direct_answer or "").lower()


def test_result_interpreter_insufficient_without_rows() -> None:
    semantic_layer, schema, catalog = _context()
    analysis = analyze_question(
        question="Qual e a estacao mais querida dos usuarios?",
        semantic_layer=semantic_layer,
        schema=schema,
        catalog=catalog,
        intent_override="kpi_summary",
    )
    label_index = build_semantic_label_index(catalog=catalog, schema=schema, semantic_layer=semantic_layer)
    query = BiAgentQueryEvidence(
        candidate_id="cand_top_dimension",
        candidate_title="Melhor Dimensao",
        query_spec={
            "metrics": [{"field": "peso_rs_percentual_minimo", "agg": "sum", "alias": "m0"}],
            "dimensions": ["estacao_mais_usada"],
        },
        row_count=0,
        columns=["estacao_mais_usada", "m0"],
        rows_preview=[],
    )
    interpreted = interpret_query_results(
        analysis=analysis,
        ranked_evidence=[RankedEvidence(query=query, score=0.2, reasons=["query_sem_resultado"], finding="")],
        queries_executed=[query],
        label_index=label_index,
    )
    assert interpreted.answer_type in {"insufficient_evidence", "needs_clarification"}
