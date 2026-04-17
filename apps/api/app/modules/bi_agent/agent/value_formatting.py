from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any


def format_semantic_value(
    value: Any,
    *,
    semantic_type: str | None = None,
    unit: str | None = None,
) -> str:
    if value is None:
        return "-"

    normalized_type = str(semantic_type or "").strip().lower()
    normalized_unit = str(unit or "").strip().lower()

    if isinstance(value, bool):
        return "sim" if value else "nao"

    if isinstance(value, (int, float, Decimal)):
        return _format_numeric(
            value=value,
            semantic_type=normalized_type,
            unit=normalized_unit,
        )

    text_value = str(value).strip()
    if not text_value:
        return "-"

    if normalized_type == "temporal":
        parsed = _try_parse_date(text_value)
        if parsed is not None:
            return parsed
    return text_value


def _format_numeric(*, value: int | float | Decimal, semantic_type: str, unit: str) -> str:
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        return str(value)

    if _looks_percent(semantic_type=semantic_type, unit=unit):
        pct = decimal_value * Decimal("100") if abs(decimal_value) <= Decimal("1.0") else decimal_value
        return f"{_format_decimal_ptbr(pct, 2)}%"

    if _looks_currency(semantic_type=semantic_type, unit=unit):
        currency_symbol = _currency_symbol(unit)
        return f"{currency_symbol} {_format_decimal_ptbr(decimal_value, 2)}"

    if semantic_type in {"count", "integer"}:
        return _format_decimal_ptbr(decimal_value, 0)

    if _is_integer(decimal_value):
        return _format_decimal_ptbr(decimal_value, 0)
    return _format_decimal_ptbr(decimal_value, 2)


def _to_decimal(value: int | float | Decimal) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _format_decimal_ptbr(value: Decimal, decimals: int) -> str:
    q = Decimal("1") if decimals == 0 else Decimal(f"1.{'0' * decimals}")
    quantized = value.quantize(q)
    rendered = f"{quantized:,.{decimals}f}"
    return rendered.replace(",", "X").replace(".", ",").replace("X", ".")


def _looks_percent(*, semantic_type: str, unit: str) -> bool:
    return semantic_type in {"percent", "percentage", "ratio"} or unit in {"%", "percent", "percentage"}


def _looks_currency(*, semantic_type: str, unit: str) -> bool:
    if semantic_type in {"currency", "money"}:
        return True
    return unit in {"brl", "usd", "eur", "r$", "$", "€"}


def _currency_symbol(unit: str) -> str:
    by_unit = {
        "brl": "R$",
        "r$": "R$",
        "usd": "US$",
        "$": "US$",
        "eur": "EUR",
        "€": "EUR",
    }
    return by_unit.get(unit, "R$")


def _is_integer(value: Decimal) -> bool:
    return value == value.to_integral_value()


def _try_parse_date(value: str) -> str | None:
    text = str(value).strip()
    if not text:
        return None
    candidates = [
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
    ]
    for pattern in candidates:
        try:
            parsed = datetime.strptime(text.replace("Z", ""), pattern)
            if parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0:
                return parsed.strftime("%d/%m/%Y")
            return parsed.strftime("%d/%m/%Y %H:%M")
        except ValueError:
            continue
    return None

