from datetime import datetime, timedelta

from app.models import Dashboard, DashboardWidget
from app.routers.dashboards import _combined_load_score, _dashboard_load_score, _runtime_score, _widget_load_cost


def _widget(*, widget_type: str, query_config: dict) -> DashboardWidget:
    return DashboardWidget(
        dashboard_id=1,
        widget_type=widget_type,
        title="w",
        position=0,
        query_config=query_config,
        config_version=1,
    )


def test_bar_top_n_reduces_complexity_score() -> None:
    without_top = _widget(
        widget_type="bar",
        query_config={
            "widget_type": "bar",
            "metrics": [{"op": "sum", "column": "valor"}],
            "dimensions": ["estacao"],
            "filters": [],
            "order_by": [{"metric_ref": "m0", "direction": "desc"}],
        },
    )
    with_top = _widget(
        widget_type="bar",
        query_config={
            "widget_type": "bar",
            "metrics": [{"op": "sum", "column": "valor"}],
            "dimensions": ["estacao"],
            "filters": [],
            "order_by": [{"metric_ref": "m0", "direction": "desc"}],
            "top_n": 5,
        },
    )

    assert _widget_load_cost(with_top) < _widget_load_cost(without_top)


def test_runtime_score_increases_with_latency() -> None:
    low, _ = _runtime_score([80, 90, 100, 120])
    high, _ = _runtime_score([800, 900, 1200, 1500])
    assert low is not None and high is not None
    assert high > low


def test_combined_load_score_uses_runtime_when_recent_and_covered() -> None:
    recent = datetime.utcnow() - timedelta(hours=2)
    score = _combined_load_score(
        complexity_score=30.0,
        runtime_score=80.0,
        telemetry_coverage=1.0,
        last_widget_executed_at=recent,
    )
    assert score > 60.0


def test_dashboard_load_score_is_average_widget_complexity() -> None:
    dashboard = Dashboard(dataset_id=1, name="d", layout_config=[])
    w1 = _widget(widget_type="kpi", query_config={"widget_type": "kpi", "metrics": [{"op": "count", "column": "id"}]})
    w2 = _widget(widget_type="table", query_config={"widget_type": "table", "columns": ["a", "b"], "table_page_size": 50})
    dashboard.widgets = [w1, w2]

    score = _dashboard_load_score(dashboard)
    assert score == round((_widget_load_cost(w1) + _widget_load_cost(w2)) / 2.0, 1)
