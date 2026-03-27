from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.modules.core.legacy.models import Base, DataSource, Dataset, User, View
from app.modules.engine.access import resolve_datasource_access


def _build_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    return TestingSessionLocal()


def test_resolve_datasource_access_uses_execution_datasource_for_effective_imported_mode() -> None:
    session = _build_session()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()

        logical_ds = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        execution_ds = DataSource(
            name="execution",
            description="",
            database_url="postgresql://execution",
            created_by_id=user.id,
            is_active=True,
        )
        session.add_all([logical_ds, execution_ds])
        session.flush()

        logical_view = View(datasource_id=logical_ds.id, schema_name="public", view_name="vw_sales", is_active=True)
        execution_view = View(datasource_id=execution_ds.id, schema_name="lens_imp_t1", view_name="ds_1", is_active=True)
        session.add_all([logical_view, execution_view])
        session.flush()

        dataset = Dataset(
            datasource_id=logical_ds.id,
            view_id=logical_view.id,
            access_mode="imported",
            execution_datasource_id=execution_ds.id,
            execution_view_id=execution_view.id,
            data_status="ready",
            last_successful_sync_at=datetime.utcnow(),
            name="sales",
            is_active=True,
        )
        session.add(dataset)
        session.commit()
        session.refresh(dataset)

        context = resolve_datasource_access(
            datasource=dataset.datasource,
            dataset=dataset,
            current_user=user,
        )

        assert context.effective_access_mode == "imported"
        assert context.datasource_id == execution_ds.id
        assert context.logical_datasource_id == logical_ds.id
        assert context.workspace_id == logical_ds.created_by_id
        assert context.execution_view_id == execution_view.id
    finally:
        session.close()


def test_resolve_datasource_access_falls_back_to_direct_when_imported_not_ready() -> None:
    session = _build_session()
    try:
        user = User(email="owner@test.com", hashed_password="x", is_admin=True, is_active=True)
        session.add(user)
        session.flush()

        logical_ds = DataSource(
            name="logical",
            description="",
            database_url="postgresql://logical",
            created_by_id=user.id,
            is_active=True,
        )
        execution_ds = DataSource(
            name="execution",
            description="",
            database_url="postgresql://execution",
            created_by_id=user.id,
            is_active=True,
        )
        session.add_all([logical_ds, execution_ds])
        session.flush()

        logical_view = View(datasource_id=logical_ds.id, schema_name="public", view_name="vw_sales", is_active=True)
        execution_view = View(datasource_id=execution_ds.id, schema_name="lens_imp_t1", view_name="ds_1", is_active=True)
        session.add_all([logical_view, execution_view])
        session.flush()

        dataset = Dataset(
            datasource_id=logical_ds.id,
            view_id=logical_view.id,
            access_mode="imported",
            execution_datasource_id=execution_ds.id,
            execution_view_id=execution_view.id,
            data_status="initializing",
            last_successful_sync_at=datetime.utcnow(),
            name="sales",
            is_active=True,
        )
        session.add(dataset)
        session.commit()
        session.refresh(dataset)

        context = resolve_datasource_access(
            datasource=dataset.datasource,
            dataset=dataset,
            current_user=user,
        )

        assert context.effective_access_mode == "direct"
        assert context.datasource_id == logical_ds.id
        assert context.logical_datasource_id == logical_ds.id
    finally:
        session.close()
