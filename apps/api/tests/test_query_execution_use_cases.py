from app.modules.query_execution import PostgresQueryCompilerAdapter, QueryBuilderService
from app.schemas import QuerySpec
from app.widget_config import WidgetConfig


def test_query_builder_service_compiles_widget_kpi() -> None:
    builder = QueryBuilderService(PostgresQueryCompilerAdapter())
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_sales",
            "metrics": [{"op": "count", "column": "id"}],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    sql, params = builder.compile_widget(config)
    assert 'SELECT COUNT("id") AS "m0"' in sql
    assert 'FROM "public"."vw_sales"' in sql
    assert params == []


def test_query_builder_service_compiles_api_query_spec() -> None:
    builder = QueryBuilderService(PostgresQueryCompilerAdapter())
    spec = QuerySpec(
        datasetId=1,
        metrics=[{"field": "*", "agg": "count"}],
        dimensions=[],
        filters=[],
        sort=[],
        limit=10,
        offset=0,
    )
    sql, params = builder.compile_query_spec(spec, "public.vw_sales")
    assert "COUNT(*) AS" in sql
    assert "LIMIT 10" in sql
    assert params == []

