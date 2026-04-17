from __future__ import annotations

from app.modules.bi_agent.agent.value_formatting import format_semantic_value


def test_value_formatting_currency() -> None:
    assert format_semantic_value(1234.5, semantic_type="currency", unit="brl").startswith("R$")
    assert "1.234,50" in format_semantic_value(1234.5, semantic_type="currency", unit="brl")


def test_value_formatting_percent() -> None:
    assert format_semantic_value(0.1234, semantic_type="percent", unit="%") == "12,34%"


def test_value_formatting_temporal() -> None:
    assert format_semantic_value("2026-03-31", semantic_type="temporal", unit=None) == "31/03/2026"

