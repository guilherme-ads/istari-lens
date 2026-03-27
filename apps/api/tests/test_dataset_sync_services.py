from datetime import datetime, timedelta
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.modules.core.legacy.models import (
    Base,
    DataSource,
    Dataset,
    DatasetImportConfig,
    DatasetSyncRun,
    DatasetSyncSchedule,
    User,
    View,
)
from app.modules.datasets.sync_services import (
    DatasetMaterializationResult,
    DatasetSyncSchedulerService,
    DatasetSyncWorkerService,
    _build_preprocess_filters_where_sql,
)
from app.shared.infrastructure.settings import get_settings


def _build_session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    return testing_session_local


def test_scheduler_enqueues_due_interval_run() -> None:
    session_factory = _build_session_factory()
    session: Session = session_factory()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()

        datasource = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(datasource)
        session.flush()

        view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
        session.add(view)
        session.flush()

        dataset = Dataset(
            datasource_id=datasource.id,
            view_id=view.id,
            name="sales",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(dataset)
        session.flush()
        session.add(
            DatasetImportConfig(
                dataset_id=dataset.id,
                refresh_mode="full_refresh",
                drift_policy="block_on_breaking",
                enabled=True,
            )
        )
        session.add(
            DatasetSyncSchedule(
                dataset_id=dataset.id,
                enabled=True,
                schedule_kind="interval",
                interval_minutes=10,
                timezone="UTC",
                next_run_at=datetime.utcnow() - timedelta(minutes=5),
                misfire_policy="run_once",
            )
        )
        session.commit()
    finally:
        session.close()

    service = DatasetSyncSchedulerService(session_factory=session_factory)
    enqueued = service.enqueue_due_runs(now=datetime.utcnow())
    assert enqueued == 1

    session = session_factory()
    try:
        run = session.query(DatasetSyncRun).first()
        assert run is not None
        assert run.status == "queued"
        assert run.trigger_type == "scheduled"
        dataset = session.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        assert dataset is not None
        assert dataset.last_sync_run_id == run.id
        schedule = session.query(DatasetSyncSchedule).filter(DatasetSyncSchedule.dataset_id == dataset.id).first()
        assert schedule is not None
        assert schedule.next_run_at is not None
    finally:
        session.close()


def test_scheduler_coalesces_when_dataset_has_active_run() -> None:
    session_factory = _build_session_factory()
    session: Session = session_factory()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()
        datasource = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(datasource)
        session.flush()
        view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
        session.add(view)
        session.flush()
        dataset = Dataset(
            datasource_id=datasource.id,
            view_id=view.id,
            name="sales",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(dataset)
        session.flush()
        session.add(
            DatasetSyncSchedule(
                dataset_id=dataset.id,
                enabled=True,
                schedule_kind="interval",
                interval_minutes=15,
                timezone="UTC",
                next_run_at=datetime.utcnow() - timedelta(minutes=1),
                misfire_policy="run_once",
            )
        )
        session.add(
            DatasetSyncRun(
                dataset_id=dataset.id,
                trigger_type="manual",
                status="queued",
                attempt=1,
                input_snapshot={},
                stats={},
            )
        )
        session.commit()
    finally:
        session.close()

    service = DatasetSyncSchedulerService(session_factory=session_factory)
    enqueued = service.enqueue_due_runs(now=datetime.utcnow())
    assert enqueued == 0

    session = session_factory()
    try:
        runs = session.query(DatasetSyncRun).all()
        assert len(runs) == 1
    finally:
        session.close()


def test_worker_marks_run_success_when_materialization_succeeds(monkeypatch) -> None:
    session_factory = _build_session_factory()
    session: Session = session_factory()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()
        datasource = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(datasource)
        session.flush()
        view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
        session.add(view)
        session.flush()
        dataset = Dataset(
            datasource_id=datasource.id,
            view_id=view.id,
            name="sales",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(dataset)
        session.flush()
        run = DatasetSyncRun(
            dataset_id=dataset.id,
            trigger_type="manual",
            status="queued",
            attempt=1,
            input_snapshot={},
            stats={},
        )
        session.add(run)
        session.commit()
    finally:
        session.close()

    worker = DatasetSyncWorkerService(
        session_factory=session_factory,
        settings=get_settings(),
        worker_id="test-worker",
    )

    def _fake_materialize(*, db, dataset, run):  # noqa: ANN001
        _ = db
        _ = dataset
        _ = run
        return DatasetMaterializationResult(
            execution_datasource_id=999,
            execution_view_id=888,
            published_execution_view_id=888,
            rows_read=12,
            rows_written=12,
            bytes_processed=1024,
        )

    monkeypatch.setattr(worker, "_materialize_imported_dataset", _fake_materialize)
    assert worker.process_next_queued_run() is True

    session = session_factory()
    try:
        run = session.query(DatasetSyncRun).first()
        assert run is not None
        assert run.status == "success"
        assert run.stats["rows_written"] == 12
        dataset = session.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        assert dataset is not None
        assert dataset.data_status == "ready"
        assert dataset.execution_datasource_id == 999
        assert dataset.execution_view_id == 888
        assert dataset.last_successful_sync_at is not None
    finally:
        session.close()


def test_worker_marks_run_failed_when_materialization_raises(monkeypatch) -> None:
    session_factory = _build_session_factory()
    session: Session = session_factory()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()
        datasource = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(datasource)
        session.flush()
        view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
        session.add(view)
        session.flush()
        dataset = Dataset(
            datasource_id=datasource.id,
            view_id=view.id,
            name="sales",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(dataset)
        session.flush()
        run = DatasetSyncRun(
            dataset_id=dataset.id,
            trigger_type="manual",
            status="queued",
            attempt=1,
            input_snapshot={},
            stats={},
        )
        session.add(run)
        session.commit()
    finally:
        session.close()

    worker = DatasetSyncWorkerService(
        session_factory=session_factory,
        settings=get_settings(),
        worker_id="test-worker",
    )

    def _raise_error(*, db, dataset, run):  # noqa: ANN001
        _ = db
        _ = dataset
        _ = run
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(worker, "_materialize_imported_dataset", _raise_error)
    assert worker.process_next_queued_run() is True

    session = session_factory()
    try:
        run = session.query(DatasetSyncRun).first()
        assert run is not None
        assert run.status == "failed"
        dataset = session.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        assert dataset is not None
        assert dataset.data_status == "error"
    finally:
        session.close()


def test_materialization_uses_slot_table_instead_of_run_table(monkeypatch) -> None:
    session_factory = _build_session_factory()
    session: Session = session_factory()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()
        datasource = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        session.add(datasource)
        session.flush()
        view = View(datasource_id=datasource.id, schema_name="public", view_name="vw_sales", is_active=True)
        session.add(view)
        session.flush()
        dataset = Dataset(
            datasource_id=datasource.id,
            view_id=view.id,
            name="sales",
            access_mode="imported",
            data_status="initializing",
            is_active=True,
        )
        session.add(dataset)
        session.flush()
        run = DatasetSyncRun(
            dataset_id=dataset.id,
            trigger_type="manual",
            status="queued",
            attempt=1,
            input_snapshot={},
            stats={},
        )
        session.add(run)
        session.commit()
        session.refresh(dataset)
        session.refresh(run)
    finally:
        session.close()

    worker = DatasetSyncWorkerService(
        session_factory=session_factory,
        settings=get_settings(),
        worker_id="test-worker",
    )

    captured: dict[str, str] = {}

    monkeypatch.setattr(
        "app.modules.datasets.sync_services.resolve_datasource_url",
        lambda datasource_obj: "postgresql://test",  # noqa: ARG005
    )
    monkeypatch.setattr(
        worker,
        "_resolve_source_resource",
        lambda *, dataset: ("public", "vw_sales"),  # noqa: ARG005
    )
    monkeypatch.setattr(
        worker,
        "_resolve_or_create_internal_datasource",
        lambda *, db, dataset: SimpleNamespace(id=999, created_by_id=1),  # noqa: ARG005
    )
    monkeypatch.setattr(
        worker,
        "_fetch_source_columns",
        lambda **kwargs: [("id", "integer"), ("amount", "numeric")],  # noqa: ARG005
    )
    monkeypatch.setattr(
        worker,
        "_resolve_next_slot_table_name",
        lambda **kwargs: "ds_1__sales__slot_b",  # noqa: ARG005
    )

    def _fake_copy_source_to_internal(**kwargs):  # noqa: ANN001
        captured["copy_table"] = kwargs["load_table_name"]
        return (10, 10, 1024)

    def _fake_publish_stable_view(**kwargs):  # noqa: ANN001
        captured["publish_table"] = kwargs["load_table_name"]

    monkeypatch.setattr(worker, "_copy_source_to_internal", _fake_copy_source_to_internal)
    monkeypatch.setattr(worker, "_publish_stable_view", _fake_publish_stable_view)
    monkeypatch.setattr(worker, "_cleanup_legacy_load_tables", lambda **kwargs: None)  # noqa: ARG005
    monkeypatch.setattr(worker, "_upsert_internal_view_metadata", lambda **kwargs: 888)  # noqa: ARG005

    session = session_factory()
    try:
        dataset = session.query(Dataset).filter(Dataset.id == 1).first()
        run = session.query(DatasetSyncRun).filter(DatasetSyncRun.id == 1).first()
        assert dataset is not None
        assert run is not None
        result = worker._materialize_imported_dataset(db=session, dataset=dataset, run=run)
    finally:
        session.close()

    assert captured["copy_table"] == "ds_1__sales__slot_b"
    assert captured["publish_table"] == "ds_1__sales__slot_b"
    assert "__load_" not in captured["copy_table"]
    assert result.execution_datasource_id == 999
    assert result.execution_view_id == 888


def test_resolve_next_slot_table_name_flips_from_slot_a_to_slot_b(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, query, params=None):  # noqa: ANN001
            _ = query
            _ = params

        def fetchone(self):
            return ('SELECT * FROM lens_imp_t1.ds_1__sales__slot_a',)

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda url: _FakeConn())  # noqa: ARG005

    table_name = worker._resolve_next_slot_table_name(
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        published_view_name="ds_1__sales",
        dataset_id=1,
        dataset_name="sales",
    )
    assert table_name == "ds_1__sales__slot_b"


def test_resolve_next_slot_table_name_defaults_to_slot_a_when_view_missing(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, query, params=None):  # noqa: ANN001
            _ = query
            _ = params

        def fetchone(self):
            return None

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda url: _FakeConn())  # noqa: ARG005

    table_name = worker._resolve_next_slot_table_name(
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        published_view_name="ds_1__sales",
        dataset_id=1,
        dataset_name="sales",
    )
    assert table_name == "ds_1__sales__slot_a"


def test_publish_stable_view_recreates_view_to_allow_schema_drift(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    executed_sql: list[str] = []

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, query, params=None):  # noqa: ANN001
            _ = params
            executed_sql.append(str(query))

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

        def commit(self):
            return None

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda _url: _FakeConn())

    worker._publish_stable_view(
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        load_table_name="ds_1__sales__slot_b",
        published_view_name="ds_1__sales",
    )

    assert len(executed_sql) == 2
    assert "DROP VIEW IF EXISTS" in executed_sql[0]
    assert "CREATE VIEW" in executed_sql[1]
    assert "CREATE OR REPLACE VIEW" not in executed_sql[1]


def test_build_imported_index_plan_prefers_temporal_and_id_columns() -> None:
    settings = get_settings().model_copy(
        update={
            "dataset_sync_optimize_max_indexes": 4,
            "dataset_sync_optimize_brin_threshold_rows": 100_000,
        }
    )
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=settings,
        worker_id="test-worker",
    )

    plan = worker._build_imported_index_plan(
        source_columns=[
            ("created_at", "timestamp"),
            ("customer_id", "bigint"),
            ("id", "bigint"),
            ("revenue", "numeric"),
        ],
        row_count=250_000,
    )

    assert len(plan) == 4
    assert plan[0].columns == ["created_at"]
    assert plan[0].method == "brin"
    assert any(item.columns == ["customer_id"] and item.method == "btree" for item in plan)
    assert any(item.columns == ["id"] and item.method == "btree" for item in plan)


