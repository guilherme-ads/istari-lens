from __future__ import annotations

from typing import Any
from uuid import uuid4
from pathlib import Path
from functools import lru_cache
import json
import logging

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import LLMIntegration
from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.modules.widgets.domain.config import (
    FilterConfig,
    WidgetConfig,
    validate_widget_config_against_columns,
)

OPENAI_BASE_URL = "https://api.openai.com/v1"
DATASET_WIDGET_VIEW_NAME = "__dataset_base"
MAX_DASHBOARD_COLUMNS = 6
AI_DASHBOARD_MODEL_PATH = Path(__file__).resolve().parent / "templates" / "dashboard_model_template.json"
AI_DASHBOARD_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "dashboard_generation_system_prompt.txt"
LEGACY_JSON_OUTPUT_INSTRUCTION = (
    "Responda exclusivamente em JSON valido, sem markdown, no formato: "
    '{"explanation":"...","planning_steps":["..."],"native_filters":[{"column":"...","op":"eq|neq|gt|lt|gte|lte|in|not_in|contains|is_null|not_null|between","value":"...","visible":true}],"sections":[{"title":"...","columns":1,"widgets":[{"type":"kpi|line|bar|column|donut|table|text|dre","title":"...","width":1,"height":1,"config":{...}}]}]}.'
)
logger = logging.getLogger("uvicorn.error")
RELATIVE_DATE_PRESETS = {
    "today",
    "yesterday",
    "last_7_days",
    "last_30_days",
    "this_year",
    "this_month",
    "last_month",
}


def _normalize_raw_type_to_semantic(raw_type: str) -> str:
    value = (raw_type or "").lower()
    if any(token in value for token in ["int", "numeric", "decimal", "real", "double", "float", "money"]):
        return "numeric"
    if any(token in value for token in ["date", "time", "timestamp"]):
        return "temporal"
    if "bool" in value:
        return "boolean"
    return "text"


@lru_cache(maxsize=1)
def _load_dashboard_model_template() -> dict[str, Any]:
    fallback = {
        "format": "istari.dashboard.ai.template.v1",
        "allowed_widget_types": ["kpi", "line", "bar", "column", "donut", "table", "text", "dre"],
        "section": {"columns": [1, 2, 3, 4, 5, 6]},
        "widget_size": {"width": [1, 2, 3, 4, 5, 6], "height": [0.5, 1, 2]},
    }
    try:
        return json.loads(AI_DASHBOARD_MODEL_PATH.read_text(encoding="utf-8"))
    except Exception:
        return fallback


@lru_cache(maxsize=1)
def _load_dashboard_system_prompt() -> str:
    fallback = (
        "Voce projeta dashboards analiticos para o Lens. "
        "Use somente tipos de widget e campos suportados no modelo de referencia. "
        "Respeite colunas disponiveis do dataset e use a descricao de cada coluna para inferir significado de negocio."
    )
    try:
        raw = AI_DASHBOARD_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        return fallback
    return raw or fallback


def _active_openai_integration(db: Session) -> LLMIntegration | None:
    return (
        db.query(LLMIntegration)
        .filter(LLMIntegration.provider == "openai", LLMIntegration.is_active == True)
        .order_by(LLMIntegration.updated_at.desc())
        .first()
    )


