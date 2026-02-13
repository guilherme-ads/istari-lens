import pytest

from app.query_builder import build_kpi_batch_query, build_widget_query
from app.widget_config import WidgetConfig


def _cfg(payload: dict) -> WidgetConfig:
    return WidgetConfig.model_validate(payload)


def test_kpi_count_query() -> None:
    sql, params = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'COUNT("id_recarga")' in sql
    assert 'FROM "public"."vw_recargas"' in sql
    assert params == []


def test_kpi_sum_kwh_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "kwh"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SUM("kwh") AS "m0"' in sql


def test_kpi_sum_valor_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "valor"}],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SUM("valor") AS "m0"' in sql


def test_kpi_composite_avg_per_day_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "sum",
                    "outer_agg": "avg",
                    "value_column": "kwh",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT AVG("bucket_value") AS "m0"' in sql
    assert "DATE_TRUNC('day', \"data\")" in sql
    assert 'SUM("kwh") AS "bucket_value"' in sql


def test_kpi_composite_avg_count_per_day_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "count",
                    "outer_agg": "avg",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT AVG("bucket_value") AS "m0"' in sql
    assert "DATE_TRUNC('day', \"data\")" in sql
    assert "COUNT(*) AS \"bucket_value\"" in sql


def test_kpi_composite_sum_of_daily_sum_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "agg_over_time_bucket",
                    "inner_agg": "sum",
                    "outer_agg": "sum",
                    "value_column": "kwh",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT SUM("bucket_value") AS "m0"' in sql
    assert 'SUM("kwh") AS "bucket_value"' in sql


def test_kpi_composite_legacy_agg_defaults_outer_avg_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "kpi",
                "view_name": "public.vw_recargas",
                "composite_metric": {
                    "type": "avg_per_time_bucket",
                    "agg": "sum",
                    "value_column": "kwh",
                    "time_column": "data",
                    "granularity": "day",
                },
                "metrics": [],
                "dimensions": [],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT AVG("bucket_value") AS "m0"' in sql
    assert 'SUM("kwh") AS "bucket_value"' in sql


def test_line_recargas_por_dia_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "line",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "time": {"column": "data", "granularity": "day"},
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert "DATE_TRUNC('day', \"data\")" in sql
    assert 'ORDER BY "time_bucket" ASC' in sql


def test_bar_recargas_por_estacao_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "bar",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": ["estacao"],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT "estacao", COUNT("id_recarga") AS "m0"' in sql
    assert 'GROUP BY "estacao"' in sql


def test_bar_top_n_applies_limit() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "bar",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "valor"}],
                "dimensions": ["estacao"],
                "filters": [],
                "order_by": [{"metric_ref": "m0", "direction": "desc"}],
                "top_n": 5,
            }
        )
    )
    assert "LIMIT 5" in sql


def test_table_query_with_columns_limit_offset() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "table",
                "view_name": "public.vw_recargas",
                "metrics": [],
                "dimensions": [],
                "columns": ["id_recarga", "estacao", "data", "kwh", "valor"],
                "filters": [],
                "order_by": [{"column": "data", "direction": "desc"}],
                "limit": 25,
                "offset": 50,
            }
        )
    )
    assert 'SELECT "id_recarga", "estacao", "data", "kwh", "valor"' in sql
    assert 'ORDER BY "data" DESC' in sql
    assert "LIMIT 25" in sql
    assert "OFFSET 50" in sql


def test_text_widget_has_no_query_builder_support() -> None:
    with pytest.raises(ValueError):
        build_widget_query(
            _cfg(
                {
                    "widget_type": "text",
                    "view_name": "public.vw_recargas",
                    "text_style": {"content": "Titulo", "font_size": 18, "align": "left"},
                    "metrics": [],
                    "dimensions": [],
                    "filters": [],
                    "order_by": [],
                }
            )
        )


def test_kpi_batch_query_builds_multiple_metrics() -> None:
    sql, params, aliases = build_kpi_batch_query(
        "public.vw_recargas",
        [
            _cfg({"widget_type": "kpi", "view_name": "public.vw_recargas", "metrics": [{"op": "count", "column": "id_recarga"}]}).metrics[0],
            _cfg({"widget_type": "kpi", "view_name": "public.vw_recargas", "metrics": [{"op": "sum", "column": "kwh"}]}).metrics[0],
        ],
        [],
    )
    assert 'COUNT("id_recarga") AS "m0"' in sql
    assert 'SUM("kwh") AS "m1"' in sql
    assert params == []
    assert aliases == ["m0", "m1"]


def test_kpi_batch_query_builds_multiple_composite_metrics() -> None:
    composite_count = _cfg(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "count",
                "outer_agg": "avg",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    ).composite_metric
    composite_sum = _cfg(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "sum",
                "outer_agg": "avg",
                "value_column": "kwh",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    ).composite_metric
    assert composite_count is not None
    assert composite_sum is not None

    sql, params, aliases = build_kpi_batch_query(
        "public.vw_recargas",
        [],
        [],
        composite_metrics=[composite_count, composite_sum],
    )
    assert 'SELECT AVG("bucket_0") AS "m0", AVG("bucket_1") AS "m1"' in sql
    assert "DATE_TRUNC('day', \"data\") AS \"time_bucket\"" in sql
    assert 'COUNT(*) AS "bucket_0"' in sql
    assert 'SUM("kwh") AS "bucket_1"' in sql
    assert 'GROUP BY "time_bucket"' in sql
    assert params == []
    assert aliases == ["m0", "m1"]
