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


def test_kpi_derived_formula_compiles_with_nullif_division_guard() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [
                {"field": "customer_id", "agg": "distinct_count"},
                {"field": "id", "agg": "count"},
            ],
            "derived_metric": {
                "formula": "(m0 / m1) * 100",
                "dependencies": ["m0", "m1"],
                "on_divide_by_zero": "null",
            },
        }
    )
    sql, _params, row_limit = compile_query(spec, max_rows=5000)
    assert 'WITH "kpi_base"' in sql
    assert 'NULLIF(("m1")::double precision, 0)' in sql
    assert 'AS "m0"' in sql
    assert row_limit == 1


def test_kpi_derived_formula_compiles_with_named_aliases() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [
                {"field": "customer_id", "agg": "distinct_count", "alias": "clientes_ativos"},
                {"field": "id", "agg": "count", "alias": "clientes_totais"},
            ],
            "derived_metric": {
                "formula": "(clientes_ativos / clientes_totais) * 100",
                "dependencies": ["clientes_ativos", "clientes_totais"],
                "on_divide_by_zero": "null",
            },
        }
    )
    sql, _params, _row_limit = compile_query(spec, max_rows=5000)
    assert 'AS "clientes_ativos"' in sql
    assert 'AS "clientes_totais"' in sql
    assert '"clientes_ativos"' in sql
    assert '"clientes_totais"' in sql
