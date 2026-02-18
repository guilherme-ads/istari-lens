from app.schemas import QuerySpec
from app.services.canonicalizer import build_query_keys


def test_canonicalization_equivalent_specs_generate_same_keys() -> None:
    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "metrics": [{"field": "value", "agg": "sum"}, {"field": "id", "agg": "count"}],
            "dimensions": ["region", "channel"],
            "filters": [
                {"field": "year", "op": "eq", "value": "2025"},
                {"field": "region", "op": "in", "value": ["B", "A"]},
            ],
            "limit": 500,
            "offset": 0,
            "timezone": "UTC",
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "metrics": [{"agg": "count", "field": "id"}, {"agg": "sum", "field": "value"}],
            "dimensions": ["channel", "region"],
            "filters": [
                {"field": "region", "op": "in", "value": ["A", "B"]},
                {"field": "year", "op": "eq", "value": 2025},
            ],
            "limit": 500,
            "offset": 0,
        }
    )

    _, dedupe_a, cache_a = build_query_keys(spec=spec_a, datasource_url="postgresql://x")
    _, dedupe_b, cache_b = build_query_keys(spec=spec_b, datasource_url="postgresql://x")

    assert dedupe_a == dedupe_b
    assert cache_a == cache_b


def test_canonicalization_different_specs_do_not_collide() -> None:
    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "metrics": [{"field": "value", "agg": "sum"}],
            "limit": 100,
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "metrics": [{"field": "value", "agg": "sum"}],
            "limit": 200,
        }
    )

    _, dedupe_a, cache_a = build_query_keys(spec=spec_a, datasource_url="postgresql://x")
    _, dedupe_b, cache_b = build_query_keys(spec=spec_b, datasource_url="postgresql://x")

    assert dedupe_a != dedupe_b
    assert cache_a != cache_b


def test_canonicalization_ignores_limit_for_non_table_widgets() -> None:
    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
            "limit": 100,
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
            "limit": 200,
        }
    )

    _, dedupe_a, cache_a = build_query_keys(spec=spec_a, datasource_url="postgresql://x")
    _, dedupe_b, cache_b = build_query_keys(spec=spec_b, datasource_url="postgresql://x")

    assert dedupe_a == dedupe_b
    assert cache_a == cache_b


def test_canonicalization_removes_duplicate_metrics_dimensions_and_filters() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [
                {"field": "id", "agg": "count"},
                {"field": "id", "agg": "count"},
            ],
            "dimensions": ["region", "region", "channel"],
            "filters": [
                {"field": "region", "op": "eq", "value": "SP"},
                {"field": "region", "op": "eq", "value": "SP"},
            ],
            "time": {"column": "created_at", "granularity": "day"},
        }
    )
    canonical, _dedupe, _cache = build_query_keys(spec=spec, datasource_url="postgresql://x")
    assert len(canonical["metrics"]) == 1
    assert canonical["dimensions"] == ["channel", "region"]
    assert len(canonical["filters"]) == 1


def test_canonicalization_normalizes_time_shape() -> None:
    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [{"field": "id", "agg": "count"}],
            "time": {"column": "DATE_TRUNC('day', created_at::timestamp)", "granularity": "day"},
            "timezone": "UTC",
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [{"field": "id", "agg": "count"}],
            "time": {"column": "created_at at time zone 'UTC'", "granularity": "day"},
            "timezone": "utc",
        }
    )

    _, dedupe_a, cache_a = build_query_keys(spec=spec_a, datasource_url="postgresql://x")
    _, dedupe_b, cache_b = build_query_keys(spec=spec_b, datasource_url="postgresql://x")
    assert dedupe_a == dedupe_b
    assert cache_a == cache_b


def test_canonicalization_preserves_dre_row_order() -> None:
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_dre",
            "widget_type": "dre",
            "dre_rows": [
                {"title": "Receita Bruta", "row_type": "result", "metrics": [{"field": "receita_bruta", "agg": "sum"}]},
                {"title": "Deducoes", "row_type": "deduction", "metrics": [{"field": "deducoes", "agg": "sum"}]},
            ],
        }
    )

    canonical, _dedupe, _cache = build_query_keys(spec=spec, datasource_url="postgresql://x")
    assert canonical["dre_rows"][0]["title"] == "Receita Bruta"
    assert canonical["dre_rows"][1]["title"] == "Deducoes"


def test_canonicalization_dre_row_order_affects_keys() -> None:
    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_dre",
            "widget_type": "dre",
            "dre_rows": [
                {"title": "Receita Bruta", "row_type": "result", "metrics": [{"field": "receita_bruta", "agg": "sum"}]},
                {"title": "Deducoes", "row_type": "deduction", "metrics": [{"field": "deducoes", "agg": "sum"}]},
            ],
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_dre",
            "widget_type": "dre",
            "dre_rows": [
                {"title": "Deducoes", "row_type": "deduction", "metrics": [{"field": "deducoes", "agg": "sum"}]},
                {"title": "Receita Bruta", "row_type": "result", "metrics": [{"field": "receita_bruta", "agg": "sum"}]},
            ],
        }
    )

    _, dedupe_a, cache_a = build_query_keys(spec=spec_a, datasource_url="postgresql://x")
    _, dedupe_b, cache_b = build_query_keys(spec=spec_b, datasource_url="postgresql://x")

    assert dedupe_a != dedupe_b
    assert cache_a != cache_b
