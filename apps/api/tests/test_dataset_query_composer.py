from datetime import datetime

from fastapi import HTTPException

from app.modules.core.legacy.models import Dataset, View
from app.modules.datasets import (
    build_legacy_base_query_spec,
    compose_engine_query_spec_with_dataset,
    resolve_dataset_base_query_spec,
)


def test_build_legacy_base_query_spec_uses_view_as_primary_resource() -> None:
    view = View(datasource_id=10, schema_name="public", view_name="vw_sales", is_active=True)

    payload = build_legacy_base_query_spec(datasource_id=10, view=view)

    assert payload["source"]["datasource_id"] == 10
    assert payload["base"]["primary_resource"] == "public.vw_sales"
    assert payload["base"]["resources"] == [{"id": "base", "resource_id": "public.vw_sales"}]


def test_resolve_dataset_base_query_spec_prefers_dataset_payload_and_returns_copy() -> None:
    original = {
        "version": 1,
        "source": {"datasource_id": 10},
        "base": {"primary_resource": "public.vw_sales", "resources": [{"id": "base", "resource_id": "public.vw_sales"}], "joins": []},
        "preprocess": {"columns": {"include": [], "exclude": []}, "computed_columns": [], "filters": []},
    }
    dataset = Dataset(datasource_id=10, name="Sales", base_query_spec=original, is_active=True)

    resolved = resolve_dataset_base_query_spec(dataset)
    resolved["source"]["datasource_id"] = 99

    assert dataset.base_query_spec["source"]["datasource_id"] == 10


def test_compose_engine_query_spec_with_dataset_injects_base_query_and_dataset_resource_id() -> None:
    base_query = {
        "version": 1,
        "source": {"datasource_id": 10},
        "base": {"primary_resource": "public.vw_sales", "resources": [{"id": "base", "resource_id": "public.vw_sales"}], "joins": []},
        "preprocess": {"columns": {"include": [], "exclude": []}, "computed_columns": [], "filters": []},
    }
    dataset = Dataset(datasource_id=10, name="Sales", base_query_spec=base_query, is_active=True)
    engine_spec = {
        "resource_id": "public.vw_sales",
        "metrics": [{"field": "*", "agg": "count"}],
        "dimensions": [],
        "filters": [],
        "sort": [],
        "limit": 10,
        "offset": 0,
    }

    composed = compose_engine_query_spec_with_dataset(dataset=dataset, query_spec=engine_spec)

    assert composed["resource_id"] == "__dataset_base"
    assert composed["base_query"] == base_query
    assert engine_spec["resource_id"] == "public.vw_sales"


def test_resolve_dataset_base_query_spec_raises_without_base_query_and_view() -> None:
    dataset = Dataset(datasource_id=10, name="Broken", is_active=True)

    try:
        resolve_dataset_base_query_spec(dataset)
        assert False, "expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "no base_query_spec" in str(exc.detail)


def test_compose_engine_query_spec_with_dataset_uses_transient_imported_runtime_binding() -> None:
    logical_base_query = {
        "version": 1,
        "source": {"datasource_id": 10},
        "base": {"primary_resource": "public.vw_sales", "resources": [{"id": "base", "resource_id": "public.vw_sales"}], "joins": []},
        "preprocess": {"columns": {"include": [], "exclude": []}, "computed_columns": [], "filters": []},
    }
    execution_view = View(datasource_id=99, schema_name="lens_imp_t1", view_name="ds_1", is_active=True)
    dataset = Dataset(
        datasource_id=10,
        name="Sales Imported",
        base_query_spec=logical_base_query,
        access_mode="imported",
        execution_datasource_id=99,
        execution_view_id=123,
        data_status="ready",
        last_successful_sync_at=datetime.utcnow(),
        is_active=True,
    )
    dataset.execution_view = execution_view
    engine_spec = {
        "resource_id": "public.vw_sales",
        "metrics": [{"field": "*", "agg": "count"}],
        "dimensions": [],
        "filters": [],
        "sort": [],
        "limit": 10,
        "offset": 0,
    }

    composed = compose_engine_query_spec_with_dataset(dataset=dataset, query_spec=engine_spec)

    assert composed["resource_id"] == "__dataset_base"
    assert composed["base_query"]["source"]["datasource_id"] == 99
    assert composed["base_query"]["base"]["primary_resource"] == "lens_imp_t1.ds_1"
    assert dataset.base_query_spec == logical_base_query