def _setup_default_widget_config(
    *,
    widget_type: str,
    columns: list[dict[str, str]],
    title: str,
    width: int = 1,
    height: float = 1,
) -> dict:
    numeric = next((item for item in columns if item["type"] == "numeric"), None)
    temporal = next((item for item in columns if item["type"] == "temporal"), None)
    categorical = next((item for item in columns if item["type"] in {"text", "boolean"}), None)
    fallback = columns[0] if columns else {"name": "id", "type": "text"}

    config: dict = {
        "widget_type": widget_type,
        "view_name": DATASET_WIDGET_VIEW_NAME,
        "show_title": True,
        "visual_padding": "normal",
        "visual_palette": "default",
        "size": {"width": max(1, min(MAX_DASHBOARD_COLUMNS, int(width))), "height": height if height in {0.5, 1, 2} else 1},
        "metrics": [],
        "dimensions": [],
        "filters": [],
        "order_by": [],
    }

    if widget_type == "kpi":
        config.update({
            "kpi_show_as": "number_2",
            "kpi_decimals": 2,
            "kpi_show_trend": False,
            "kpi_type": "atomic",
            "formula": None,
            "dependencies": [],
            "kpi_dependencies": [],
            "composite_metric": None,
            "metrics": [{"op": "count", "column": numeric["name"] if numeric else fallback["name"]}],
        })
    elif widget_type == "line":
        config.update({
            "line_data_labels_enabled": False,
            "line_show_grid": True,
            "line_data_labels_percent": 60,
            "line_label_window": 3,
            "line_label_min_gap": 2,
            "line_label_mode": "both",
            "metrics": [{"op": "sum" if numeric else "count", "column": (numeric or fallback)["name"], "line_y_axis": "left"}],
            "time": {"column": (temporal or fallback)["name"], "granularity": "month"},
        })
    elif widget_type in {"bar", "column", "donut"}:
        config.update({
            "metrics": [{"op": "sum" if numeric else "count", "column": (numeric or fallback)["name"]}],
            "dimensions": [(categorical or fallback)["name"]],
            "bar_data_labels_enabled": widget_type in {"bar", "column"},
            "donut_show_legend": widget_type == "donut",
            "donut_data_labels_enabled": False if widget_type == "donut" else None,
            "donut_data_labels_min_percent": 6 if widget_type == "donut" else None,
            "donut_metric_display": "value" if widget_type == "donut" else None,
        })
    elif widget_type == "table":
        config.update({
            "columns": [item["name"] for item in columns[: min(8, len(columns))]] if columns else [fallback["name"]],
            "table_page_size": 25,
        })
    elif widget_type == "text":
        config.update({
            "text_style": {"content": title, "font_size": 18, "align": "left"},
        })
    elif widget_type == "dre":
        config.update({
            "dre_rows": [
                {
                    "title": title,
                    "row_type": "result",
                    "impact": "add",
                    "metrics": [{"op": "sum" if numeric else "count", "column": (numeric or fallback)["name"]}],
                }
            ],
            "dre_percent_base_row_index": 0,
        })
    else:
        config.update({
            "columns": [item["name"] for item in columns[: min(8, len(columns))]] if columns else [fallback["name"]],
        })
    return config


def _coerce_width(raw_value: Any, default: int) -> int:
    try:
        value = int(raw_value)
    except Exception:
        value = default
    return max(1, min(MAX_DASHBOARD_COLUMNS, value))


def _coerce_height(raw_value: Any, default: float) -> float:
    try:
        value = float(raw_value)
    except Exception:
        value = default
    return value if value in {0.5, 1.0, 2.0} else default


def _coerce_size_payload(raw_size: Any, *, default_width: int, default_height: float) -> dict[str, float | int]:
    if not isinstance(raw_size, dict):
        return {
            "width": _coerce_width(default_width, default_width),
            "height": _coerce_height(default_height, default_height),
        }
    return {
        "width": _coerce_width(raw_size.get("width"), default_width),
        "height": _coerce_height(raw_size.get("height"), default_height),
    }


def _coerce_section_columns(raw_value: Any, default: int = 2) -> int:
    if isinstance(raw_value, (int, float)):
        value = int(raw_value)
    elif isinstance(raw_value, str) and raw_value.isdigit():
        value = int(raw_value)
    else:
        value = default
    return value if 1 <= value <= MAX_DASHBOARD_COLUMNS else default


