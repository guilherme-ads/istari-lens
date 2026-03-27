from collections.abc import Generator
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.routes import datasets
from app.modules.auth.adapters.api.dependencies import get_current_admin_user, get_current_user
from app.modules.core.legacy.models import (
    Base,
    Dashboard,
    DashboardWidget,
    Dataset,
    DataSource,
    DatasetImportConfig,
    DatasetSyncRun,
    DatasetSyncSchedule,
    User,
    View,
    ViewColumn,
)


def _create_app() -> tuple[TestClient, sessionmaker, int, int, int, int]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session: Session = testing_session_local()
    user = User(email="datasets@test.com", hashed_password="x", is_admin=True, is_active=True)
    session.add(user)
    session.flush()

    datasource = DataSource(
        name="analytics",
        description="",
        database_url="postgresql://fake",
        created_by_id=user.id,
        is_active=True,
    )
    session.add(datasource)
    session.flush()

    view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
    session.add(view)
    session.flush()
    session.add_all(
        [
            ViewColumn(view_id=view.id, column_name="id", column_type="bigint", is_aggregatable=True, is_groupable=True),
            ViewColumn(view_id=view.id, column_name="created_at", column_type="timestamp", is_aggregatable=False, is_groupable=True),
        ]
    )

    dataset = Dataset(datasource_id=datasource.id, view_id=view.id, name="Sales", description="", is_active=True)
    session.add(dataset)
    session.flush()

    dashboard = Dashboard(dataset_id=dataset.id, name="Main", layout_config=[], created_by_id=user.id)
    session.add(dashboard)
    session.flush()

    widget = DashboardWidget(
        dashboard_id=dashboard.id,
        widget_type="kpi",
        title="Total",
        position=0,
        query_config={"widget_type": "kpi", "metrics": [{"op": "count", "column": "id"}]},
        config_version=1,
    )
    session.add(widget)
    session.commit()

    current_user = SimpleNamespace(id=user.id, email=user.email, is_admin=True, is_active=True)

    def _get_db() -> Generator[Session, None, None]:
        db = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(datasets.router)
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_current_admin_user] = lambda: current_user
    app.dependency_overrides[datasets.get_db] = _get_db

    return TestClient(app), testing_session_local, dataset.id, dashboard.id, widget.id, datasource.id


def test_delete_dataset_removes_related_dashboards_and_widgets() -> None:
    client, session_factory, dataset_id, dashboard_id, widget_id, _datasource_id = _create_app()

    with client:
        response = client.delete(f"/datasets/{dataset_id}")
    assert response.status_code == 204, response.text

    session: Session = session_factory()
    try:
        assert session.get(Dataset, dataset_id) is None
        assert session.get(Dashboard, dashboard_id) is None
        assert session.get(DashboardWidget, widget_id) is None
    finally:
        session.close()


def test_delete_imported_dataset_triggers_imported_physical_cleanup(monkeypatch) -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.access_mode = "imported"
        dataset.execution_datasource_id = 999
        dataset.execution_view_id = 888
        session.commit()
    finally:
        session.close()

    captured: dict[str, int] = {}

    def _fake_cleanup(*, db: Session, dataset: Dataset) -> None:
        _ = db
        captured["dataset_id"] = int(dataset.id)

    monkeypatch.setattr(datasets, "cleanup_imported_dataset_assets", _fake_cleanup)

    with client:
        response = client.delete(f"/datasets/{dataset_id}")
    assert response.status_code == 204, response.text
    assert captured["dataset_id"] == dataset_id


