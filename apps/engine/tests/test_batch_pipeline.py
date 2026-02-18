import asyncio

import pytest

from app.datasources.postgres import PostgresAdapter
from app.schemas import QuerySpec
from app.services.pipeline import QueryPipeline
from app.settings import Settings


def test_batch_executes_once_for_equivalent_specs(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["m0"], [{"m0": 42}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_a = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
        }
    )
    spec_b = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"agg": "count", "field": "id"}],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
        }
    )

    response = asyncio.run(
        pipeline.execute_batch(
            specs=[("w1", spec_a), ("w2", spec_b)],
            datasource_url="postgresql://fake",
            correlation_id="corr-1",
        )
    )

    assert response.executed_count == 1
    assert response.deduped_count == 1
    assert len(response.results) == 2
    assert response.results[0].request_id == "w1"
    assert response.results[1].request_id == "w2"
    assert calls["count"] == 1


def test_batch_cache_and_ordering(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        return ["m0"], [{"m0": calls["count"]}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_1 = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
        }
    )
    spec_2 = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
        }
    )

    first = asyncio.run(
        pipeline.execute_batch(
            specs=[("a", spec_1), ("b", spec_2)],
            datasource_url="postgresql://fake",
        )
    )
    second = asyncio.run(
        pipeline.execute_batch(
            specs=[("b", spec_2), ("a", spec_1)],
            datasource_url="postgresql://fake",
        )
    )

    assert first.executed_count == 1
    assert second.cache_hit_count == 2
    assert second.results[0].request_id == "b"
    assert second.results[1].request_id == "a"
    assert calls["count"] == 1


def test_batch_fuses_kpi_metrics_and_demuxes(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        assert '"m0"' in sql
        assert '"m1"' in sql
        return ["m0", "m1"], [{"m0": 10, "m1": 25}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_count = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
        }
    )
    spec_sum = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
        }
    )

    response = asyncio.run(
        pipeline.execute_batch(
            specs=[("w1", spec_count), ("w2", spec_sum)],
            datasource_url="postgresql://fake",
            correlation_id="corr-fusion-kpi",
        )
    )

    assert response.executed_count == 1
    assert calls["count"] == 1
    assert response.results[0].result.columns == ["m0"]
    assert response.results[0].result.rows == [{"m0": 10}]
    assert response.results[1].result.columns == ["m0"]
    assert response.results[1].result.rows == [{"m0": 25}]
    assert response.results[0].result.deduped is True
    assert response.results[1].result.deduped is True


def test_batch_fuses_line_series_with_same_time_bucket_and_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        assert '"time_bucket"' in sql
        return (
            ["time_bucket", "estacao", "m0", "m1"],
            [
                {"time_bucket": "2026-02-17T00:00:00", "estacao": "SP", "m0": 3, "m1": 120.0},
                {"time_bucket": "2026-02-18T00:00:00", "estacao": "SP", "m0": 4, "m1": 150.0},
            ],
        )

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_count = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [{"field": "id", "agg": "count"}],
            "dimensions": ["estacao"],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
            "time": {"column": "created_at", "granularity": "day"},
        }
    )
    spec_sum = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "line",
            "metrics": [{"field": "value", "agg": "sum"}],
            "dimensions": ["estacao"],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
            "time": {"column": "created_at", "granularity": "day"},
        }
    )

    response = asyncio.run(
        pipeline.execute_batch(
            specs=[("w1", spec_count), ("w2", spec_sum)],
            datasource_url="postgresql://fake",
            correlation_id="corr-fusion-line",
        )
    )

    assert response.executed_count == 1
    assert calls["count"] == 1
    assert response.results[0].result.columns == ["time_bucket", "estacao", "m0"]
    assert response.results[0].result.rows[0]["m0"] == 3
    assert response.results[1].result.columns == ["time_bucket", "estacao", "m0"]
    assert response.results[1].result.rows[0]["m0"] == 120.0


