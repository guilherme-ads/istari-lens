from app.schemas import QuerySpec
from app.services.compiler import compile_query


def test_table_widget_applies_limit() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "table",
            "columns": ["id"],
            "limit": 25,
        }
    )
    sql, _params, row_limit = compile_query(spec, max_rows=5000)
    assert "LIMIT 25" in sql
    assert row_limit == 25


def test_non_table_widget_ignores_limit() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [{"field": "id", "agg": "count"}],
            "time": {"column": "created_at", "granularity": "day"},
            "limit": 10,
        }
    )
    sql, _params, row_limit = compile_query(spec, max_rows=5000)
    assert "LIMIT" not in sql
    assert row_limit == 5000


def test_top_n_keeps_limit_for_categorical_widgets() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "bar",
            "metrics": [{"field": "id", "agg": "count"}],
            "dimensions": ["region"],
            "top_n": 7,
        }
    )
    sql, _params, row_limit = compile_query(spec, max_rows=5000)
    assert "LIMIT 7" in sql
    assert row_limit == 7
