from app.modules.datasets.preaggregation import (
    build_rollup_table_name,
    can_apply_rollup_to_query_spec,
    resolve_rollup_plan_for_widget,
    rewrite_query_spec_for_rollup,
)
from app.modules.widgets.domain.config import WidgetConfig


def test_resolve_rollup_plan_for_widget_builds_metric_mapping() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "line",
            "view_name": "__dataset_base",
            "metrics": [
                {"op": "sum", "column": "valor"},
                {"op": "count", "column": "id_recarga"},
            ],
            "dimensions": ["estacao"],
            "time": {"column": "created_at", "granularity": "day"},
            "filters": [{"column": "status", "op": "eq", "value": "active"}],
            "order_by": [],
        }
    )

    plan = resolve_rollup_plan_for_widget(config)
    assert plan is not None
    assert plan.time_column == "created_at"
    assert plan.group_columns == ["estacao", "created_at", "status"]
    assert len(plan.metric_mappings) == 2
    assert plan.metric_mappings[0].source_op == "sum"
    assert plan.metric_mappings[0].query_agg == "sum"
    assert plan.metric_mappings[1].source_op == "count"
    assert plan.metric_mappings[1].query_agg == "sum"


def test_rewrite_query_spec_for_rollup_replaces_resource_and_metrics() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "__dataset_base",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    plan = resolve_rollup_plan_for_widget(config)
    assert plan is not None

    query_spec = {
        "resource_id": "__dataset_base",
        "widget_type": "kpi",
        "metrics": [{"field": "id_recarga", "agg": "count", "alias": "m0"}],
        "dimensions": [],
        "filters": [],
        "order_by": [],
        "offset": 0,
    }
    rewritten = rewrite_query_spec_for_rollup(
        query_spec=query_spec,
        plan=plan,
        resource_id="lens_imp_t1.ds_7__clientes__rollup_deadbeef01",
    )
    assert rewritten["resource_id"] == "lens_imp_t1.ds_7__clientes__rollup_deadbeef01"
    assert rewritten["metrics"][0]["agg"] == "sum"
    assert rewritten["metrics"][0]["field"] == plan.metric_mappings[0].rollup_column


def test_can_apply_rollup_to_query_spec_rejects_unknown_filter_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "bar",
            "view_name": "__dataset_base",
            "metrics": [{"op": "sum", "column": "valor"}],
            "dimensions": ["estacao"],
            "filters": [],
            "order_by": [],
        }
    )
    plan = resolve_rollup_plan_for_widget(config)
    assert plan is not None
    assert can_apply_rollup_to_query_spec(
        plan=plan,
        query_spec={
            "metrics": [{"field": "valor", "agg": "sum"}],
            "dimensions": ["estacao"],
            "filters": [{"field": "status", "op": "eq", "value": "active"}],
        },
    ) is False


def test_build_rollup_table_name_contains_rollup_suffix() -> None:
    table_name = build_rollup_table_name(dataset_id=7, dataset_name="Clientes", signature="abc123def456")
    assert table_name.startswith("ds_7__clientes__rollup_")
