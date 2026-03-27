from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException

FORBIDDEN_AGGREGATION_FUNCTIONS = {"sum", "avg", "count", "min", "max"}
ROW_LEVEL_AGGREGATION_ERROR = "Agregacoes nao sao permitidas em colunas calculadas. Use metricas para isso."

ALLOWED_EXPR_OPS = {
    "add",
    "sub",
    "mul",
    "div",
    "mod",
    "concat",
    "coalesce",
    "nullif",
    "lower",
    "upper",
    "substring",
    "trim",
    "date_trunc",
    "extract",
    "abs",
    "round",
    "ceil",
    "floor",
    "case_when",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "and",
    "or",
    "not",
}

ALLOWED_ROW_LEVEL_FUNCTIONS = {
    "matematica": ["abs", "round", "ceil", "floor"],
    "nulos_e_seguranca": ["coalesce", "nullif"],
    "texto": ["concat", "lower", "upper", "substring", "trim"],
    "data": ["date_trunc", "extract"],
    "logica": ["case when"],
}

_AGGREGATION_REGEX = re.compile(r"\b(sum|avg|count|min|max)\s*\(", re.IGNORECASE)


def raise_row_level_aggregation_error(*, field: str | None = None) -> None:
    if field:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Dataset base_query_spec validation failed",
                "field_errors": {field: [ROW_LEVEL_AGGREGATION_ERROR]},
            },
        )
    raise HTTPException(status_code=400, detail=ROW_LEVEL_AGGREGATION_ERROR)


def contains_forbidden_aggregation_formula(formula: str) -> bool:
    return bool(_AGGREGATION_REGEX.search(formula or ""))


def validate_no_forbidden_aggregation(
    node: Any,
    *,
    field: str,
) -> None:
    if not isinstance(node, dict):
        return

    formula = node.get("formula")
    if isinstance(formula, str) and contains_forbidden_aggregation_formula(formula):
        raise_row_level_aggregation_error(field=field)

    op = node.get("op")
    if isinstance(op, str) and op.strip().lower() in FORBIDDEN_AGGREGATION_FUNCTIONS:
        raise_row_level_aggregation_error(field=field)

    args = node.get("args")
    if isinstance(args, list):
        for idx, item in enumerate(args):
            validate_no_forbidden_aggregation(item, field=f"{field}.args[{idx}]")


def build_computed_expression_catalog() -> dict[str, Any]:
    return {
        "mode": "row_level",
        "description": "Expressoes calculadas por linha. Agregacoes verticais nao sao permitidas.",
        "forbidden_aggregations": sorted(FORBIDDEN_AGGREGATION_FUNCTIONS),
        "allowed_functions": ALLOWED_ROW_LEVEL_FUNCTIONS,
        "allowed_operators": ["+", "-", "*", "/", "%"],
        "examples": [
            "receita - custo",
            "valor * 0.1",
            "coalesce(desconto, 0)",
            "case when status = 'ativo' then 1 else 0 end",
        ],
    }