def test_build_imported_index_plan_respects_max_indexes() -> None:
    settings = get_settings().model_copy(
        update={
            "dataset_sync_optimize_max_indexes": 2,
            "dataset_sync_optimize_brin_threshold_rows": 100_000,
        }
    )
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=settings,
        worker_id="test-worker",
    )

    plan = worker._build_imported_index_plan(
        source_columns=[
            ("event_time", "timestamp"),
            ("account_id", "bigint"),
            ("user_id", "bigint"),
            ("amount", "numeric"),
        ],
        row_count=250_000,
    )

    assert len(plan) == 2
    assert plan[0].columns == ["event_time"]
    assert plan[0].method == "brin"


def test_select_partition_column_prefers_temporal_columns() -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    selected = worker._select_partition_column(
        source_columns=[
            ("customer_id", "bigint"),
            ("created_at", "timestamp"),
            ("amount", "numeric"),
        ]
    )
    assert selected == "created_at"


def test_maybe_partition_imported_table_skips_when_row_count_below_threshold(monkeypatch) -> None:
    settings = get_settings().model_copy(
        update={
            "dataset_sync_partition_enabled": True,
            "dataset_sync_partition_min_rows": 1_000_000,
        }
    )
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=settings,
        worker_id="test-worker",
    )

    monkeypatch.setattr(
        "app.modules.datasets.sync_services.psycopg.connect",
        lambda _url: (_ for _ in ()).throw(RuntimeError("should not connect")),  # pragma: no cover
    )

    result = worker._maybe_partition_imported_table(
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        table_name="ds_1__sales__slot_a",
        source_columns=[("created_at", "timestamp"), ("id", "bigint")],
        row_count=100_000,
    )
    assert result == "ds_1__sales__slot_a"


