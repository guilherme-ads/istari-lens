from datetime import datetime

from app.modules.core.legacy.models import Dataset
from app.modules.datasets import resolve_effective_access_mode


def test_effective_mode_is_direct_when_import_not_requested() -> None:
    dataset = Dataset(access_mode="direct", data_status="ready", is_active=True)
    assert resolve_effective_access_mode(dataset) == "direct"


def test_effective_mode_is_direct_before_first_successful_sync() -> None:
    dataset = Dataset(
        access_mode="imported",
        execution_datasource_id=2,
        execution_view_id=3,
        data_status="ready",
        last_successful_sync_at=None,
        is_active=True,
    )
    assert resolve_effective_access_mode(dataset) == "direct"


def test_effective_mode_is_imported_after_successful_publish() -> None:
    dataset = Dataset(
        access_mode="imported",
        execution_datasource_id=2,
        execution_view_id=3,
        data_status="ready",
        last_successful_sync_at=datetime.utcnow(),
        is_active=True,
    )
    assert resolve_effective_access_mode(dataset) == "imported"


def test_effective_mode_stays_imported_on_sync_error_with_published_binding() -> None:
    dataset = Dataset(
        access_mode="imported",
        execution_datasource_id=2,
        execution_view_id=3,
        data_status="error",
        last_successful_sync_at=datetime.utcnow(),
        is_active=True,
    )
    assert resolve_effective_access_mode(dataset) == "imported"


def test_effective_mode_falls_back_to_direct_on_initializing() -> None:
    dataset = Dataset(
        access_mode="imported",
        execution_datasource_id=2,
        execution_view_id=3,
        data_status="initializing",
        last_successful_sync_at=datetime.utcnow(),
        is_active=True,
    )
    assert resolve_effective_access_mode(dataset) == "direct"