def _dashboard_plan_response_schema() -> dict[str, Any]:
    widget_types = ["kpi", "line", "bar", "column", "donut", "table", "text", "dre"]
    return {
        "name": "dashboard_plan",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "explanation": {"type": "string"},
                "planning_steps": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "native_filters": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "column": {"type": "string"},
                            "op": {
                                "type": "string",
                                "enum": [
                                    "eq",
                                    "neq",
                                    "gt",
                                    "lt",
                                    "gte",
                                    "lte",
                                    "in",
                                    "not_in",
                                    "contains",
                                    "is_null",
                                    "not_null",
                                    "between",
                                ],
                            },
                            "value": {},
                            "visible": {"type": "boolean"},
                        },
                        "required": ["column", "op"],
                    },
                },
                "sections": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string"},
                            "columns": {"type": "integer", "minimum": 1, "maximum": MAX_DASHBOARD_COLUMNS},
                            "widgets": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "type": {"type": "string", "enum": widget_types},
                                        "title": {"type": "string"},
                                        "width": {"type": "integer", "minimum": 1, "maximum": MAX_DASHBOARD_COLUMNS},
                                        "height": {"type": "number", "enum": [0.5, 1, 2]},
                                        "config": {"type": "object"},
                                    },
                                    "required": ["type", "title"],
                                },
                            },
                        },
                        "required": ["title", "columns", "widgets"],
                    },
                },
            },
            "required": ["explanation", "sections"],
        },
    }


def _normalize_planning_steps(raw_steps: Any, explanation: str) -> list[str]:
    normalized: list[str] = []
    if isinstance(raw_steps, list):
        for item in raw_steps:
            if not isinstance(item, str):
                continue
            value = item.strip()
            if not value:
                continue
            normalized.append(value.rstrip("."))
    if normalized:
        return normalized[:8]

    fallback_steps = [
        segment.strip().rstrip(".")
        for segment in explanation.split(".")
        if segment.strip()
    ]
    return fallback_steps[:5]


def _extract_plan_from_responses_output(data: dict[str, Any]) -> dict[str, Any] | None:
    top_level_output_text = data.get("output_text")
    if isinstance(top_level_output_text, str) and top_level_output_text.strip():
        try:
            return json.loads(top_level_output_text)
        except json.JSONDecodeError:
            start = top_level_output_text.find("{")
            end = top_level_output_text.rfind("}")
            if start >= 0 and end > start:
                try:
                    return json.loads(top_level_output_text[start:end + 1])
                except json.JSONDecodeError:
                    pass

    outputs = data.get("output", [])
    if not isinstance(outputs, list):
        return None

    text_chunks: list[str] = []
    for item in outputs:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "output_text":
            direct_text = item.get("text")
            if isinstance(direct_text, str):
                text_chunks.append(direct_text)
        content_items = item.get("content", [])
        if not isinstance(content_items, list):
            continue
        for content_item in content_items:
            if not isinstance(content_item, dict):
                continue
            raw_json = content_item.get("json")
            if isinstance(raw_json, dict):
                return raw_json
            if content_item.get("type") == "output_json":
                output_json = content_item.get("output_json")
                if isinstance(output_json, dict):
                    return output_json
            text_value = content_item.get("text")
            if isinstance(text_value, str):
                text_chunks.append(text_value)
            alt_text_value = content_item.get("output_text")
            if isinstance(alt_text_value, str):
                text_chunks.append(alt_text_value)

    raw_text = "\n".join(text_chunks).strip()
    if not raw_text:
        return None
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(raw_text[start:end + 1])
        return None


