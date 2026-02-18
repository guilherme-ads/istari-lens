import asyncio

import pytest

from app.datasources.postgres import PostgresAdapter
from app.schemas import QuerySpec
from app.services.pipeline import QueryPipeline
from app.settings import Settings


def _line_spec(*, metrics: list[dict], dimensions: list[str] | None = None, filters: list[dict] | None = None, order_by: list[dict] | None = None, sort: list[dict] | None = None, time: dict | None = None, top_n: int | None = None) -> QuerySpec:
    return QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": metrics,
            "dimensions": dimensions or ["estacao"],
            "filters": filters or [{"field": "region", "op": "eq", "value": "SP"}],
            "order_by": order_by or [],
            "sort": sort or [],
            "top_n": top_n,
            "time": time or {"column": "created_at", "granularity": "day"},
        }
    )


def _kpi_spec(*, metrics: list[dict], filters: list[dict] | None = None, time: dict | None = None, top_n: int | None = None) -> QuerySpec:
    return QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": metrics,
            "filters": filters or [],
            "time": time,
            "top_n": top_n,
        }
    )


def test_line_fuses_with_different_order_and_reorders_per_widget(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = timeout_seconds
        calls["count"] += 1
        assert "ORDER BY \"time_bucket\" ASC" in sql
        assert params == ["SP"]
        return (
            ["time_bucket", "estacao", "m0", "m1"],
            [
                {"time_bucket": "2026-02-17T00:00:00", "estacao": "SP", "m0": 1, "m1": 1},
                {"time_bucket": "2026-02-18T00:00:00", "estacao": "SP", "m0": 2, "m1": 2},
            ],
        )

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    asc = _line_spec(metrics=[{"field": "id", "agg": "count"}], order_by=[{"column": "time_bucket", "direction": "asc"}])
    desc = _line_spec(metrics=[{"field": "value", "agg": "sum"}], order_by=[{"column": "time_bucket", "direction": "desc"}])

    response = asyncio.run(pipeline.execute_batch(specs=[("a", asc), ("b", desc)], datasource_url="postgresql://fake"))
    assert response.executed_count == 1
    assert calls["count"] == 1
    assert [row["time_bucket"] for row in response.results[0].result.rows] == ["2026-02-17T00:00:00", "2026-02-18T00:00:00"]
    assert [row["time_bucket"] for row in response.results[1].result.rows] == ["2026-02-18T00:00:00", "2026-02-17T00:00:00"]


def test_line_fuses_with_dimension_reorder(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = timeout_seconds
        calls["count"] += 1
        assert params == ["SP"]
        return (
            ["time_bucket", "estacao", "regiao", "m0", "m1"],
            [{"time_bucket": "2026-02-17T00:00:00", "estacao": "SP", "regiao": "Sudeste", "m0": 3, "m1": 10.5}],
        )

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    first = _line_spec(metrics=[{"field": "id", "agg": "count"}], dimensions=["estacao", "regiao"])
    second = _line_spec(metrics=[{"field": "value", "agg": "sum"}], dimensions=["regiao", "estacao"])

    response = asyncio.run(pipeline.execute_batch(specs=[("a", first), ("b", second)], datasource_url="postgresql://fake"))
    assert response.executed_count == 1
    assert calls["count"] == 1
    assert response.results[1].result.columns[:3] == ["time_bucket", "estacao", "regiao"]


def test_kpi_with_time_present_and_absent_does_not_fuse(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = timeout_seconds
        calls["count"] += 1
        if "COUNT" in sql:
            return ["m0"], [{"m0": 5}]
        return ["m0"], [{"m0": 20}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    with_time = _kpi_spec(metrics=[{"field": "id", "agg": "count"}], filters=[{"field": "region", "op": "eq", "value": "SP"}], time={"column": "created_at", "granularity": "day"})
    without_time = _kpi_spec(metrics=[{"field": "value", "agg": "sum"}], filters=[{"field": "region", "op": "eq", "value": "SP"}])

    response = asyncio.run(pipeline.execute_batch(specs=[("a", with_time), ("b", without_time)], datasource_url="postgresql://fake"))
    assert response.executed_count == 2
    assert calls["count"] == 2


def test_line_supports_multiple_metrics_per_widget(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = timeout_seconds
        calls["count"] += 1
        assert '"m3"' in sql
        return (
            ["time_bucket", "estacao", "m0", "m1", "m2", "m3"],
            [{"time_bucket": "2026-02-18T00:00:00", "estacao": "SP", "m0": 1, "m1": 10.0, "m2": 2.5, "m3": 9}],
        )

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    first = _line_spec(metrics=[{"field": "id", "agg": "count"}, {"field": "value", "agg": "sum"}])
    second = _line_spec(metrics=[{"field": "value", "agg": "avg"}, {"field": "id", "agg": "max"}])
    response = asyncio.run(pipeline.execute_batch(specs=[("a", first), ("b", second)], datasource_url="postgresql://fake"))

    assert response.executed_count == 1
    assert calls["count"] == 1
    assert response.results[0].result.rows[0]["m0"] == 1
    assert response.results[0].result.rows[0]["m1"] == 10.0
    assert response.results[1].result.rows[0]["m0"] == 2.5
    assert response.results[1].result.rows[0]["m1"] == 9


def test_time_equivalence_accepts_casts_and_at_timezone(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = timeout_seconds
        calls["count"] += 1
        return ["time_bucket", "estacao", "m0", "m1"], [{"time_bucket": "2026-02-18T00:00:00", "estacao": "SP", "m0": 2, "m1": 8}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    first = _line_spec(metrics=[{"field": "id", "agg": "count"}], time={"column": "created_at at time zone 'UTC'", "granularity": "day"})
    second = _line_spec(metrics=[{"field": "value", "agg": "sum"}], time={"column": "created_at::timestamp", "granularity": "day"})

    response = asyncio.run(pipeline.execute_batch(specs=[("a", first), ("b", second)], datasource_url="postgresql://fake"))
    assert response.executed_count == 1
    assert calls["count"] == 1


def test_different_time_granularity_does_not_fuse(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["time_bucket", "estacao", "m0"], [{"time_bucket": "2026-02-18T00:00:00", "estacao": "SP", "m0": calls["count"]}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    by_day = _line_spec(metrics=[{"field": "id", "agg": "count"}], time={"column": "created_at", "granularity": "day"})
    by_month = _line_spec(metrics=[{"field": "value", "agg": "sum"}], time={"column": "created_at", "granularity": "month"})

    response = asyncio.run(pipeline.execute_batch(specs=[("a", by_day), ("b", by_month)], datasource_url="postgresql://fake"))
    assert response.executed_count == 2
    assert calls["count"] == 2


def test_top_n_explicitly_skips_fusion_with_log(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["m0"], [{"m0": calls["count"]}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    caplog.set_level("INFO", logger="uvicorn.error")
    pipeline = QueryPipeline(Settings(environment="test"))

    left = _kpi_spec(metrics=[{"field": "id", "agg": "count"}], top_n=10)
    right = _kpi_spec(metrics=[{"field": "value", "agg": "sum"}], top_n=10)
    response = asyncio.run(pipeline.execute_batch(specs=[("a", left), ("b", right)], datasource_url="postgresql://fake"))

    assert response.executed_count == 2
    assert calls["count"] == 2
    assert "top_n_present" in "\n".join(caplog.messages)


def test_partial_fallback_fuses_compatible_subset(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        if calls["count"] == 1:
            assert '"m3"' in sql
            return ["m0", "m1", "m2", "m3"], [{"m0": 1, "m1": 2, "m2": 3, "m3": 4}]
        return ["m0"], [{"m0": 99}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    compatible = [
        _kpi_spec(metrics=[{"field": "id", "agg": "count"}]),
        _kpi_spec(metrics=[{"field": "value", "agg": "sum"}]),
        _kpi_spec(metrics=[{"field": "value", "agg": "avg"}]),
        _kpi_spec(metrics=[{"field": "id", "agg": "max"}]),
    ]
    incompatible = _kpi_spec(metrics=[{"field": "id", "agg": "count"}], top_n=5)
    payload = [("w1", compatible[0]), ("w2", compatible[1]), ("w3", compatible[2]), ("w4", compatible[3]), ("w5", incompatible)]

    response = asyncio.run(pipeline.execute_batch(specs=payload, datasource_url="postgresql://fake"))
    assert response.executed_count == 2
    assert calls["count"] == 2
    assert response.results[-1].result.rows == [{"m0": 99}]


def test_fused_cache_key_reuses_group_result(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["m0", "m1"], [{"m0": 4, "m1": 8}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    left = _kpi_spec(metrics=[{"field": "id", "agg": "count"}], filters=[{"field": "region", "op": "eq", "value": "SP"}])
    right = _kpi_spec(metrics=[{"field": "value", "agg": "sum"}], filters=[{"field": "region", "op": "eq", "value": "SP"}])
    specs = [("a", left), ("b", right)]

    first = asyncio.run(pipeline.execute_batch(specs=specs, datasource_url="postgresql://fake"))
    assert first.executed_count == 1
    assert calls["count"] == 1

    fusion_keys = [key for key in pipeline._cache if key.startswith("cache:fusion:")]  # noqa: SLF001
    assert fusion_keys
    pipeline._cache = type(pipeline._cache)((k, v) for k, v in pipeline._cache.items() if k.startswith("cache:fusion:"))  # noqa: SLF001

    second = asyncio.run(pipeline.execute_batch(specs=specs, datasource_url="postgresql://fake"))
    assert second.executed_count == 0
    assert second.cache_hit_count == 2
    assert calls["count"] == 1


def test_dashboard_fixture_has_saved_executions_target(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["m0", "m1", "m2"], [{"m0": 1, "m1": 2, "m2": 3}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    pipeline = QueryPipeline(Settings(environment="test"))

    fixtures = [
        ("w1", _kpi_spec(metrics=[{"field": "id", "agg": "count"}], filters=[{"field": "region", "op": "eq", "value": "SP"}])),
        ("w2", _kpi_spec(metrics=[{"field": "value", "agg": "sum"}], filters=[{"field": "region", "op": "eq", "value": "SP"}])),
        ("w3", _kpi_spec(metrics=[{"field": "id", "agg": "count"}], filters=[{"field": "region", "op": "eq", "value": "SP"}, {"field": "canal", "op": "eq", "value": "mobile"}])),
        ("w4", _line_spec(metrics=[{"field": "id", "agg": "count"}], dimensions=["estacao"])),
        ("w5", _line_spec(metrics=[{"field": "value", "agg": "sum"}], dimensions=["estacao"])),
        ("w6", _line_spec(metrics=[{"field": "id", "agg": "count"}], dimensions=["estacao"])),
    ]

    response = asyncio.run(pipeline.execute_batch(specs=fixtures, datasource_url="postgresql://fake"))
    saved_executions = response.batch_size - response.executed_count
    assert saved_executions >= 3
    assert calls["count"] == response.executed_count
