from datetime import timedelta

from app.datasources.postgres import _normalize_db_value


def test_normalize_db_value_converts_interval_to_days() -> None:
    value = timedelta(days=2, hours=12)
    assert _normalize_db_value(value) == 2.5