def _is_blank_filter_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def _is_relative_between_value(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    relative = value.get("relative")
    return isinstance(relative, str) and relative.strip() in RELATIVE_DATE_PRESETS


def _collect_filter_quality_issues(filters: list[FilterConfig]) -> list[str]:
    issues: list[str] = []
    for index, item in enumerate(filters):
        op = item.op
        value = item.value
        if op in {"is_null", "not_null"}:
            if value is not None:
                issues.append(f"filters[{index}] op='{op}' deveria vir sem value")
            continue
        if op == "between":
            if _is_relative_between_value(value):
                continue
            if not isinstance(value, list) or len(value) != 2 or any(_is_blank_filter_value(entry) for entry in value):
                issues.append(f"filters[{index}] op='between' requer array com 2 valores preenchidos")
            continue
        if op in {"in", "not_in"}:
            if not isinstance(value, list) or len([entry for entry in value if not _is_blank_filter_value(entry)]) < 1:
                issues.append(f"filters[{index}] op='{op}' requer lista com pelo menos um valor")
            continue
        if _is_blank_filter_value(value):
            issues.append(f"filters[{index}] op='{op}' requer value preenchido")
    return issues


def _sanitize_filter_payload(raw_filters: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_filters, list):
        return []
    sanitized: list[dict[str, Any]] = []
    for item in raw_filters:
        if not isinstance(item, dict):
            continue
        op = str(item.get("op") or "").strip().lower()
        column = item.get("column")
        if not isinstance(column, str) or not column.strip():
            continue
        if op in {"is_null", "not_null"}:
            sanitized.append({"column": column.strip(), "op": op})
            continue
        value = item.get("value")
        if op == "between":
            if _is_relative_between_value(value):
                sanitized.append({"column": column.strip(), "op": op, "value": {"relative": str(value.get("relative")).strip()}})
                continue
            if isinstance(value, list) and len(value) == 2 and all(not _is_blank_filter_value(entry) for entry in value):
                sanitized.append({"column": column.strip(), "op": op, "value": value})
            continue
        if op in {"in", "not_in"}:
            if isinstance(value, list):
                values = [entry for entry in value if not _is_blank_filter_value(entry)]
                if values:
                    sanitized.append({"column": column.strip(), "op": op, "value": values})
            continue
        if _is_blank_filter_value(value):
            continue
        sanitized.append({"column": column.strip(), "op": op or "eq", "value": value})
    return sanitized


def _sanitize_native_filter_payload(raw_filters: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_filters, list):
        return []
    sanitized: list[dict[str, Any]] = []
    for item in raw_filters:
        if not isinstance(item, dict):
            continue
        column = item.get("column")
        if not isinstance(column, str) or not column.strip():
            continue
        op = str(item.get("op") or "").strip().lower()
        if op not in {"eq", "neq", "gt", "lt", "gte", "lte", "in", "not_in", "contains", "is_null", "not_null", "between"}:
            op = "eq"
        visible = bool(item.get("visible", True))
        value = item.get("value")
        if op in {"is_null", "not_null"}:
            sanitized.append({"column": column.strip(), "op": op, "visible": visible})
            continue
        if op == "between":
            if _is_relative_between_value(value):
                sanitized.append(
                    {
                        "column": column.strip(),
                        "op": op,
                        "value": {"relative": str(value.get("relative")).strip()},
                        "visible": visible,
                    }
                )
                continue
            if isinstance(value, list) and len(value) == 2 and all(not _is_blank_filter_value(entry) for entry in value):
                sanitized.append({"column": column.strip(), "op": op, "value": value, "visible": visible})
            continue
        if op in {"in", "not_in"}:
            if isinstance(value, list):
                values = [entry for entry in value if not _is_blank_filter_value(entry)]
                if values:
                    sanitized.append({"column": column.strip(), "op": op, "value": values, "visible": visible})
            continue
        if _is_blank_filter_value(value):
            continue
        sanitized.append({"column": column.strip(), "op": op, "value": value, "visible": visible})
    return sanitized


def _compact_error_message(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").strip()
    if len(text) > 280:
        return text[:277] + "..."
    return text


def _summarize_candidate_config(raw_config: dict[str, Any]) -> dict[str, Any]:
    metrics = raw_config.get("metrics") if isinstance(raw_config.get("metrics"), list) else []
    dimensions = raw_config.get("dimensions") if isinstance(raw_config.get("dimensions"), list) else []
    filters = raw_config.get("filters") if isinstance(raw_config.get("filters"), list) else []
    columns = raw_config.get("columns") if isinstance(raw_config.get("columns"), list) else []
    size = raw_config.get("size") if isinstance(raw_config.get("size"), dict) else {}
    return {
        "widget_type": raw_config.get("widget_type"),
        "metrics_count": len(metrics),
        "dimensions_count": len(dimensions),
        "filters_count": len(filters),
        "columns_count": len(columns),
        "has_time": isinstance(raw_config.get("time"), dict),
        "size": {
            "width": size.get("width"),
            "height": size.get("height"),
        },
    }


def _sanitize_order_by_payload(
    raw_order_by: Any,
    *,
    widget_type: str,
    metrics: list[Any],
    dimensions: list[Any],
) -> list[dict[str, Any]]:
    if not isinstance(raw_order_by, list) or len(raw_order_by) == 0:
        return []
    first = raw_order_by[0]
    if not isinstance(first, dict):
        return []

    direction = str(first.get("direction") or "desc").lower()
    safe_direction = "asc" if direction == "asc" else "desc"

    valid_metric_refs = {f"m{i}" for i in range(len(metrics))}
    raw_metric_ref = first.get("metric_ref")
    if isinstance(raw_metric_ref, str) and raw_metric_ref.strip():
        metric_ref = raw_metric_ref.strip()
        if metric_ref in valid_metric_refs:
            return [{"metric_ref": metric_ref, "direction": safe_direction}]
        if widget_type in {"bar", "column", "donut"} and len(metrics) > 0:
            return [{"metric_ref": "m0", "direction": safe_direction}]

    raw_column = first.get("column")
    if isinstance(raw_column, str) and raw_column.strip():
        column = raw_column.strip()
        if widget_type in {"bar", "column", "donut"}:
            if len(dimensions) > 0 and isinstance(dimensions[0], str):
                if column == dimensions[0]:
                    return [{"column": column, "direction": safe_direction}]
                return [{"column": dimensions[0], "direction": safe_direction}]
            return []
        return [{"column": column, "direction": safe_direction}]

    if widget_type in {"bar", "column", "donut"}:
        if len(metrics) > 0:
            return [{"metric_ref": "m0", "direction": safe_direction}]
        if len(dimensions) > 0 and isinstance(dimensions[0], str):
            return [{"column": dimensions[0], "direction": safe_direction}]
    return []


def _attempt_auto_repair_config(
    *,
    candidate_config: dict[str, Any],
    fallback_config: dict[str, Any],
    widget_type: str,
) -> dict[str, Any]:
    repaired = dict(candidate_config)
    repaired["filters"] = _sanitize_filter_payload(repaired.get("filters"))
    repaired["order_by"] = repaired.get("order_by") if isinstance(repaired.get("order_by"), list) else []
    repaired["metrics"] = repaired.get("metrics") if isinstance(repaired.get("metrics"), list) else []
    repaired["dimensions"] = repaired.get("dimensions") if isinstance(repaired.get("dimensions"), list) else []

    if widget_type == "kpi":
        if len(repaired["metrics"]) != 1 and repaired.get("composite_metric") is None and repaired.get("kpi_type", "atomic") != "derived":
            repaired["metrics"] = fallback_config.get("metrics", [])
    elif widget_type == "line":
        if len(repaired["metrics"]) < 1:
            repaired["metrics"] = fallback_config.get("metrics", [])
        if not isinstance(repaired.get("time"), dict):
            repaired["time"] = fallback_config.get("time")
    elif widget_type in {"bar", "column", "donut"}:
        if len(repaired["metrics"]) != 1:
            repaired["metrics"] = fallback_config.get("metrics", [])
        if len(repaired["dimensions"]) != 1:
            repaired["dimensions"] = fallback_config.get("dimensions", [])
    elif widget_type == "table":
        cols = repaired.get("columns")
        if not isinstance(cols, list) or len(cols) < 1:
            repaired["columns"] = fallback_config.get("columns", [])
        repaired["metrics"] = []
    elif widget_type == "text":
        if not isinstance(repaired.get("text_style"), dict):
            repaired["text_style"] = fallback_config.get("text_style")
        repaired["metrics"] = []
        repaired["dimensions"] = []
        repaired["filters"] = []
        repaired["order_by"] = []
    elif widget_type == "dre":
        rows = repaired.get("dre_rows")
        if not isinstance(rows, list) or len(rows) < 1:
            repaired["dre_rows"] = fallback_config.get("dre_rows", [])
        repaired["metrics"] = []
        repaired["dimensions"] = []
        repaired["order_by"] = []

    repaired["order_by"] = _sanitize_order_by_payload(
        repaired.get("order_by"),
        widget_type=widget_type,
        metrics=repaired.get("metrics") if isinstance(repaired.get("metrics"), list) else [],
        dimensions=repaired.get("dimensions") if isinstance(repaired.get("dimensions"), list) else [],
    )

    return repaired


async def _generate_dashboard_plan_with_openai(
    *,
    api_key: str,
    model: str,
    dataset_name: str,
    columns: list[dict[str, str]],
    prompt: str,
) -> dict:
    model_template = _load_dashboard_model_template()
    system_prompt = _load_dashboard_system_prompt()
    input_payload = [
        {
            "role": "system",
            "content": system_prompt,
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "task": "Gerar plano de dashboard em secoes e widgets",
                    "dataset": dataset_name,
                    "columns": columns,
                    "prompt": prompt or "Dashboard completo de visao geral",
                    "dashboard_model_reference": model_template,
                },
                ensure_ascii=False,
            ),
        },
    ]
    payload_with_schema = {
        "model": model,
        "store": False,
        "input": input_payload,
        "text": {
            "format": {
                "type": "json_schema",
                "json_schema": _dashboard_plan_response_schema(),
            }
        },
    }
    payload_legacy = {
        "model": model,
        "store": False,
        "input": [
            {
                "role": "system",
                "content": f"{system_prompt}\n{LEGACY_JSON_OUTPUT_INSTRUCTION}",
            },
            input_payload[1],
        ],
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(f"{OPENAI_BASE_URL}/responses", headers=headers, json=payload_with_schema)
        if response.status_code >= 400:
            # Compatibility fallback for models/endpoints that do not accept schema formatting.
            response = await client.post(f"{OPENAI_BASE_URL}/responses", headers=headers, json=payload_legacy)
    if response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Falha ao gerar dashboard com IA.")

    data = response.json()
    parsed = _extract_plan_from_responses_output(data)
    if isinstance(parsed, dict):
        return parsed
    logger.warning(
        "AI dashboard generation returned unparsable payload: model=%s keys=%s",
        model,
        sorted([str(key) for key in data.keys()]) if isinstance(data, dict) else [],
    )
    raise HTTPException(status_code=400, detail="Resposta da IA em formato invalido.")


async def generate_dashboard_with_ai_service(
    *,
    db: Session,
    dataset_name: str,
    column_types: dict[str, str],
    semantic_columns: list[dict[str, Any]] | None,
    prompt: str,
    title: str | None,
) -> dict[str, Any]:
    integration = _active_openai_integration(db)
    if not integration:
        raise HTTPException(status_code=400, detail="Nenhuma integracao OpenAI ativa foi encontrada.")
    try:
        api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
    except Exception:
        raise HTTPException(status_code=400, detail="Falha ao ler credenciais da integracao OpenAI ativa.")

    columns: list[dict[str, str]] = []
    semantic_by_name: dict[str, dict[str, Any]] = {}
    for item in semantic_columns or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        semantic_by_name[name.strip()] = item

    for name, raw_type in column_types.items():
        semantic = semantic_by_name.get(name, {})
        raw_description = semantic.get("description")
        description = (
            str(raw_description).strip()
            if isinstance(raw_description, str) and str(raw_description).strip()
            else name
        )
        columns.append(
            {
                "name": name,
                "type": _normalize_raw_type_to_semantic(raw_type),
                "description": description,
            }
        )
    plan = await _generate_dashboard_plan_with_openai(
        api_key=api_key,
        model=integration.model or "gpt-4o-mini",
        dataset_name=dataset_name,
        columns=columns,
        prompt=prompt,
    )
    explanation = str(plan.get("explanation") or "Estrutura gerada com base no prompt e nas colunas disponiveis.")
    planning_steps = _normalize_planning_steps(plan.get("planning_steps"), explanation)
    raw_native_filters = plan.get("native_filters")
    response_native_filters: list[dict[str, Any]] = []
    for filter_index, raw_native_filter in enumerate(_sanitize_native_filter_payload(raw_native_filters)):
        try:
            parsed_native_filter = FilterConfig.model_validate(raw_native_filter)
            validate_widget_config_against_columns(
                WidgetConfig.model_validate(
                    {
                        "widget_type": "kpi",
                        "view_name": DATASET_WIDGET_VIEW_NAME,
                        "metrics": [{"op": "count"}],
                        "dimensions": [],
                        "filters": [parsed_native_filter.model_dump(mode="json")],
                        "order_by": [],
                    }
                ),
                column_types,
            )
            response_native_filters.append(
                {
                    "column": parsed_native_filter.column,
                    "op": parsed_native_filter.op,
                    "value": parsed_native_filter.value,
                    "visible": bool(raw_native_filter.get("visible", True)),
                }
            )
        except Exception as exc:
            audit_issues_item = {
                "native_filter_index": filter_index,
                "issues": [f"native_filter invalido retornado pela IA: {_compact_error_message(exc)}"],
            }
            logger.warning(
                "AI dashboard generation native filter issue: dataset=%s issue=%s",
                dataset_name,
                json.dumps(audit_issues_item, ensure_ascii=False),
            )

    raw_sections = plan.get("sections") if isinstance(plan.get("sections"), list) else []
    audit_issues: list[dict[str, Any]] = []

    response_sections: list[dict[str, Any]] = []
    section_count = 0
    for section_index, section in enumerate(raw_sections):
        if not isinstance(section, dict):
            continue
        section_columns = _coerce_section_columns(section.get("columns"), default=2)
        raw_widgets = section.get("widgets") if isinstance(section.get("widgets"), list) else []
        widgets: list[dict[str, Any]] = []
        for widget_index, raw_widget in enumerate(raw_widgets):
            if not isinstance(raw_widget, dict):
                continue
            provided_config = raw_widget.get("config")
            config_widget_type = (
                str(provided_config.get("widget_type")).lower()
                if isinstance(provided_config, dict) and isinstance(provided_config.get("widget_type"), str)
                else None
            )
            widget_type = str(raw_widget.get("type") or config_widget_type or "table").lower()
            if widget_type not in {"kpi", "line", "bar", "column", "donut", "table", "text", "dre"}:
                widget_type = "table"
            default_width = min(section_columns, MAX_DASHBOARD_COLUMNS if widget_type in {"line", "table"} else 1)
            default_height = 2 if widget_type in {"line", "table"} else 1
            requested_width = _coerce_width(raw_widget.get("width"), default_width)
            width = min(section_columns, requested_width)
            height = _coerce_height(raw_widget.get("height"), default_height)
            widget_title = str(raw_widget.get("title") or f"{widget_type.upper()} {widget_index + 1}")
            fallback_config = _setup_default_widget_config(
                widget_type=widget_type,
                columns=columns,
                title=widget_title,
                width=width,
                height=height,
            )

            config: dict[str, Any] = fallback_config
            used_fallback_config = False
            used_auto_repair = False
            invalid_config_reason: str | None = None
            candidate_config_summary: dict[str, Any] | None = None
            if isinstance(provided_config, dict):
                candidate_config = dict(provided_config)
                candidate_config["widget_type"] = widget_type
                candidate_config["view_name"] = DATASET_WIDGET_VIEW_NAME

                candidate_size = _coerce_size_payload(
                    candidate_config.get("size"),
                    default_width=default_width,
                    default_height=default_height,
                )
                candidate_size["width"] = min(section_columns, _coerce_width(candidate_size.get("width"), default_width))
                if "width" in raw_widget:
                    candidate_size["width"] = width
                if "height" in raw_widget:
                    candidate_size["height"] = height
                candidate_config["size"] = candidate_size
                candidate_config_summary = _summarize_candidate_config(candidate_config)

                try:
                    parsed = WidgetConfig.model_validate(candidate_config)
                    validate_widget_config_against_columns(parsed, column_types)
                    config = parsed.model_dump(mode="json")
                except Exception as exc:
                    invalid_config_reason = _compact_error_message(exc)
                    repaired_candidate = _attempt_auto_repair_config(
                        candidate_config=candidate_config,
                        fallback_config=fallback_config,
                        widget_type=widget_type,
                    )
                    try:
                        repaired_parsed = WidgetConfig.model_validate(repaired_candidate)
                        validate_widget_config_against_columns(repaired_parsed, column_types)
                        config = repaired_parsed.model_dump(mode="json")
                        used_auto_repair = True
                    except Exception:
                        config = fallback_config
                        used_fallback_config = True

            parsed_final_config: WidgetConfig | None = None
            try:
                parsed_final_config = WidgetConfig.model_validate(config)
                validate_widget_config_against_columns(parsed_final_config, column_types)
            except Exception:
                config = _setup_default_widget_config(
                    widget_type="table",
                    columns=columns,
                    title=widget_title,
                    width=min(section_columns, MAX_DASHBOARD_COLUMNS),
                    height=2,
                )
                parsed_final_config = WidgetConfig.model_validate(config)
                validate_widget_config_against_columns(parsed_final_config, column_types)
                used_fallback_config = True

            filter_issues = _collect_filter_quality_issues(parsed_final_config.filters)
            if filter_issues:
                audit_issues.append(
                    {
                        "section_index": section_index,
                        "widget_index": widget_index,
                        "widget_title": widget_title,
                        "widget_type": parsed_final_config.widget_type,
                        "issues": filter_issues,
                    }
                )
            if invalid_config_reason:
                issues = [f"config invalido retornado pela IA: {invalid_config_reason}"]
                if used_auto_repair:
                    issues.append("auto-repair aplicado antes da validacao final")
                if used_fallback_config:
                    issues.append("fallback aplicado")
                if requested_width > section_columns:
                    issues.append("width ajustado para respeitar o limite de colunas da secao")
                audit_issues.append(
                    {
                        "section_index": section_index,
                        "widget_index": widget_index,
                        "widget_title": widget_title,
                        "widget_type": widget_type,
                        "issues": issues,
                        "config_summary": candidate_config_summary,
                    }
                )
            if used_fallback_config and not invalid_config_reason:
                audit_issues.append(
                    {
                        "section_index": section_index,
                        "widget_index": widget_index,
                        "widget_title": widget_title,
                        "widget_type": widget_type,
                        "issues": ["config invalido retornado pela IA; fallback aplicado"],
                    }
                )
            if requested_width > section_columns:
                audit_issues.append(
                    {
                        "section_index": section_index,
                        "widget_index": widget_index,
                        "widget_title": widget_title,
                        "widget_type": widget_type,
                        "issues": [f"width {requested_width} ajustado para {section_columns} (columns da secao)"],
                    }
                )

            widgets.append(
                {
                    "id": f"tmp-ai-{section_index}-{widget_index}-{uuid4().hex[:6]}",
                    "title": widget_title,
                    "position": widget_index,
                    "config_version": 1,
                    "config": config,
                }
            )
        section_title = str(section.get("title") or f"Secao {section_index + 1}")
        response_sections.append(
            {
                "id": f"sec-ai-{section_index}-{uuid4().hex[:6]}",
                "title": section_title,
                "show_title": True,
                "columns": section_columns,
                "widgets": widgets,
            }
        )
        section_count += 1

    if audit_issues:
        logger.warning(
            "AI dashboard generation audit issues: dataset=%s issues=%s",
            dataset_name,
            json.dumps(audit_issues[:20], ensure_ascii=False),
        )

    if section_count == 0:
        response_sections = [
            {
                "id": f"sec-ai-fallback-{uuid4().hex[:6]}",
                "title": "Visao Geral",
                "show_title": True,
                "columns": 2,
                "widgets": [],
            }
        ]
        explanation = "Nao foi possivel gerar widgets com seguranca. Criamos uma secao base para voce ajustar."
        planning_steps = _normalize_planning_steps(
            [],
            "Validei o retorno da IA e apliquei fallback seguro. Estruturei uma secao base para voce continuar.",
        )

    return {
        "title": (title or "").strip() or "Novo Dashboard",
        "explanation": explanation,
        "planning_steps": planning_steps,
        "native_filters": response_native_filters,
        "sections": response_sections,
    }
