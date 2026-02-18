import pytest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.modules.widgets.application.query_builder import build_kpi_batch_query, build_widget_query
from app.modules.widgets.domain.config import WidgetConfig


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


def test_column_top_n_applies_limit() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "column",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "valor"}],
                "dimensions": ["estacao"],
                "filters": [],
                "order_by": [{"metric_ref": "m0", "direction": "desc"}],
                "top_n": 7,
            }
        )
    )
    assert "LIMIT 7" in sql


def test_donut_query_with_dimension_and_metric() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "donut",
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


def test_dre_query_builds_metric_columns() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "dre",
                "view_name": "public.vw_recargas",
                "metrics": [],
                "dimensions": [],
                "dre_rows": [
                    {
                        "title": "Faturamento",
                        "row_type": "result",
                        "metrics": [{"op": "sum", "column": "valor"}, {"op": "sum", "column": "kwh"}],
                    },
                    {"title": "Deducoes", "row_type": "deduction", "metrics": [{"op": "sum", "column": "kwh"}]},
                ],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert 'SELECT (COALESCE(SUM("valor"), 0) + COALESCE(SUM("kwh"), 0)) AS "m0", (COALESCE(SUM("kwh"), 0)) AS "m1"' in sql
    assert 'FROM "public"."vw_recargas"' in sql
    assert "LIMIT 1" in sql


def test_bar_week_dimension_token_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "bar",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": ["__time_week__:data"],
                "filters": [],
                "order_by": [{"column": "__time_week__:data", "direction": "asc"}],
            }
        )
    )
    assert "EXTRACT(WEEK FROM \"data\")" in sql
    assert '"__time_week__:data"' in sql
    assert 'ORDER BY MIN(EXTRACT(WEEK FROM "data")) ASC' in sql


def test_column_month_dimension_token_query() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "column",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "valor"}],
                "dimensions": ["__time_month__:data"],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert "TO_CHAR(DATE_TRUNC('month', \"data\"), 'YYYY-MM')" in sql
    assert '"__time_month__:data"' in sql


def test_bar_weekday_dimension_default_orders_by_isodow() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "bar",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": ["__time_weekday__:data"],
                "filters": [],
                "order_by": [],
            }
        )
    )
    assert "EXTRACT(ISODOW FROM \"data\")::int" in sql
    assert "ORDER BY MIN(EXTRACT(ISODOW FROM \"data\")) ASC" in sql


def test_column_month_dimension_order_uses_group_safe_expression() -> None:
    sql, _ = build_widget_query(
        _cfg(
            {
                "widget_type": "column",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "sum", "column": "valor"}],
                "dimensions": ["__time_month__:data"],
                "filters": [],
                "order_by": [{"column": "__time_month__:data", "direction": "asc"}],
            }
        )
    )
    assert "ORDER BY MIN(DATE_TRUNC('month', \"data\")) ASC" in sql


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


def test_relative_filter_this_year_resolves_to_between_dates() -> None:
    sql, params = build_widget_query(
        _cfg(
            {
                "widget_type": "line",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "time": {"column": "data", "granularity": "day"},
                "filters": [{"column": "data", "op": "between", "value": {"relative": "this_year"}}],
                "order_by": [],
            }
        )
    )
    today = datetime.now(ZoneInfo("America/Sao_Paulo")).date()
    assert "BETWEEN" in sql
    assert len(params) == 2
    assert params[0] == today.replace(month=1, day=1).isoformat()
    assert params[1] == (today + timedelta(days=1)).isoformat()


def test_lte_date_filter_increments_day_by_one() -> None:
    sql, params = build_widget_query(
        _cfg(
            {
                "widget_type": "line",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": [],
                "time": {"column": "data", "granularity": "day"},
                "filters": [{"column": "data", "op": "lte", "value": "2026-02-10"}],
                "order_by": [],
            }
        )
    )
    assert '"data" <=' in sql
    assert params == ["2026-02-11"]


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