def test_update_dataset_allows_authenticated_user() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()

    with client:
        response = client.patch(
            f"/datasets/{dataset_id}",
            json={
                "name": "Sales Updated",
                "description": "updated description",
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["name"] == "Sales Updated"
    assert payload["description"] == "updated description"

    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        assert dataset.name == "Sales Updated"
        assert dataset.description == "updated description"
    finally:
        session.close()


def test_list_datasets_recomputes_semantic_columns_from_base_query_spec() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.base_query_spec = {
            "version": 1,
            "source": {"datasource_id": int(dataset.datasource_id)},
            "base": {
                "primary_resource": "public.vw_sales",
                "resources": [{"id": "base", "resource_id": "public.vw_sales"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {
                    "include": [
                        {"resource": "base", "column": "created_at", "alias": "data_ref"},
                    ],
                    "exclude": [],
                },
                "computed_columns": [],
                "filters": [],
            },
        }
        dataset.semantic_columns = [{"name": "data_ref", "type": "text", "source": "projected"}]
        session.commit()
    finally:
        session.close()

    with client:
        response = client.get("/datasets")
    assert response.status_code == 200, response.text
    payload = response.json()
    row = next(item for item in payload if item["id"] == dataset_id)
    semantic = row.get("semantic_columns") or []
    target = next(item for item in semantic if item["name"] == "data_ref")
    assert target["type"] == "temporal"


def test_list_datasets_builds_legacy_base_query_spec_when_missing() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.base_query_spec = None
        session.commit()
    finally:
        session.close()

    with client:
        response = client.get("/datasets")
    assert response.status_code == 200, response.text
    payload = response.json()
    row = next(item for item in payload if item["id"] == dataset_id)
    assert row["base_query_spec"]["base"]["primary_resource"] == "public.vw_sales"
    assert row["base_query_spec"]["base"]["resources"] == [{"id": "base", "resource_id": "public.vw_sales"}]


def test_bulk_import_enable_sets_access_mode_creates_config_and_queues_initial_sync() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()

    with client:
        response = client.post(
            f"/datasets/datasources/{datasource_id}/import-enable",
            json={},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targeted_count"] == 1
    assert payload["updated_count"] == 1
    assert payload["run_enqueued_count"] == 1
    assert payload["skipped_count"] == 0

    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        assert dataset.access_mode == "imported"
        assert dataset.data_status == "initializing"
        assert dataset.last_sync_run_id is not None
        assert dataset.base_query_spec is not None
        assert dataset.base_query_spec["base"]["primary_resource"] == "public.vw_sales"

        config = session.query(DatasetImportConfig).filter(DatasetImportConfig.dataset_id == dataset_id).first()
        assert config is not None
        assert config.refresh_mode == "full_refresh"
        assert config.drift_policy == "block_on_breaking"

        run = session.query(DatasetSyncRun).filter(DatasetSyncRun.dataset_id == dataset_id).first()
        assert run is not None
        assert run.status == "queued"
        assert run.trigger_type == "initial"
    finally:
        session.close()


def test_bulk_import_enable_skips_dataset_without_view_or_base_query_source() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()
    orphan_dataset_id: int | None = None
    session: Session = session_factory()
    try:
        orphan = Dataset(
            datasource_id=datasource_id,
            view_id=None,
            name="Orphan",
            description="",
            base_query_spec=None,
            is_active=True,
        )
        session.add(orphan)
        session.flush()
        orphan_dataset_id = int(orphan.id)
        session.commit()
    finally:
        session.close()

    with client:
        response = client.post(
            f"/datasets/datasources/{datasource_id}/import-enable",
            json={},
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targeted_count"] == 2
    assert payload["updated_count"] == 1
    assert payload["run_enqueued_count"] == 1
    assert payload["skipped_count"] == 1
    assert payload["skipped_items"] == [
        {
            "dataset_id": orphan_dataset_id,
            "reason": "dataset_has_no_base_query_source",
        }
    ]

def test_create_dataset_uses_datasource_default_access_mode_when_not_provided() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()
    view_id: int | None = None
    session: Session = session_factory()
    try:
        datasource = session.get(DataSource, datasource_id)
        assert datasource is not None
        datasource.default_dataset_access_mode = "imported"
        view = session.query(View).filter(View.datasource_id == datasource_id).first()
        assert view is not None
        view_id = int(view.id)
        session.commit()
    finally:
        session.close()

    with client:
        response = client.post(
            "/datasets",
            json={
                "datasource_id": datasource_id,
                "view_id": view_id,
                "name": "New Imported By Default",
                "description": "created without explicit access mode",
                "is_active": True,
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    created_dataset_id = int(payload["id"])
    assert payload["access_mode"] == "imported"
    assert payload["data_status"] == "initializing"

    session = session_factory()
    try:
        config = session.query(DatasetImportConfig).filter(DatasetImportConfig.dataset_id == created_dataset_id).first()
        assert config is not None
        run = session.query(DatasetSyncRun).filter(DatasetSyncRun.dataset_id == created_dataset_id).first()
        assert run is not None
        assert run.status == "queued"
        assert run.trigger_type == "initial"
    finally:
        session.close()


def test_import_config_upsert_and_get() -> None:
    client, _session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()

    with client:
        missing_response = client.get(f"/datasets/{dataset_id}/import-config")
    assert missing_response.status_code == 404, missing_response.text

    with client:
        upsert_response = client.put(
            f"/datasets/{dataset_id}/import-config",
            json={
                "enabled": True,
                "max_runtime_seconds": 600,
            },
        )
    assert upsert_response.status_code == 200, upsert_response.text
    upsert_payload = upsert_response.json()
    assert upsert_payload["dataset_id"] == dataset_id
    assert upsert_payload["refresh_mode"] == "full_refresh"
    assert upsert_payload["drift_policy"] == "block_on_breaking"
    assert upsert_payload["enabled"] is True
    assert upsert_payload["max_runtime_seconds"] == 600

    with client:
        get_response = client.get(f"/datasets/{dataset_id}/import-config")
    assert get_response.status_code == 200, get_response.text
    get_payload = get_response.json()
    assert get_payload["id"] == upsert_payload["id"]
    assert get_payload["max_runtime_seconds"] == 600


def test_trigger_sync_enqueues_once_and_coalesces_when_active_run_exists() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.access_mode = "imported"
        dataset.data_status = "initializing"
        session.commit()
    finally:
        session.close()

    with client:
        first_response = client.post(
            f"/datasets/{dataset_id}/syncs",
            json={},
        )
    assert first_response.status_code == 200, first_response.text
    first_payload = first_response.json()
    assert first_payload["trigger_type"] == "manual"
    assert first_payload["status"] == "queued"
    assert first_payload["coalesced"] is False

    with client:
        second_response = client.post(
            f"/datasets/{dataset_id}/syncs",
            json={},
        )
    assert second_response.status_code == 200, second_response.text
    second_payload = second_response.json()
    assert second_payload["id"] == first_payload["id"]
    assert second_payload["coalesced"] is True

    session = session_factory()
    try:
        rows = session.query(DatasetSyncRun).filter(DatasetSyncRun.dataset_id == dataset_id).all()
        assert len(rows) == 1
    finally:
        session.close()


def test_sync_run_retry_enqueues_new_attempt_and_supports_list_and_get() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    failed_run_id: int | None = None
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.access_mode = "imported"
        dataset.data_status = "error"
        failed_run = DatasetSyncRun(
            dataset_id=dataset_id,
            trigger_type="manual",
            status="failed",
            attempt=1,
            input_snapshot={"source": "test"},
            stats={},
        )
        session.add(failed_run)
        session.flush()
        failed_run_id = int(failed_run.id)
        session.commit()
    finally:
        session.close()

    with client:
        retry_response = client.post(f"/datasets/{dataset_id}/syncs/{failed_run_id}/retry")
    assert retry_response.status_code == 200, retry_response.text
    retry_payload = retry_response.json()
    assert retry_payload["trigger_type"] == "retry"
    assert retry_payload["attempt"] == 2
    assert retry_payload["coalesced"] is False

    queued_retry_id = int(retry_payload["id"])
    with client:
        retry_coalesced_response = client.post(f"/datasets/{dataset_id}/syncs/{failed_run_id}/retry")
    assert retry_coalesced_response.status_code == 200, retry_coalesced_response.text
    retry_coalesced_payload = retry_coalesced_response.json()
    assert retry_coalesced_payload["id"] == queued_retry_id
    assert retry_coalesced_payload["coalesced"] is True

    with client:
        list_response = client.get(f"/datasets/{dataset_id}/syncs")
    assert list_response.status_code == 200, list_response.text
    list_payload = list_response.json()
    assert len(list_payload["items"]) == 2
    assert list_payload["items"][0]["id"] == queued_retry_id

    with client:
        get_response = client.get(f"/datasets/{dataset_id}/syncs/{queued_retry_id}")
    assert get_response.status_code == 200, get_response.text
    get_payload = get_response.json()
    assert get_payload["id"] == queued_retry_id
    assert get_payload["trigger_type"] == "retry"


def test_sync_schedule_put_get_and_delete() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    session: Session = session_factory()
    try:
        dataset = session.get(Dataset, dataset_id)
        assert dataset is not None
        dataset.access_mode = "imported"
        session.commit()
    finally:
        session.close()


def test_create_dataset_blocks_direct_mode_for_spreadsheet_origin_datasource() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    spreadsheet_datasource_id: int | None = None
    spreadsheet_view_id: int | None = None

    session: Session = session_factory()
    try:
        user = session.query(User).first()
        assert user is not None
        spreadsheet_ds = DataSource(
            name="sheet",
            description="",
            database_url="postgresql://fake",
            source_type="file_spreadsheet_import",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(spreadsheet_ds)
        session.flush()
        spreadsheet_view = View(
            datasource_id=spreadsheet_ds.id,
            schema_name="public",
            view_name="sheet_table",
            is_active=True,
        )
        session.add(spreadsheet_view)
        session.flush()
        session.add(
            ViewColumn(
                view_id=spreadsheet_view.id,
                column_name="id",
                column_type="bigint",
                is_aggregatable=True,
                is_groupable=True,
            )
        )
        session.commit()
        spreadsheet_datasource_id = int(spreadsheet_ds.id)
        spreadsheet_view_id = int(spreadsheet_view.id)
    finally:
        session.close()

    with client:
        response = client.post(
            "/datasets",
            json={
                "datasource_id": spreadsheet_datasource_id,
                "view_id": spreadsheet_view_id,
                "name": "Sheet Direct",
                "description": "",
                "access_mode": "direct",
            },
        )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Spreadsheet-origin datasets must use imported access_mode"


def test_update_dataset_blocks_direct_mode_for_spreadsheet_origin_datasource() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, _datasource_id = _create_app()
    spreadsheet_dataset_id: int | None = None

    session: Session = session_factory()
    try:
        user = session.query(User).first()
        assert user is not None
        spreadsheet_ds = DataSource(
            name="sheet",
            description="",
            database_url="postgresql://fake",
            source_type="file_spreadsheet_import",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(spreadsheet_ds)
        session.flush()
        spreadsheet_view = View(
            datasource_id=spreadsheet_ds.id,
            schema_name="public",
            view_name="sheet_table",
            is_active=True,
        )
        session.add(spreadsheet_view)
        session.flush()
        session.add(
            ViewColumn(
                view_id=spreadsheet_view.id,
                column_name="id",
                column_type="bigint",
                is_aggregatable=True,
                is_groupable=True,
            )
        )
        sheet_dataset = Dataset(
            datasource_id=spreadsheet_ds.id,
            view_id=spreadsheet_view.id,
            name="Sheet Imported",
            description="",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(sheet_dataset)
        session.commit()
        spreadsheet_dataset_id = int(sheet_dataset.id)
    finally:
        session.close()

    with client:
        response = client.patch(
            f"/datasets/{spreadsheet_dataset_id}",
            json={"access_mode": "direct"},
        )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Spreadsheet-origin datasets must use imported access_mode"


def test_bulk_import_enable_rejects_forbidden_copy_policy_even_with_override_flag() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()
    session: Session = session_factory()
    try:
        datasource = session.get(DataSource, datasource_id)
        assert datasource is not None
        datasource.copy_policy = "forbidden"
        session.commit()
    finally:
        session.close()

    with client:
        response = client.post(
            f"/datasets/datasources/{datasource_id}/import-enable",
            json={"only_if_copy_policy_allowed": False},
        )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "Datasource copy_policy forbids imported mode"


def test_create_dataset_auto_switches_to_imported_when_base_query_uses_workspace_internal_schema() -> None:
    client, session_factory, _dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()
    internal_schema_view_id: int | None = None
    workspace_id: int | None = None

    session: Session = session_factory()
    try:
        datasource = session.get(DataSource, datasource_id)
        assert datasource is not None
        workspace_id = int(datasource.created_by_id)
        internal_view = View(
            datasource_id=datasource_id,
            schema_name=f"lens_imp_t{workspace_id}",
            view_name="sheet_orders",
            is_active=True,
        )
        session.add(internal_view)
        session.flush()
        session.add(
            ViewColumn(
                view_id=internal_view.id,
                column_name="id",
                column_type="bigint",
                is_aggregatable=True,
                is_groupable=True,
            )
        )
        session.commit()
        internal_schema_view_id = int(internal_view.id)
    finally:
        session.close()

    with client:
        response = client.post(
            "/datasets",
            json={
                "datasource_id": datasource_id,
                "view_id": internal_schema_view_id,
                "name": "Invalid Direct Internal Resource",
                "access_mode": "direct",
                "base_query_spec": {
                    "version": 1,
                    "source": {"datasource_id": datasource_id},
                    "base": {
                        "primary_resource": f"lens_imp_t{workspace_id}.sheet_orders",
                        "resources": [{"id": "r0", "resource_id": f"lens_imp_t{workspace_id}.sheet_orders"}],
                        "joins": [],
                    },
                    "preprocess": {
                        "columns": {
                            "include": [{"resource": "r0", "column": "id", "alias": "id"}],
                            "exclude": [],
                        },
                        "computed_columns": [],
                        "filters": [],
                    },
                },
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["access_mode"] == "imported"
    assert payload["data_status"] == "initializing"


def test_update_dataset_auto_switches_to_imported_when_base_query_uses_workspace_internal_schema() -> None:
    client, session_factory, dataset_id, _dashboard_id, _widget_id, datasource_id = _create_app()
    workspace_id: int | None = None

    session: Session = session_factory()
    try:
        datasource = session.get(DataSource, datasource_id)
        assert datasource is not None
        workspace_id = int(datasource.created_by_id)
        internal_view = View(
            datasource_id=datasource_id,
            schema_name=f"lens_imp_t{workspace_id}",
            view_name="sheet_orders",
            is_active=True,
        )
        session.add(internal_view)
        session.flush()
        session.add(
            ViewColumn(
                view_id=internal_view.id,
                column_name="id",
                column_type="bigint",
                is_aggregatable=True,
                is_groupable=True,
            )
        )
        session.commit()
    finally:
        session.close()

    with client:
        response = client.patch(
            f"/datasets/{dataset_id}",
            json={
                "access_mode": "direct",
                "base_query_spec": {
                    "version": 1,
                    "source": {"datasource_id": datasource_id},
                    "base": {
                        "primary_resource": f"lens_imp_t{workspace_id}.sheet_orders",
                        "resources": [{"id": "r0", "resource_id": f"lens_imp_t{workspace_id}.sheet_orders"}],
                        "joins": [],
                    },
                    "preprocess": {
                        "columns": {
                            "include": [{"resource": "r0", "column": "id", "alias": "id"}],
                            "exclude": [],
                        },
                        "computed_columns": [],
                        "filters": [],
                    },
                },
            },
        )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["access_mode"] == "imported"
    assert payload["data_status"] == "initializing"

    session = session_factory()
    try:
        config = session.query(DatasetImportConfig).filter(DatasetImportConfig.dataset_id == dataset_id).first()
        assert config is not None
        run = session.query(DatasetSyncRun).filter(DatasetSyncRun.dataset_id == dataset_id).first()
        assert run is not None
        assert run.status == "queued"
        assert run.trigger_type == "initial"
    finally:
        session.close()