def test_batch_does_not_fuse_when_filters_differ(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = timeout_seconds
        calls["count"] += 1
        if params == ["SP"]:
            return ["m0"], [{"m0": 7}]
        return ["m0"], [{"m0": 11}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_sp = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
            "filters": [{"field": "region", "op": "eq", "value": "SP"}],
        }
    )
    spec_rj = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
            "filters": [{"field": "region", "op": "eq", "value": "RJ"}],
        }
    )

    response = asyncio.run(
        pipeline.execute_batch(
            specs=[("w1", spec_sp), ("w2", spec_rj)],
            datasource_url="postgresql://fake",
            correlation_id="corr-fallback-incompatible",
        )
    )

    assert response.executed_count == 2
    assert calls["count"] == 2
    assert response.results[0].result.rows == [{"m0": 7}]
    assert response.results[1].result.rows == [{"m0": 11}]


def test_batch_executes_independent_groups_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    state = {"active": 0, "max_active": 0, "count": 0}
    lock = asyncio.Lock()

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = timeout_seconds
        async with lock:
            state["active"] += 1
            state["count"] += 1
            if state["active"] > state["max_active"]:
                state["max_active"] = state["active"]
        await asyncio.sleep(0.03)
        async with lock:
            state["active"] -= 1
        return ["m0"], [{"m0": params[0]}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test", engine_batch_execution_concurrency_limit=3)
    pipeline = QueryPipeline(settings)

    specs = [
        (
            "w1",
            QuerySpec.model_validate(
                {
                    "resource_id": "public.vw_sales",
                    "widget_type": "kpi",
                    "metrics": [{"field": "id", "agg": "count"}],
                    "filters": [{"field": "region", "op": "eq", "value": "SP"}],
                }
            ),
        ),
        (
            "w2",
            QuerySpec.model_validate(
                {
                    "resource_id": "public.vw_sales",
                    "widget_type": "kpi",
                    "metrics": [{"field": "id", "agg": "count"}],
                    "filters": [{"field": "region", "op": "eq", "value": "RJ"}],
                }
            ),
        ),
        (
            "w3",
            QuerySpec.model_validate(
                {
                    "resource_id": "public.vw_sales",
                    "widget_type": "kpi",
                    "metrics": [{"field": "id", "agg": "count"}],
                    "filters": [{"field": "region", "op": "eq", "value": "MG"}],
                }
            ),
        ),
    ]

    response = asyncio.run(
        pipeline.execute_batch(
            specs=specs,
            datasource_url="postgresql://fake",
            correlation_id="corr-concurrency",
        )
    )

    assert response.executed_count == 3
    assert state["count"] == 3
    assert state["max_active"] >= 2


def test_batch_fallbacks_to_individual_on_fused_execution_error(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"count": 0}

    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = params
        _ = timeout_seconds
        calls["count"] += 1
        if '"m1"' in sql:
            raise RuntimeError("forced fused failure")
        if "COUNT" in sql:
            return ["m0"], [{"m0": 7}]
        return ["m0"], [{"m0": 11}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)

    spec_count = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
        }
    )
    spec_sum = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "value", "agg": "sum"}],
        }
    )

    response = asyncio.run(
        pipeline.execute_batch(
            specs=[("w1", spec_count), ("w2", spec_sum)],
            datasource_url="postgresql://fake",
            correlation_id="corr-fallback-runtime",
        )
    )

    assert response.executed_count == 2
    assert calls["count"] == 3
    assert response.results[0].result.rows == [{"m0": 7}]
    assert response.results[1].result.rows == [{"m0": 11}]


def test_batch_log_redacts_datasource_password(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    async def fake_execute(self, *, sql: str, params: list[object], timeout_seconds: int):
        _ = self
        _ = sql
        _ = params
        _ = timeout_seconds
        return ["m0"], [{"m0": 1}]

    monkeypatch.setattr(PostgresAdapter, "execute", fake_execute)
    caplog.set_level("INFO", logger="uvicorn.error")

    settings = Settings(environment="test")
    pipeline = QueryPipeline(settings)
    spec = QuerySpec.model_validate(
        {
            "resource_id": "public.vw_sales",
            "widget_type": "kpi",
            "metrics": [{"field": "id", "agg": "count"}],
        }
    )

    datasource_url = "postgresql://analytics_user:super-secret@db.example.com:5432/analytics"
    asyncio.run(
        pipeline.execute_batch(
            specs=[("a", spec)],
            datasource_url=datasource_url,
            correlation_id="corr-1",
        )
    )

    rendered_logs = "\n".join(caplog.messages)
    assert "super-secret" not in rendered_logs
    assert "postgresql://analytics_user:***@db.example.com:5432/analytics" in rendered_logs