def test_build_preprocess_filters_where_sql_supports_boolean_and_date_between() -> None:
    where_sql, params = _build_preprocess_filters_where_sql(
        filters=[
            {"field": "cadastro_em", "op": "between", "value": ["2025-01-01", "2025-12-31"]},
            {"field": "ear", "op": "eq", "value": True},
        ],
        field_alias_map={},
    )

    assert '"cadastro_em" BETWEEN ((%s::date)::timestamp at time zone \'America/Sao_Paulo\')' in where_sql
    assert '"ear" = %s' in where_sql
    assert params == ["2025-01-01", "2026-01-01", True]


def test_materialize_base_query_spec_applies_preprocess_filters(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    executed_params: list[object] = []

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, _query, params=None):  # noqa: ANN001
            if params:
                executed_params.extend(list(params))

        def fetchone(self):
            return (3,)

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

        def commit(self):
            return None

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda _url: _FakeConn())

    dataset = SimpleNamespace(
        id=6,
        name="Clientes",
        base_query_spec={
            "base": {
                "primary_resource": "lens_imp_t1.vw_clientes",
                "resources": [{"id": "r0", "resource_id": "lens_imp_t1.vw_clientes"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {"include": [], "exclude": []},
                "computed_columns": [],
                "filters": [{"field": "ear", "op": "eq", "value": True}],
            },
        },
    )

    rows_read, rows_written, bytes_processed = worker._materialize_base_query_spec_to_internal(
        dataset=dataset,
        source_url=None,
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        load_table_name="ds_6__clientes__slot_a",
    )

    assert rows_read == 3
    assert rows_written == 3
    assert bytes_processed == 0
    assert executed_params == [True]


def test_materialize_base_query_spec_supports_exclude_and_computed(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    executed_params: list[object] = []

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, _query, params=None):  # noqa: ANN001
            if params:
                executed_params.extend(list(params))

        def fetchone(self):
            return (2,)

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

        def commit(self):
            return None

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda _url: _FakeConn())

    dataset = SimpleNamespace(
        id=7,
        name="Recargas",
        base_query_spec={
            "base": {
                "primary_resource": "lens_imp_t1.vw_recargas",
                "resources": [{"id": "r0", "resource_id": "lens_imp_t1.vw_recargas"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {
                    "include": [
                        {"resource": "r0", "column": "id_recarga", "alias": "id_recarga"},
                        {"resource": "r0", "column": "duracao_minutos", "alias": "duracao_minutos"},
                    ],
                    "exclude": ["id_recarga"],
                },
                "computed_columns": [
                    {
                        "alias": "duracao_com_bonus",
                        "expr": {"op": "add", "args": [{"column": "duracao_minutos"}, {"literal": 5}]},
                        "data_type": "numeric",
                    }
                ],
                "filters": [{"field": "duracao_com_bonus", "op": "gt", "value": 10}],
            },
        },
    )

    rows_read, rows_written, bytes_processed = worker._materialize_base_query_spec_to_internal(
        dataset=dataset,
        source_url=None,
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        load_table_name="ds_7__recargas__slot_a",
    )

    assert rows_read == 2
    assert rows_written == 2
    assert bytes_processed == 0
    assert executed_params == [5, 10]


def test_materialize_base_query_spec_supports_formula_computed(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    executed_params: list[object] = []

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, _query, params=None):  # noqa: ANN001
            if params:
                executed_params.extend(list(params))

        def fetchone(self):
            return (1,)

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

        def commit(self):
            return None

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda _url: _FakeConn())

    dataset = SimpleNamespace(
        id=8,
        name="Clientes",
        base_query_spec={
            "base": {
                "primary_resource": "lens_imp_t1.vw_clientes",
                "resources": [{"id": "r0", "resource_id": "lens_imp_t1.vw_clientes"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {
                    "include": [
                        {"resource": "r0", "column": "pontos", "alias": "pontos"},
                    ],
                    "exclude": [],
                },
                "computed_columns": [
                    {
                        "alias": "pontos_x2",
                        "expr": {"formula": "pontos*2+10"},
                        "data_type": "numeric",
                    }
                ],
                "filters": [{"field": "pontos_x2", "op": "gte", "value": 100}],
            },
        },
    )

    rows_read, rows_written, bytes_processed = worker._materialize_base_query_spec_to_internal(
        dataset=dataset,
        source_url=None,
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        load_table_name="ds_8__clientes__slot_a",
    )

    assert rows_read == 1
    assert rows_written == 1
    assert bytes_processed == 0
    assert executed_params == [100]


def test_materialize_base_query_spec_supports_unicode_column_identifiers(monkeypatch) -> None:
    worker = DatasetSyncWorkerService(
        session_factory=_build_session_factory(),
        settings=get_settings(),
        worker_id="test-worker",
    )

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def execute(self, _query, params=None):  # noqa: ANN001
            _ = params

        def fetchone(self):
            return (1,)

    class _FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
            return False

        def cursor(self):
            return _FakeCursor()

        def commit(self):
            return None

    monkeypatch.setattr("app.modules.datasets.sync_services.psycopg.connect", lambda _url: _FakeConn())

    dataset = SimpleNamespace(
        id=9,
        name="Receita",
        base_query_spec={
            "base": {
                "primary_resource": "lens_imp_t1.vw_receita",
                "resources": [{"id": "r0", "resource_id": "lens_imp_t1.vw_receita"}],
                "joins": [],
            },
            "preprocess": {
                "columns": {
                    "include": [
                        {
                            "resource": "r0",
                            "column": "margem_contribuição_rede",
                            "alias": "margem_contribuição_rede",
                        },
                    ],
                    "exclude": [],
                },
                "computed_columns": [],
                "filters": [],
            },
        },
    )

    rows_read, rows_written, bytes_processed = worker._materialize_base_query_spec_to_internal(
        dataset=dataset,
        source_url=None,
        internal_url="postgresql://internal",
        target_schema="lens_imp_t1",
        load_table_name="ds_9__receita__slot_a",
    )

    assert rows_read == 1
    assert rows_written == 1
    assert bytes_processed == 0
