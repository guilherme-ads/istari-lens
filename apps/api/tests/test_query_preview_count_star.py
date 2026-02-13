import asyncio

from app.models import View, ViewColumn
from app.routers.queries import build_query_sql, validate_query_spec
from app.schemas import QuerySpec


def _make_view() -> View:
    view = View(schema_name="public", view_name="vw_growth_users")
    view.columns = [
        ViewColumn(
            column_name="id",
            column_type="integer",
            is_aggregatable=True,
            is_filterable=True,
            is_groupable=True,
        )
    ]
    return view


def test_build_query_sql_uses_count_star() -> None:
    spec = QuerySpec(
        datasetId=1,
        metrics=[{"field": "*", "agg": "count"}],
        dimensions=[],
        filters=[],
        sort=[],
        limit=1,
        offset=0,
    )

    sql, params = build_query_sql(spec, _make_view())

    assert "SELECT COUNT(*)" in sql
    assert "FROM public.vw_growth_users" in sql
    assert params == []


def test_validate_query_spec_accepts_count_star() -> None:
    spec = QuerySpec(
        datasetId=1,
        metrics=[{"field": "*", "agg": "count"}],
        dimensions=[],
        filters=[],
        sort=[],
        limit=1,
        offset=0,
    )

    asyncio.run(validate_query_spec(spec, _make_view(), db=None))  # type: ignore[arg-type]
