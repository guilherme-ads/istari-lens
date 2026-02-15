
import asyncio
import difflib
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from time import perf_counter
from typing import Any, Union

import httpx
from fastapi import APIRouter, Depends, HTTPException
from psycopg import AsyncConnection
from cryptography.fernet import InvalidToken
from sqlalchemy.orm import Session

from app.crypto import credential_encryptor
from app.database import get_analytics_connection, get_db
from app.dependencies import get_current_admin_user, get_current_user
from app.external_query_logging import log_external_query
from app.models import Dataset, LLMIntegration, LLMIntegrationBillingSnapshot, User
from app.query_builder import build_widget_query
from app.schemas import (
    InsightAnswerResponse,
    InsightCalculationResponse,
    InsightChatRequest,
    InsightClarificationResponse,
    InsightErrorResponse,
    InsightLLMContext,
    InsightPlanPeriod,
    InsightQueryPlan,
    LLMIntegrationCreateRequest,
    LLMIntegrationBillingRefreshResponse,
    LLMIntegrationItemResponse,
    LLMIntegrationListResponse,
    LLMIntegrationResponse,
    OpenAIIntegrationTestRequest,
    OpenAIIntegrationTestResponse,
    OpenAIIntegrationUpsertRequest,
    QueryPreviewResponse,
    QuerySpec,
)
from app.settings import get_settings
from app.widget_config import FilterConfig, MetricConfig, OrderByConfig, TimeConfig, WidgetConfig, normalize_column_type

router = APIRouter(prefix="/insights", tags=["insights"])
settings = get_settings()
logger = logging.getLogger("uvicorn.error")
OPENAI_BASE_URL = "https://api.openai.com/v1"

MAX_PLAN_LIMIT = int(getattr(settings, "insights_plan_limit_max", 500))
MAX_RESULT_ROWS = int(getattr(settings, "insights_result_rows_max", 1000))
PLAN_COST_LIMIT = int(getattr(settings, "insights_plan_cost_limit", 8000))
QUERY_CACHE_TTL_SECONDS = int(getattr(settings, "insights_query_cache_ttl_seconds", 45))
QUERY_CACHE_MAX_ENTRIES = int(getattr(settings, "insights_query_cache_max_entries", 300))
QUERY_TIMEOUT_SECONDS = int(getattr(settings, "insights_query_timeout_seconds", 20))
DEFAULT_TIMEZONE = str(getattr(settings, "insights_default_timezone", "America/Sao_Paulo"))
BILLING_WINDOW_DAYS = max(1, int(getattr(settings, "insights_billing_window_days", 30)))
BILLING_MONTHLY_BUDGET_USD = float(getattr(settings, "insights_billing_monthly_budget_usd", 0.0))
LLM_MODEL_PRICING_PER_1M_TOKENS_USD: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
}


@dataclass
class CachedInsightResponse:
    payload: InsightAnswerResponse
    expires_at: datetime


@dataclass
class CachedQueryResponse:
    payload: QueryPreviewResponse
    sql: str
    params: list[Any]
    execution_time_ms: int
    expires_at: datetime


@dataclass
class QueryExecutionResult:
    payload: QueryPreviewResponse
    sql: str
    params: list[Any]
    execution_time_ms: int
    cache_hit: bool
    deduped: bool


@dataclass
class PlannerResult:
    action: str
    interpreted_question: str
    clarification_question: str
    query_plan_raw: dict[str, Any] | None
    response_id: str | None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


@dataclass
class AnswerResult:
    answer: str
    response_id: str | None
    input_tokens: int
    output_tokens: int
    total_tokens: int


_chat_cache: dict[str, CachedInsightResponse] = {}
_chat_cache_lock = asyncio.Lock()
_query_cache: dict[str, CachedQueryResponse] = {}
_query_cache_lock = asyncio.Lock()
_inflight_queries: dict[str, asyncio.Future[QueryExecutionResult]] = {}
_inflight_lock = asyncio.Lock()

CACHE_TTL_SECONDS = int(getattr(settings, "insights_chat_cache_ttl_seconds", 45))
MAX_CACHE_ENTRIES = int(getattr(settings, "insights_chat_cache_max_entries", 300))


def _dev_debug_enabled() -> bool:
    is_dev = str(getattr(settings, "environment", "")).lower() == "development"
    enabled = bool(getattr(settings, "insights_dev_debug_logs", True))
    return is_dev and enabled


def _log_dev_step(step: str, **fields: Any) -> None:
    if not _dev_debug_enabled():
        return
    payload = " ".join([f"{key}={repr(value)}" for key, value in fields.items()])
    logger.info("insights_dev | step=%s %s", step, payload)


def _push_stage(stages: list[str], stage: str) -> None:
    if stage not in stages:
        stages.append(stage)


def _mask_api_key(api_key: str) -> str:
    if len(api_key) <= 8:
        return "********"
    return f"{api_key[:4]}...{api_key[-4:]}"


def _extract_usage_tokens(data: dict[str, Any]) -> tuple[int, int, int]:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return 0, 0, 0

    def _as_int(value: Any) -> int:
        try:
            parsed = int(value)
            return parsed if parsed > 0 else 0
        except Exception:
            return 0

    input_tokens = _as_int(usage.get("input_tokens"))
    output_tokens = _as_int(usage.get("output_tokens"))
    total_tokens = _as_int(usage.get("total_tokens"))
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens
    return input_tokens, output_tokens, total_tokens


def _estimate_llm_cost_usd(model: str, *, input_tokens: int, output_tokens: int) -> float:
    if input_tokens <= 0 and output_tokens <= 0:
        return 0.0

    model_key = (model or "").strip().lower()
    input_price, output_price = LLM_MODEL_PRICING_PER_1M_TOKENS_USD.get(model_key, (0.15, 0.60))
    estimated = (input_tokens / 1_000_000.0) * input_price + (output_tokens / 1_000_000.0) * output_price
    return round(estimated, 8)


def _normalize_question(question: str) -> str:
    return " ".join(question.lower().strip().split())


def _chat_cache_key(dataset_id: int, question: str) -> str:
    return f"{dataset_id}:{_normalize_question(question)}"


def _query_cache_key(dataset_id: int, sql: str, params: list[Any]) -> str:
    raw = json.dumps({"dataset_id": dataset_id, "sql": sql, "params": params}, default=str, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def _chat_cache_get(dataset_id: int, question: str) -> InsightAnswerResponse | None:
    now = datetime.now(timezone.utc)
    key = _chat_cache_key(dataset_id, question)
    async with _chat_cache_lock:
        entry = _chat_cache.get(key)
        if not entry:
            return None
        if entry.expires_at <= now:
            _chat_cache.pop(key, None)
            return None
        return entry.payload.model_copy(update={"cache_hit": True})


async def _chat_cache_set(payload: InsightAnswerResponse, question: str) -> None:
    now = datetime.now(timezone.utc)
    key = _chat_cache_key(payload.query_config.datasetId, question)
    entry = CachedInsightResponse(
        payload=payload.model_copy(update={"cache_hit": False}),
        expires_at=now + timedelta(seconds=CACHE_TTL_SECONDS),
    )
    async with _chat_cache_lock:
        expired = [cache_key for cache_key, value in _chat_cache.items() if value.expires_at <= now]
        for cache_key in expired:
            _chat_cache.pop(cache_key, None)
        if len(_chat_cache) >= MAX_CACHE_ENTRIES:
            oldest_key = min(_chat_cache, key=lambda cache_key: _chat_cache[cache_key].expires_at)
            _chat_cache.pop(oldest_key, None)
        _chat_cache[key] = entry


async def _query_cache_get(key: str) -> CachedQueryResponse | None:
    now = datetime.now(timezone.utc)
    async with _query_cache_lock:
        entry = _query_cache.get(key)
        if not entry:
            return None
        if entry.expires_at <= now:
            _query_cache.pop(key, None)
            return None
        return entry


async def _query_cache_set(key: str, payload: QueryExecutionResult) -> None:
    now = datetime.now(timezone.utc)
    entry = CachedQueryResponse(
        payload=payload.payload,
        sql=payload.sql,
        params=payload.params,
        execution_time_ms=payload.execution_time_ms,
        expires_at=now + timedelta(seconds=QUERY_CACHE_TTL_SECONDS),
    )
    async with _query_cache_lock:
        expired = [cache_key for cache_key, value in _query_cache.items() if value.expires_at <= now]
        for cache_key in expired:
            _query_cache.pop(cache_key, None)
        if len(_query_cache) >= QUERY_CACHE_MAX_ENTRIES:
            oldest_key = min(_query_cache, key=lambda cache_key: _query_cache[cache_key].expires_at)
            _query_cache.pop(oldest_key, None)
        _query_cache[key] = entry


def _get_openai_integration(db: Session) -> LLMIntegration | None:
    return (
        db.query(LLMIntegration)
        .filter(LLMIntegration.provider == "openai", LLMIntegration.is_active == True)
        .order_by(LLMIntegration.updated_at.desc())
        .first()
    )


def _list_openai_integrations(db: Session) -> list[LLMIntegration]:
    return (
        db.query(LLMIntegration)
        .filter(LLMIntegration.provider == "openai")
        .order_by(LLMIntegration.is_active.desc(), LLMIntegration.updated_at.desc(), LLMIntegration.id.desc())
        .all()
    )


def _extract_billing_total_usd(payload: Any) -> float:
    total = 0.0
    buckets: list[Any] = []

    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            buckets = data
    elif isinstance(payload, list):
        buckets = payload

    if buckets:
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            results = bucket.get("results")
            if not isinstance(results, list):
                continue
            for result in results:
                if not isinstance(result, dict):
                    continue
                amount = result.get("amount")
                if not isinstance(amount, dict):
                    continue
                value = amount.get("value")
                if isinstance(value, (int, float)):
                    total += float(value)
        return round(total, 6)

    # Backward-compatible fallback for unexpected payloads.
    def walk(node: Any) -> None:
        nonlocal total
        if isinstance(node, dict):
            amount = node.get("amount")
            if isinstance(amount, dict):
                value = amount.get("value")
                if isinstance(value, (int, float)):
                    total += float(value)
            for value in node.values():
                walk(value)
            return
        if isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return round(total, 6)


def _latest_billing_snapshot(integration: LLMIntegration) -> LLMIntegrationBillingSnapshot | None:
    snapshots = integration.billing_snapshots or []
    if not snapshots:
        return None
    return max(snapshots, key=lambda item: item.fetched_at)


def _integration_to_item_response(integration: LLMIntegration) -> LLMIntegrationItemResponse:
    try:
        api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
        masked_key = _mask_api_key(api_key)
    except Exception:
        masked_key = "********"

    snapshot = _latest_billing_snapshot(integration)
    spent_usd = float(snapshot.spent_usd) if snapshot and snapshot.spent_usd is not None else None
    budget_usd = float(snapshot.budget_usd) if snapshot and snapshot.budget_usd is not None else None
    remaining_usd = float(snapshot.estimated_remaining_usd) if snapshot and snapshot.estimated_remaining_usd is not None else None

    return LLMIntegrationItemResponse(
        id=integration.id,
        provider="openai",
        model=integration.model,
        masked_api_key=masked_key,
        is_active=bool(integration.is_active),
        created_at=integration.created_at,
        updated_at=integration.updated_at,
        created_by_id=integration.created_by_id,
        updated_by_id=integration.updated_by_id,
        billing_spent_usd=spent_usd,
        billing_budget_usd=budget_usd,
        billing_estimated_remaining_usd=remaining_usd,
        billing_period_start=snapshot.period_start if snapshot else None,
        billing_period_end=snapshot.period_end if snapshot else None,
        billing_fetched_at=snapshot.fetched_at if snapshot else None,
    )


def _activate_integration(db: Session, target: LLMIntegration, actor_user_id: int) -> None:
    db.query(LLMIntegration).filter(
        LLMIntegration.provider == target.provider,
        LLMIntegration.id != target.id,
        LLMIntegration.is_active == True,
    ).update({"is_active": False, "updated_by_id": actor_user_id}, synchronize_session=False)
    target.is_active = True
    target.updated_by_id = actor_user_id


def _build_column_suggestions(missing_column: str, available_columns: list[str]) -> list[str]:
    return difflib.get_close_matches(missing_column, available_columns, n=3, cutoff=0.55)


def _extract_missing_column_from_error(detail: str) -> str | None:
    patterns = [
        "Column '",
        "column '",
        'column "',
        "UndefinedColumn",
    ]
    if "UndefinedColumn" not in detail and "column" not in detail.lower():
        return None

    marker_single = "column '"
    idx = detail.lower().find(marker_single)
    if idx >= 0:
        start = idx + len(marker_single)
        end = detail.find("'", start)
        if end > start:
            return detail[start:end]

    marker_double = 'column "'
    idx = detail.lower().find(marker_double)
    if idx >= 0:
        start = idx + len(marker_double)
        end = detail.find('"', start)
        if end > start:
            return detail[start:end]

    return None


def _is_missing_relation_error(detail: str) -> bool:
    lowered = detail.lower()
    return "undefinedtable" in lowered or 'relation "' in lowered and "does not exist" in lowered


def _extract_openai_response_text(data: dict[str, Any]) -> str | None:
    direct = data.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    output = data.get("output")
    if isinstance(output, list):
        chunks: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for content_item in content:
                if not isinstance(content_item, dict):
                    continue
                text = content_item.get("text")
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        if chunks:
            return "\n".join(chunks).strip()
    return None


async def _openai_chat_completion(
    api_key: str,
    model: str,
    messages: list[dict],
    response_format: dict | None = None,
    previous_response_id: str | None = None,
) -> dict:
    payload: dict[str, Any] = {
        "model": model,
        "input": messages,
        "store": False,
    }
    if previous_response_id:
        payload["previous_response_id"] = previous_response_id
    if response_format and response_format.get("type") == "json_object":
        payload["text"] = {"format": {"type": "json_object"}}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(f"{OPENAI_BASE_URL}/responses", headers=headers, json=payload)
        if response.status_code >= 400 and previous_response_id:
            detail = ""
            try:
                body = response.json()
                detail = str(body.get("error", {}).get("message") or "")
            except Exception:
                detail = ""
            if response.status_code == 400 and "previous response" in detail.lower() and "not found" in detail.lower():
                payload_no_context = dict(payload)
                payload_no_context.pop("previous_response_id", None)
                _log_dev_step(
                    "openai_previous_response_missing_retry_without_context",
                    model=model,
                    previous_response_id=previous_response_id,
                )
                response = await client.post(f"{OPENAI_BASE_URL}/responses", headers=headers, json=payload_no_context)

    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body.get("error", {}).get("message") or "OpenAI request failed"
        except Exception:
            detail = "OpenAI request failed"
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=400, detail="OpenAI API key invalida ou sem permissao")
        raise HTTPException(status_code=400, detail=f"Falha ao chamar OpenAI: {detail}")

    data = response.json()
    content = _extract_openai_response_text(data)
    if not content:
        raise HTTPException(status_code=400, detail="Resposta sem conteudo da OpenAI")
    response_id = data.get("id")
    input_tokens, output_tokens, total_tokens = _extract_usage_tokens(data)
    return {
        "content": content.strip(),
        "response_id": response_id if isinstance(response_id, str) else None,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


async def _fetch_openai_costs(*, api_key: str, start_time: datetime, end_time: datetime) -> float:
    base_params = {
        "start_time": int(start_time.timestamp()),
        "end_time": int(end_time.timestamp()),
        "bucket_width": "1d",
        "limit": 180,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    total_spent = 0.0
    next_page: str | None = None
    async with httpx.AsyncClient(timeout=25.0) as client:
        while True:
            params = dict(base_params)
            if next_page:
                params["page"] = next_page
            response = await client.get(f"{OPENAI_BASE_URL}/organization/costs", headers=headers, params=params)
            if response.status_code >= 400:
                if response.status_code in {401, 403}:
                    raise HTTPException(
                        status_code=400,
                        detail="Chave OpenAI sem permissao para consultar custos de organizacao (use uma Admin Key).",
                    )
                raise HTTPException(status_code=400, detail="Falha ao consultar custos da OpenAI para a integracao")
            data = response.json()
            total_spent += _extract_billing_total_usd(data)
            if not bool(data.get("has_more")):
                break
            raw_next_page = data.get("next_page")
            if not isinstance(raw_next_page, str) or not raw_next_page.strip():
                break
            next_page = raw_next_page
    return round(total_spent, 6)


async def _refresh_integration_billing_snapshot(
    *,
    db: Session,
    integration: LLMIntegration,
    actor_user_id: int,
    now_utc: datetime,
) -> None:
    api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
    period_end = now_utc
    period_start = now_utc - timedelta(days=BILLING_WINDOW_DAYS)
    spent_usd = await _fetch_openai_costs(api_key=api_key, start_time=period_start, end_time=period_end)
    budget_usd = BILLING_MONTHLY_BUDGET_USD if BILLING_MONTHLY_BUDGET_USD > 0 else None
    remaining_usd = max(budget_usd - spent_usd, 0.0) if budget_usd is not None else None
    snapshot = LLMIntegrationBillingSnapshot(
        integration_id=integration.id,
        spent_usd=f"{spent_usd:.6f}",
        budget_usd=(f"{budget_usd:.6f}" if budget_usd is not None else None),
        estimated_remaining_usd=(f"{remaining_usd:.6f}" if remaining_usd is not None else None),
        period_start=period_start,
        period_end=period_end,
        fetched_at=now_utc,
        created_by_id=actor_user_id,
    )
    db.add(snapshot)

def _dataset_context(dataset: Dataset) -> dict[str, Any]:
    view = dataset.view
    columns: list[dict[str, Any]] = []
    for column in view.columns:
        columns.append(
            {
                "name": column.column_name,
                "raw_type": column.column_type,
                "normalized_type": normalize_column_type(column.column_type),
                "is_aggregatable": column.is_aggregatable,
                "is_filterable": column.is_filterable,
                "is_groupable": column.is_groupable,
            }
        )
    return {
        "dataset_id": dataset.id,
        "dataset_name": dataset.name,
        "workspace_id": dataset.datasource_id,
        "datasource_id": dataset.datasource_id,
        "view_name": f"{view.schema_name}.{view.view_name}",
        "timezone": DEFAULT_TIMEZONE,
        "rls": [],
        "patterns": {
            "count_star_supported": True,
            "max_limit": MAX_PLAN_LIMIT,
            "allowed_filter_ops": ["eq", "neq", "in", "not_in", "contains", "is_null", "not_null", "gte", "lte", "between"],
        },
        "columns": columns,
    }


def _planner_messages(question: str, context: dict[str, Any]) -> list[dict[str, str]]:
    return _planner_messages_with_history(question=question, context=context, history=[])


def _planner_messages_with_history(
    *,
    question: str,
    context: dict[str, Any],
    history: list[dict[str, Any]],
) -> list[dict[str, str]]:
    compact_history = [item for item in history if isinstance(item, dict) and str(item.get("content", "")).strip()][-8:]
    return [
        {
            "role": "system",
            "content": (
                "Voce e um planner de consultas para analytics. "
                "Nao gere SQL. Nao invente colunas. "
                "Considere o historico recente da conversa quando a pergunta atual for curta/ambigua. "
                "Quando houver follow-up curto (ex: apenas um nome de coluna), trate como continuacao da intencao anterior. "
                "Se o assistente tiver pedido metrica e o usuario responder com uma coluna valida, use action=query. "
                "Priorize planos executaveis no backend: "
                "1) KPI: 1 metrica e sem dimensao; "
                "2) Ranking: 1 metrica + 1 dimensao + ordenacao desc + limit; "
                "3) Serie temporal: 1 metrica + period.field temporal. "
                "Para perguntas de ultimo/mais recente/ultima sobre entidade (cliente/usuario), "
                "use agregacao max em coluna temporal e traga a entidade como dimensao, com limit=1. "
                "Responda APENAS JSON com formato: "
                '{"action":"query|clarification","clarification_question":"","interpreted_question":"","query_plan":{"metrics":[{"field":"","agg":"count|sum|avg|min|max|distinct_count"}],"dimensions":[],"filters":[{"field":"","op":"eq|neq|in|not_in|contains|is_null|not_null|gte|lte|between","value":[]}],"period":{"field":"","start":"","end":"","granularity":"day|week|month","preset":""},"sort":[{"field":"","dir":"asc|desc"}],"limit":100,"assumptions":[]}}'
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": question,
                    "conversation_history": compact_history,
                    "dataset_context": context,
                    "rules": [
                        "Use somente colunas existentes no contexto.",
                        "Se a pergunta for ambigua, use action=clarification.",
                        "Se conversation_history trouxer contexto suficiente, prefira action=query.",
                        "Para follow-up curto com nome de coluna, reutilize a intencao da pergunta anterior.",
                        "Para 'ultimo/mais recente/ultima', prefira metrica max em coluna temporal.",
                        "Se a pergunta pede 'quem/qual cliente', inclua uma dimensao de entidade (ex: email/nome/id_cliente).",
                        "Para ranking/top N, inclua sort desc pela metrica e limit=N.",
                        "Evite planos com multiplas metricas ou multiplas dimensoes quando uma unica metrica responde a pergunta.",
                        f"limit deve ser entre 1 e {MAX_PLAN_LIMIT}.",
                    ],
                },
                ensure_ascii=True,
            ),
        },
    ]


def _clarification_messages(question: str, validation_errors: list[str]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "Gere uma unica pergunta curta de clarificacao em portugues para corrigir o plano invalido.",
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": question,
                    "validation_errors": validation_errors,
                },
                ensure_ascii=True,
            ),
        },
    ]


def _answer_messages(question: str, interpreted: str, result_payload: QueryPreviewResponse) -> list[dict[str, str]]:
    safe_rows = result_payload.rows[:25]
    return [
        {
            "role": "system",
            "content": (
                "Voce resume resultados de analytics para negocio. "
                "Responda em portugues, objetivo, ate 5 frases, sem inventar dados. "
                "Use exclusivamente os dados recebidos."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": question,
                    "interpreted_question": interpreted,
                    "result": {
                        "columns": result_payload.columns,
                        "rows": safe_rows,
                        "row_count": result_payload.row_count,
                    },
                },
                ensure_ascii=True,
                default=str,
            ),
        },
    ]


def _semantic_metric_name(metric_field: str, metric_agg: str) -> str:
    safe_field = (metric_field or "valor").replace(" ", "_")
    return f"{safe_field}_{metric_agg}"


def _result_semantic_context(plan: InsightQueryPlan, result_payload: QueryPreviewResponse) -> dict[str, Any]:
    metric_alias_map: dict[str, str] = {}
    alias_semantic_name_map: dict[str, str] = {}
    metric_columns_detected: list[str] = []
    semantic_rows: list[dict[str, Any]] = []
    semantic_columns: list[str] = []

    metric_idx = 0
    for column in result_payload.columns:
        if column.startswith("m") and column[1:].isdigit():
            if metric_idx < len(plan.metrics):
                metric = plan.metrics[metric_idx]
                semantic_name = _semantic_metric_name(metric.field, metric.agg)
                metric_alias_map[column] = f"{metric.agg}({metric.field})"
                alias_semantic_name_map[column] = semantic_name
                metric_columns_detected.append(column)
                metric_idx += 1

    for row in result_payload.rows[:25]:
        enriched = {}
        for key, value in row.items():
            if key in alias_semantic_name_map:
                continue
            enriched[key] = value
        for alias, semantic_name in alias_semantic_name_map.items():
            enriched[semantic_name] = row.get(alias)
        semantic_rows.append(enriched)

    for column in result_payload.columns:
        semantic_columns.append(alias_semantic_name_map.get(column, column))

    return {
        "metric_alias_map": metric_alias_map,
        "alias_semantic_name_map": alias_semantic_name_map,
        "metric_columns_detected": metric_columns_detected,
        "semantic_rows": semantic_rows,
        "semantic_columns": semantic_columns,
        "dimension_fields": plan.dimensions,
        "metric_definitions": [
            {
                "name": _semantic_metric_name(metric.field, metric.agg),
                "expression": f"{metric.agg}({metric.field})",
            }
            for metric in plan.metrics
        ],
    }


def _semantic_context_for_prompt(semantic_context: dict[str, Any]) -> dict[str, Any]:
    return {
        "metric_definitions": semantic_context.get("metric_definitions", []),
        "dimension_fields": semantic_context.get("dimension_fields", []),
        "semantic_columns": semantic_context.get("semantic_columns", []),
        "semantic_rows": semantic_context.get("semantic_rows", []),
    }


def _answer_messages_with_semantics(
    *,
    question: str,
    interpreted: str,
    result_payload: QueryPreviewResponse,
    semantic_context: dict[str, Any],
    plan: InsightQueryPlan,
) -> list[dict[str, str]]:
    prompt_semantic_context = _semantic_context_for_prompt(semantic_context)
    return [
        {
            "role": "system",
            "content": (
                "Voce responde perguntas analiticas usando somente os dados fornecidos. "
                "Sempre prefira os nomes semanticos das metricas. "
                "Se houver linhas e metricas numericas nao nulas, apresente os numeros e ranking. "
                "Nao afirmar falta de dados quando os dados estiverem presentes."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "question": question,
                    "interpreted_question": interpreted,
                    "plan": {
                        "metrics": [item.model_dump() for item in plan.metrics],
                        "dimensions": plan.dimensions,
                        "limit": plan.limit,
                    },
                    "result": {
                        "columns": semantic_context.get("semantic_columns", result_payload.columns),
                        "rows": semantic_context.get("semantic_rows", result_payload.rows[:25]),
                        "row_count": result_payload.row_count,
                    },
                    "semantic_context": prompt_semantic_context,
                    "rules": [
                        "Use valores das metricas para justificar a resposta.",
                        "Se for top N, cite os N itens e seus valores.",
                        "Evite frases de ausencia de dados quando metricas existirem.",
                    ],
                },
                ensure_ascii=True,
                default=str,
            ),
        },
    ]


def _answer_indicates_missing_data(answer: str) -> bool:
    normalized = answer.lower()
    markers = [
        "nao ha dados",
        "não há dados",
        "falta de dados",
        "sem dados",
        "nao e possivel determinar",
        "não é possível determinar",
    ]
    return any(marker in normalized for marker in markers)


def _has_metric_data(result_payload: QueryPreviewResponse, metric_columns: list[str]) -> bool:
    if not result_payload.rows:
        return False
    for row in result_payload.rows:
        for col in metric_columns:
            value = row.get(col)
            if isinstance(value, (int, float)) and value is not None:
                return True
    return False


def _answer_correction_messages(answer: str, semantic_context: dict[str, Any]) -> list[dict[str, str]]:
    prompt_semantic_context = _semantic_context_for_prompt(semantic_context)
    return [
        {
            "role": "system",
            "content": "Corrija a resposta anterior usando os dados disponiveis e cite os valores numericos.",
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "previous_answer": answer,
                    "semantic_context": prompt_semantic_context,
                    "instruction": "A resposta anterior afirmou falta de dados, mas ha metricas preenchidas.",
                },
                ensure_ascii=True,
                default=str,
            ),
        },
    ]


def _normalize_plan_raw_for_schema(raw_plan: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = dict(raw_plan)

    raw_metrics = normalized.get("metrics")
    if not isinstance(raw_metrics, list):
        raw_metrics = []
    metrics: list[dict[str, Any]] = []
    for item in raw_metrics:
        if isinstance(item, dict):
            field = item.get("field") or item.get("column") or ""
            agg = item.get("agg") or item.get("op") or "count"
            metrics.append({"field": str(field), "agg": str(agg)})
    normalized["metrics"] = metrics

    raw_dimensions = normalized.get("dimensions")
    if not isinstance(raw_dimensions, list):
        raw_dimensions = []
    dimensions: list[str] = []
    for item in raw_dimensions:
        if isinstance(item, str):
            text = item.strip()
            if text:
                dimensions.append(text)
            continue
        if isinstance(item, dict):
            field = str(item.get("field") or item.get("column") or "").strip()
            if field:
                dimensions.append(field)
    normalized["dimensions"] = dimensions

    raw_filters = normalized.get("filters")
    if not isinstance(raw_filters, list):
        raw_filters = []
    filters: list[dict[str, Any]] = []
    for item in raw_filters:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field") or item.get("column") or "").strip()
        op = str(item.get("op") or "eq").strip()
        value = item.get("value")
        if op in {"is_null", "not_null"}:
            value = None
        elif value is not None and not isinstance(value, list):
            value = [value]
        filters.append({"field": field, "op": op, "value": value})
    normalized["filters"] = filters

    raw_sort = normalized.get("sort")
    if not isinstance(raw_sort, list):
        raw_sort = []
    sort: list[dict[str, Any]] = []
    for item in raw_sort:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field") or "").strip()
        direction = str(item.get("dir") or "desc").strip().lower()
        if direction not in {"asc", "desc"}:
            direction = "desc"
        if field:
            sort.append({"field": field, "dir": direction})
    normalized["sort"] = sort

    raw_period = normalized.get("period")
    if isinstance(raw_period, dict):
        period_field = str(raw_period.get("field") or "").strip() or None
        start = str(raw_period.get("start") or "").strip() or None
        end = str(raw_period.get("end") or "").strip() or None
        preset = str(raw_period.get("preset") or "").strip() or None
        granularity = str(raw_period.get("granularity") or "").strip().lower() or None
        if granularity not in {"day", "week", "month"}:
            granularity = None
        if period_field or start or end or preset or granularity:
            normalized["period"] = {
                "field": period_field,
                "start": start,
                "end": end,
                "granularity": granularity,
                "preset": preset,
            }
        else:
            normalized["period"] = None
    else:
        normalized["period"] = None

    raw_assumptions = normalized.get("assumptions")
    if not isinstance(raw_assumptions, list):
        raw_assumptions = []
    normalized["assumptions"] = [str(item).strip() for item in raw_assumptions if str(item).strip()]

    try:
        normalized["limit"] = int(normalized.get("limit", 100))
    except Exception:
        normalized["limit"] = 100

    return normalized


def _resolve_llm_models(integration: LLMIntegration) -> tuple[str, str]:
    planner_model = str(getattr(settings, "insights_planner_model", "") or integration.model)
    answer_model = str(getattr(settings, "insights_answer_model", "") or integration.model)
    return planner_model, answer_model


async def _run_planner_llm(
    *,
    api_key: str,
    model: str,
    question: str,
    dataset_context: dict[str, Any],
    history: list[dict[str, Any]],
    previous_response_id: str | None = None,
) -> PlannerResult:
    _log_dev_step(
        "planner_request_start",
        model=model,
        question_len=len(question),
        dataset_id=dataset_context.get("dataset_id"),
        view_name=dataset_context.get("view_name"),
        column_count=len(dataset_context.get("columns", [])),
    )
    planner_request: dict[str, Any] = {
        "api_key": api_key,
        "model": model,
        "messages": _planner_messages_with_history(question=question, context=dataset_context, history=history),
        "response_format": {"type": "json_object"},
    }
    if previous_response_id:
        planner_request["previous_response_id"] = previous_response_id
    raw_planner = await _openai_chat_completion(**planner_request)
    planner_response = json.loads(raw_planner["content"])
    result = PlannerResult(
        action=str(planner_response.get("action", "")).strip().lower(),
        interpreted_question=str(planner_response.get("interpreted_question", question)).strip() or question,
        clarification_question=str(planner_response.get("clarification_question", "")).strip(),
        query_plan_raw=planner_response.get("query_plan") if isinstance(planner_response.get("query_plan"), dict) else None,
        response_id=raw_planner.get("response_id"),
        input_tokens=int(raw_planner.get("input_tokens") or 0),
        output_tokens=int(raw_planner.get("output_tokens") or 0),
        total_tokens=int(raw_planner.get("total_tokens") or 0),
    )
    _log_dev_step(
        "planner_request_done",
        model=model,
        action=result.action,
        interpreted_question=result.interpreted_question,
        has_query_plan=result.query_plan_raw is not None,
        has_clarification=bool(result.clarification_question),
    )
    return result


async def _run_answer_llm(
    *,
    api_key: str,
    model: str,
    question: str,
    interpreted_question: str,
    result_payload: QueryPreviewResponse,
    plan: InsightQueryPlan,
    previous_response_id: str | None = None,
) -> AnswerResult:
    semantic_context = _result_semantic_context(plan, result_payload)
    _log_dev_step(
        "answer_request_start",
        model=model,
        question_len=len(question),
        interpreted_question=interpreted_question,
        row_count=result_payload.row_count,
        column_count=len(result_payload.columns),
        metric_alias_map=semantic_context.get("metric_alias_map"),
    )
    answer_request: dict[str, Any] = {
        "api_key": api_key,
        "model": model,
        "messages": _answer_messages_with_semantics(
            question=question,
            interpreted=interpreted_question,
            result_payload=result_payload,
            semantic_context=semantic_context,
            plan=plan,
        ),
    }
    if previous_response_id:
        answer_request["previous_response_id"] = previous_response_id
    answer_completion = await _openai_chat_completion(**answer_request)
    answer = _sanitize_answer(answer_completion["content"])
    answer_response_id = answer_completion.get("response_id")
    input_tokens = int(answer_completion.get("input_tokens") or 0)
    output_tokens = int(answer_completion.get("output_tokens") or 0)
    total_tokens = int(answer_completion.get("total_tokens") or 0)
    if _answer_indicates_missing_data(answer) and _has_metric_data(
        result_payload,
        semantic_context.get("metric_columns_detected", []),
    ):
        _log_dev_step("answer_request_retry_due_to_false_missing_data", previous_answer=answer)
        correction_request: dict[str, Any] = {
            "api_key": api_key,
            "model": model,
            "messages": _answer_correction_messages(answer, semantic_context),
        }
        if answer_response_id:
            correction_request["previous_response_id"] = answer_response_id
        corrected = await _openai_chat_completion(**correction_request)
        answer = _sanitize_answer(corrected["content"])
        answer_response_id = corrected.get("response_id")
        input_tokens += int(corrected.get("input_tokens") or 0)
        output_tokens += int(corrected.get("output_tokens") or 0)
        total_tokens += int(corrected.get("total_tokens") or 0)
    _log_dev_step("answer_request_done", model=model, answer_len=len(answer))
    return AnswerResult(
        answer=answer,
        response_id=answer_response_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
    )


def _plan_cost(plan: InsightQueryPlan) -> int:
    return (
        (plan.limit * 3)
        + (len(plan.metrics) * 400)
        + (len(plan.dimensions) * 500)
        + (len(plan.filters) * 250)
        + (800 if plan.period else 0)
    )


def _validate_and_normalize_plan(plan: InsightQueryPlan, context: dict[str, Any]) -> tuple[InsightQueryPlan, list[str], int]:
    columns_by_name = {item["name"]: item for item in context["columns"]}
    errors: list[str] = []

    plan.limit = min(max(1, int(plan.limit or 100)), MAX_PLAN_LIMIT)
    if not plan.metrics:
        errors.append("Defina ao menos uma metrica para responder a pergunta.")

    for metric in plan.metrics:
        if metric.agg == "count" and metric.field == "*":
            continue
        column = columns_by_name.get(metric.field)
        if not column:
            errors.append(f"Metrica usa coluna inexistente: {metric.field}.")
            continue
        if metric.agg != "count":
            # Datas temporais normalmente nao sao marcadas como "aggregatable" no catalogo,
            # mas MIN/MAX sobre temporal e um caso valido para perguntas de "ultimo/primeiro".
            if not column["is_aggregatable"]:
                normalized_type = str(column.get("normalized_type") or "")
                temporal_min_max = metric.agg in {"min", "max"} and normalized_type == "temporal"
                if not temporal_min_max:
                    errors.append(f"Coluna {metric.field} nao pode ser agregada com {metric.agg}.")
    for dimension in plan.dimensions:
        column = columns_by_name.get(dimension)
        if not column:
            errors.append(f"Dimensao inexistente: {dimension}.")
            continue
        if not column["is_groupable"]:
            errors.append(f"Coluna {dimension} nao pode ser usada como dimensao.")

    for filter_spec in plan.filters:
        column = columns_by_name.get(filter_spec.field)
        if not column:
            errors.append(f"Filtro usa coluna inexistente: {filter_spec.field}.")
            continue
        if not column["is_filterable"]:
            errors.append(f"Coluna {filter_spec.field} nao permite filtro.")

    if plan.period and plan.period.field:
        period_column = columns_by_name.get(plan.period.field)
        if not period_column:
            errors.append(f"Periodo usa coluna inexistente: {plan.period.field}.")
        elif period_column["normalized_type"] != "temporal":
            errors.append(f"Periodo exige coluna temporal, mas {plan.period.field} nao e temporal.")

    for sort in plan.sort:
        if sort.field not in plan.dimensions and sort.field not in [metric.field for metric in plan.metrics]:
            errors.append(f"Ordenacao usa campo fora de metricas/dimensoes: {sort.field}.")

    cost = _plan_cost(plan)
    if cost > PLAN_COST_LIMIT:
        errors.append(f"Custo estimado do plano ({cost}) excede limite permitido ({PLAN_COST_LIMIT}).")

    return plan, errors, cost


def _period_filters(period: InsightPlanPeriod | None) -> list[FilterConfig]:
    if not period or not period.field:
        return []
    filters: list[FilterConfig] = []
    if period.start:
        filters.append(FilterConfig(column=period.field, op="gte", value=period.start))
    if period.end:
        filters.append(FilterConfig(column=period.field, op="lte", value=period.end))
    return filters


def _to_widget_filter(filter_item: Any) -> FilterConfig:
    value: Any = filter_item.value
    if filter_item.op in {"eq", "neq", "contains", "gte", "lte"} and isinstance(value, list):
        value = value[0] if value else None
    return FilterConfig(column=filter_item.field, op=filter_item.op, value=value)


def _to_filter_spec_payload(filter_item: FilterConfig) -> dict[str, Any]:
    value = filter_item.value
    if value is None:
        normalized_value = None
    elif isinstance(value, list):
        normalized_value = value
    else:
        normalized_value = [value]
    return {"field": filter_item.column, "op": filter_item.op, "value": normalized_value}


def _to_query_spec(plan: InsightQueryPlan, dataset_id: int) -> QuerySpec:
    filters: list[dict[str, Any]] = [item.model_dump() for item in plan.filters]
    if plan.period and plan.period.field:
        if plan.period.start:
            filters.append({"field": plan.period.field, "op": "gte", "value": [plan.period.start]})
        if plan.period.end:
            filters.append({"field": plan.period.field, "op": "lte", "value": [plan.period.end]})

    return QuerySpec(
        datasetId=dataset_id,
        metrics=plan.metrics,
        dimensions=plan.dimensions,
        filters=filters,
        sort=plan.sort,
        limit=plan.limit,
        offset=0,
    )


def _pick_primary_dimension(dimensions: list[str]) -> str | None:
    if not dimensions:
        return None
    ranked_tokens = ["email", "id", "cliente", "client", "nome", "name"]
    lowered = [item.lower() for item in dimensions]
    for token in ranked_tokens:
        for idx, value in enumerate(lowered):
            if token in value:
                return dimensions[idx]
    return dimensions[0]


def _compile_widget_config(plan: InsightQueryPlan, view_name: str) -> WidgetConfig | None:
    widget_filters = [_to_widget_filter(item) for item in plan.filters] + _period_filters(plan.period)
    metric = plan.metrics[0] if plan.metrics else None
    primary_dimension = _pick_primary_dimension(plan.dimensions)

    if metric and not plan.dimensions and len(plan.metrics) == 1 and not plan.period:
        metric_column = None if (metric.agg == "count" and metric.field == "*") else metric.field
        return WidgetConfig(
            widget_type="kpi",
            view_name=view_name,
            metrics=[MetricConfig(op=metric.agg, column=metric_column)],
            dimensions=[],
            filters=widget_filters,
            order_by=[],
            limit=1,
        )

    if metric and len(plan.metrics) == 1 and primary_dimension and not plan.period:
        metric_column = None if (metric.agg == "count" and metric.field == "*") else metric.field
        return WidgetConfig(
            widget_type="bar",
            view_name=view_name,
            metrics=[MetricConfig(op=metric.agg, column=metric_column)],
            dimensions=[primary_dimension],
            filters=widget_filters,
            order_by=[OrderByConfig(metric_ref="m0", direction="desc")],
            top_n=min(plan.limit, MAX_RESULT_ROWS),
        )

    if metric and len(plan.metrics) == 1 and not plan.dimensions and plan.period and plan.period.field:
        metric_column = None if (metric.agg == "count" and metric.field == "*") else metric.field
        return WidgetConfig(
            widget_type="line",
            view_name=view_name,
            metrics=[MetricConfig(op=metric.agg, column=metric_column)],
            dimensions=[],
            time=TimeConfig(column=plan.period.field, granularity=plan.period.granularity or "day"),
            filters=widget_filters,
            order_by=[],
            limit=min(plan.limit, MAX_RESULT_ROWS),
        )

    return None


async def _run_query(dataset: Dataset, sql: str, params: list[Any]) -> QueryExecutionResult:
    start = perf_counter()
    conn: AsyncConnection[Any] | None = None
    try:
        datasource = dataset.datasource
        if datasource and datasource.database_url:
            try:
                decrypted_url = credential_encryptor.decrypt(datasource.database_url)
            except InvalidToken as exc:
                raise HTTPException(
                    status_code=400,
                    detail="Datasource credentials are invalid for current encryption key. Recreate datasource.",
                ) from exc
            conn = await AsyncConnection.connect(decrypted_url)
            _log_dev_step("query_connection_resolved", source="datasource", datasource_id=datasource.id)
        else:
            conn = await get_analytics_connection()
            _log_dev_step("query_connection_resolved", source="analytics_fallback", datasource_id=dataset.datasource_id)

        log_external_query(
            sql=sql,
            params=params,
            context=f"insights:dataset:{dataset.id}",
            datasource_id=dataset.datasource_id,
        )
        result = await conn.execute(sql, params)
        rows = await result.fetchall()
        columns = [desc[0] for desc in result.description]
        row_dicts: list[dict[str, Any]] = []
        for row in rows[:MAX_RESULT_ROWS]:
            row_dict = {}
            for i, col in enumerate(columns):
                row_dict[col] = row[i]
            row_dicts.append(row_dict)
        elapsed = int((perf_counter() - start) * 1000)
        return QueryExecutionResult(
            payload=QueryPreviewResponse(columns=columns, rows=row_dicts, row_count=len(row_dicts)),
            sql=sql,
            params=params,
            execution_time_ms=elapsed,
            cache_hit=False,
            deduped=False,
        )
    finally:
        if conn:
            await conn.close()


async def _execute_query_with_optimizations(dataset: Dataset, sql: str, params: list[Any]) -> QueryExecutionResult:
    key = _query_cache_key(dataset.id, sql, params)
    cached = await _query_cache_get(key)
    if cached:
        _log_dev_step("query_cache_hit", dataset_id=dataset.id, sql_preview=sql[:180], params_count=len(params))
        return QueryExecutionResult(
            payload=cached.payload,
            sql=cached.sql,
            params=cached.params,
            execution_time_ms=cached.execution_time_ms,
            cache_hit=True,
            deduped=False,
        )

    async with _inflight_lock:
        existing = _inflight_queries.get(key)
        if existing:
            deduped = True
            future = existing
            _log_dev_step("query_singleflight_join", dataset_id=dataset.id, sql_preview=sql[:180], params_count=len(params))
        else:
            deduped = False
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            _inflight_queries[key] = future
            _log_dev_step("query_singleflight_new", dataset_id=dataset.id, sql_preview=sql[:180], params_count=len(params))

    if deduped:
        result = await future
        return QueryExecutionResult(
            payload=result.payload,
            sql=result.sql,
            params=result.params,
            execution_time_ms=result.execution_time_ms,
            cache_hit=result.cache_hit,
            deduped=True,
        )

    try:
        _log_dev_step("query_execute_start", dataset_id=dataset.id, timeout_seconds=QUERY_TIMEOUT_SECONDS)
        executed = await asyncio.wait_for(_run_query(dataset, sql, params), timeout=QUERY_TIMEOUT_SECONDS)
        await _query_cache_set(key, executed)
        future.set_result(executed)
        _log_dev_step(
            "query_execute_done",
            dataset_id=dataset.id,
            row_count=executed.payload.row_count,
            execution_time_ms=executed.execution_time_ms,
        )
        return executed
    except asyncio.TimeoutError as exc:
        error = HTTPException(status_code=504, detail="Insight query timed out")
        future.set_exception(error)
        _log_dev_step("query_execute_timeout", dataset_id=dataset.id, timeout_seconds=QUERY_TIMEOUT_SECONDS)
        raise error from exc
    except Exception as exc:
        future.set_exception(exc)
        _log_dev_step("query_execute_error", dataset_id=dataset.id, error=repr(exc))
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"Insight query execution failed: {repr(exc)}") from exc
    finally:
        async with _inflight_lock:
            _inflight_queries.pop(key, None)


def _sanitize_answer(value: str) -> str:
    return " ".join(value.replace("\r", " ").split())


@router.get("/integration", response_model=LLMIntegrationResponse)
async def get_integration_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    integration = _get_openai_integration(db)
    if not integration:
        return LLMIntegrationResponse(provider="openai", configured=False)

    try:
        api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
    except Exception:
        return LLMIntegrationResponse(provider="openai", configured=False)
    return LLMIntegrationResponse(
        provider="openai",
        configured=True,
        model=integration.model,
        masked_api_key=_mask_api_key(api_key),
        updated_at=integration.updated_at,
        updated_by_id=integration.updated_by_id,
    )


@router.get("/integrations", response_model=LLMIntegrationListResponse)
async def list_integrations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    integrations = _list_openai_integrations(db)
    return LLMIntegrationListResponse(items=[_integration_to_item_response(item) for item in integrations])


@router.post("/integrations/billing/refresh", response_model=LLMIntegrationBillingRefreshResponse)
async def refresh_integrations_billing(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    integrations = _list_openai_integrations(db)
    now_utc = datetime.now(timezone.utc)
    refreshed = 0
    failed = 0
    for integration in integrations:
        try:
            await _refresh_integration_billing_snapshot(
                db=db,
                integration=integration,
                actor_user_id=current_user.id,
                now_utc=now_utc,
            )
            refreshed += 1
        except Exception:
            failed += 1
    db.commit()
    return LLMIntegrationBillingRefreshResponse(refreshed=refreshed, failed=failed)


@router.post("/integrations/openai", response_model=LLMIntegrationItemResponse)
async def create_openai_integration(
    request: LLMIntegrationCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    encrypted_key = credential_encryptor.encrypt(request.api_key.strip())
    integration = LLMIntegration(
        provider="openai",
        encrypted_api_key=encrypted_key,
        model=request.model,
        is_active=False,
        created_by_id=current_user.id,
        updated_by_id=current_user.id,
    )
    db.add(integration)
    db.flush()
    if request.is_active:
        _activate_integration(db, integration, current_user.id)
    db.commit()
    db.refresh(integration)
    return _integration_to_item_response(integration)


@router.patch("/integrations/{integration_id}/activate", response_model=LLMIntegrationItemResponse)
async def activate_integration(
    integration_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    integration = db.query(LLMIntegration).filter(LLMIntegration.id == integration_id, LLMIntegration.provider == "openai").first()
    if not integration:
        raise HTTPException(status_code=404, detail="Integracao nao encontrada")
    _activate_integration(db, integration, current_user.id)
    db.commit()
    db.refresh(integration)
    return _integration_to_item_response(integration)


@router.patch("/integrations/{integration_id}/deactivate", response_model=LLMIntegrationItemResponse)
async def deactivate_integration(
    integration_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    integration = db.query(LLMIntegration).filter(LLMIntegration.id == integration_id, LLMIntegration.provider == "openai").first()
    if not integration:
        raise HTTPException(status_code=404, detail="Integracao nao encontrada")
    integration.is_active = False
    integration.updated_by_id = current_user.id
    db.commit()
    db.refresh(integration)
    return _integration_to_item_response(integration)


@router.put("/integration/openai", response_model=LLMIntegrationResponse)
async def upsert_openai_integration(
    request: OpenAIIntegrationUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    created = await create_openai_integration(
        LLMIntegrationCreateRequest(api_key=request.api_key, model=request.model, is_active=True),
        db=db,
        current_user=current_user,
    )
    return LLMIntegrationResponse(
        provider="openai",
        configured=True,
        model=created.model,
        masked_api_key=_mask_api_key(request.api_key.strip()),
        updated_at=created.updated_at,
        updated_by_id=created.updated_by_id,
    )

@router.post("/integration/openai/test", response_model=OpenAIIntegrationTestResponse)
async def test_openai_integration(
    request: OpenAIIntegrationTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    api_key = request.api_key.strip() if request.api_key else None
    if not api_key:
        integration = _get_openai_integration(db)
        if not integration:
            raise HTTPException(status_code=400, detail="Nenhuma chave OpenAI configurada")
        try:
            api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Chave OpenAI configurada esta invalida") from exc

    await _openai_chat_completion(
        api_key=api_key,
        model=request.model,
        messages=[
            {"role": "system", "content": "Responda apenas: ok"},
            {"role": "user", "content": "ping"},
        ],
    )
    return OpenAIIntegrationTestResponse(
        ok=True,
        message="Conexao com OpenAI validada",
        model=request.model,
    )


@router.post("/integrations/{integration_id}/test", response_model=OpenAIIntegrationTestResponse)
async def test_stored_integration(
    integration_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    _ = current_user
    integration = db.query(LLMIntegration).filter(LLMIntegration.id == integration_id, LLMIntegration.provider == "openai").first()
    if not integration:
        raise HTTPException(status_code=404, detail="Integracao nao encontrada")
    try:
        api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Chave OpenAI configurada esta invalida") from exc

    await _openai_chat_completion(
        api_key=api_key,
        model=integration.model,
        messages=[
            {"role": "system", "content": "Responda apenas: ok"},
            {"role": "user", "content": "ping"},
        ],
    )
    billing_updated = False
    try:
        now_utc = datetime.now(timezone.utc)
        await _refresh_integration_billing_snapshot(
            db=db,
            integration=integration,
            actor_user_id=current_user.id,
            now_utc=now_utc,
        )
        db.commit()
        billing_updated = True
    except Exception as exc:
        db.rollback()
        _log_dev_step(
            "integration_test_billing_refresh_failed",
            integration_id=integration.id,
            error=repr(exc),
        )
    return OpenAIIntegrationTestResponse(
        ok=True,
        message="Conexao com OpenAI validada e saldo atualizado" if billing_updated else "Conexao com OpenAI validada (saldo nao atualizado)",
        model=integration.model,
    )


@router.post(
    "/chat",
    response_model=Union[InsightAnswerResponse, InsightClarificationResponse, InsightErrorResponse],
)
async def chat_with_data(
    request: InsightChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stages: list[str] = ["analyzing"]
    history_payload = request.history if isinstance(request.history, list) else []
    planner_context_id = (request.planner_previous_response_id or "").strip() or None
    answer_context_id = (request.answer_previous_response_id or "").strip() or None

    def llm_context_payload() -> InsightLLMContext:
        return InsightLLMContext(
            planner_response_id=planner_context_id,
            answer_response_id=answer_context_id,
        )

    _log_dev_step("chat_start", dataset_id=request.dataset_id, raw_question=request.question, raw_question_len=len(request.question or ""))
    normalized_question = " ".join((request.question or "").strip().split())
    _log_dev_step("chat_question_normalized", dataset_id=request.dataset_id, normalized_question=normalized_question, normalized_len=len(normalized_question))
    if len(normalized_question) < 2:
        _log_dev_step("chat_invalid_question", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="invalid_question",
            message="Pergunta muito curta. Digite pelo menos 2 caracteres.",
            suggestions=["Exemplo: 'qual o total de vendas?'", "Adicione metrica, periodo ou dimensao na pergunta."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    allow_chat_cache = not history_payload and not planner_context_id and not answer_context_id
    if allow_chat_cache:
        cached = await _chat_cache_get(request.dataset_id, normalized_question)
        if cached:
            _log_dev_step("chat_cache_hit", dataset_id=request.dataset_id)
            return cached

    integration = _get_openai_integration(db)
    if not integration:
        _log_dev_step("chat_llm_not_configured", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="llm_not_configured",
            message="LLM nao configurada. Peca para um admin cadastrar a chave OpenAI.",
            suggestions=["Acesse APIs e configure a integracao OpenAI."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    try:
        decrypted_api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
        _log_dev_step("chat_llm_config_loaded", provider=integration.provider, integration_model=integration.model)
    except Exception:
        _log_dev_step("chat_llm_config_invalid", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="llm_not_configured",
            message="A chave OpenAI configurada esta invalida. Peca para um admin atualizar.",
            suggestions=["Atualize a chave OpenAI em APIs."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    planner_model, answer_model = _resolve_llm_models(integration)
    _log_dev_step("chat_models_resolved", planner_model=planner_model, answer_model=answer_model)
    dataset = db.query(Dataset).filter(Dataset.id == request.dataset_id, Dataset.is_active == True).first()
    if not dataset or not dataset.view or not dataset.view.is_active:
        _log_dev_step("chat_dataset_unavailable", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="dataset_unavailable",
            message="Dataset indisponivel ou inativo.",
            suggestions=["Selecione outro dataset ativo."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    dataset_context = _dataset_context(dataset)
    available_columns = [item["name"] for item in dataset_context["columns"]]
    _log_dev_step(
        "chat_dataset_context_loaded",
        dataset_id=request.dataset_id,
        view_name=dataset_context.get("view_name"),
        column_count=len(available_columns),
    )

    try:
        planner_result = await _run_planner_llm(
            api_key=decrypted_api_key,
            model=planner_model,
            question=normalized_question,
            dataset_context=dataset_context,
            history=history_payload,
            previous_response_id=planner_context_id,
        )
        planner_context_id = planner_result.response_id or planner_context_id
    except HTTPException:
        _log_dev_step("chat_planner_failure_http", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="llm_failure",
            message="Falha ao interpretar a pergunta com a LLM.",
            suggestions=["Tente novamente em alguns instantes.", "Revise a configuracao da OpenAI."],
            stages=stages,
            llm_context=llm_context_payload(),
        )
    except Exception:
        logger.exception("insights_dev | step=chat_planner_failure_exception")
        return InsightErrorResponse(
            error_code="llm_failure",
            message="Nao foi possivel interpretar a resposta da LLM.",
            suggestions=["Reformule a pergunta com mais contexto."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    action = planner_result.action
    interpreted_question = planner_result.interpreted_question
    _log_dev_step("chat_planner_action", action=action, interpreted_question=interpreted_question)
    if action == "clarification":
        clarification = planner_result.clarification_question
        if not clarification:
            clarification = "Pode especificar melhor a metrica e o recorte desejado?"
        _log_dev_step("chat_planner_clarification", clarification=clarification)
        return InsightClarificationResponse(
            clarification_question=clarification,
            stages=stages,
            llm_context=llm_context_payload(),
        )

    if action != "query":
        _log_dev_step("chat_planner_invalid_action", action=action)
        return InsightErrorResponse(
            error_code="invalid_llm_plan",
            message="A LLM retornou um plano invalido.",
            suggestions=["Tente novamente com uma pergunta mais objetiva."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    if planner_result.query_plan_raw is None:
        _log_dev_step("chat_plan_missing", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="invalid_query_plan",
            message="Nao foi possivel gerar um QueryPlan valido.",
            suggestions=["Especifique metrica, dimensao e periodo na pergunta."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    _push_stage(stages, "building_query")
    normalized_plan_raw = _normalize_plan_raw_for_schema(planner_result.query_plan_raw)
    _log_dev_step("chat_plan_normalized", raw_plan=planner_result.query_plan_raw, normalized_plan=normalized_plan_raw)
    try:
        plan = InsightQueryPlan(**normalized_plan_raw)
        _log_dev_step("chat_plan_parsed", metrics=len(plan.metrics), dimensions=len(plan.dimensions), filters=len(plan.filters), has_period=plan.period is not None)
    except Exception:
        _log_dev_step("chat_plan_parse_error", raw_plan=planner_result.query_plan_raw, normalized_plan=normalized_plan_raw)
        return InsightErrorResponse(
            error_code="invalid_query_plan",
            message="O QueryPlan retornado nao passou na validacao estrutural.",
            suggestions=["Reformule a pergunta com mais detalhes."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    plan, plan_errors, cost_estimate = _validate_and_normalize_plan(plan, dataset_context)
    _log_dev_step("chat_plan_validated", errors_count=len(plan_errors), cost_estimate=cost_estimate, normalized_limit=plan.limit)
    if plan_errors:
        try:
            clarification_request: dict[str, Any] = {
                "api_key": decrypted_api_key,
                "model": planner_model,
                "messages": _clarification_messages(normalized_question, plan_errors),
            }
            if planner_context_id:
                clarification_request["previous_response_id"] = planner_context_id
            clarification = await _openai_chat_completion(**clarification_request)
            clarification_question = clarification["content"].strip()
            planner_context_id = clarification.get("response_id") or planner_context_id
            if clarification_question:
                _log_dev_step("chat_plan_invalid_clarification", clarification=clarification_question, errors=plan_errors[:3])
                return InsightClarificationResponse(
                    clarification_question=clarification_question,
                    stages=stages,
                    llm_context=llm_context_payload(),
                )
        except Exception:
            logger.exception("insights_dev | step=chat_plan_invalid_clarification_exception")
            pass

        _log_dev_step("chat_plan_invalid_error", errors=plan_errors[:3])
        return InsightErrorResponse(
            error_code="invalid_query_plan",
            message="QueryPlan invalido para o dataset selecionado.",
            suggestions=plan_errors[:3] or ["Detalhe a pergunta com metrica, filtro e periodo."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    compiled = _compile_widget_config(plan, dataset_context["view_name"])
    if not compiled:
        _log_dev_step("chat_compile_not_supported_for_shape", metrics=len(plan.metrics), dimensions=len(plan.dimensions), has_period=plan.period is not None)
        return InsightClarificationResponse(
            clarification_question=(
                "Posso executar consultas com 1 metrica por vez (KPI, por dimensao unica ou serie temporal). "
                "Qual recorte voce quer priorizar?"
            ),
            stages=stages,
            llm_context=llm_context_payload(),
        )

    try:
        query_sql, params = build_widget_query(compiled)
        _log_dev_step("chat_compile_done", widget_type=compiled.widget_type, sql_preview=query_sql[:220], params_count=len(params))
    except Exception:
        logger.exception("insights_dev | step=chat_compile_error")
        return InsightErrorResponse(
            error_code="query_compile_failed",
            message="Nao foi possivel compilar o QueryPlan para SQL.",
            suggestions=["Simplifique a pergunta para uma metrica principal e um unico recorte."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    _push_stage(stages, "querying")
    try:
        execution = await _execute_query_with_optimizations(dataset, query_sql, params)
        _log_dev_step(
            "chat_query_done",
            row_count=execution.payload.row_count,
            execution_time_ms=execution.execution_time_ms,
            cache_hit=execution.cache_hit,
            deduped=execution.deduped,
        )
    except HTTPException as exc:
        detail = str(exc.detail)
        _log_dev_step("chat_query_http_error", detail=detail)
        if _is_missing_relation_error(detail):
            return InsightErrorResponse(
                error_code="dataset_unavailable",
                message="A view do dataset nao foi encontrada no banco analytics.",
                suggestions=[
                    "Sincronize novamente a fonte de dados.",
                    "Confirme schema/view configurados para o dataset.",
                ],
                stages=stages,
                llm_context=llm_context_payload(),
            )

        missing_column = _extract_missing_column_from_error(detail)
        if missing_column:
            suggestions = _build_column_suggestions(missing_column, available_columns)
            return InsightErrorResponse(
                error_code="column_not_found",
                message=f"Coluna '{missing_column}' nao existe no schema do dataset.",
                suggestions=suggestions or ["Consulte as colunas do dataset no painel lateral."],
                stages=stages,
                llm_context=llm_context_payload(),
            )
        return InsightErrorResponse(
            error_code="query_execution_failed",
            message=f"Nao foi possivel executar a consulta: {detail}",
            suggestions=["Revise filtros e dimensoes solicitados."],
            stages=stages,
            llm_context=llm_context_payload(),
        )
    except Exception:
        logger.exception("insights_dev | step=chat_query_exception")
        return InsightErrorResponse(
            error_code="query_execution_failed",
            message="Falha ao consultar o banco de dados.",
            suggestions=["Tente novamente em alguns instantes."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    _push_stage(stages, "generating")
    answer_result: AnswerResult | None = None
    try:
        answer_result = await _run_answer_llm(
            api_key=decrypted_api_key,
            model=answer_model,
            question=normalized_question,
            interpreted_question=interpreted_question,
            result_payload=execution.payload,
            plan=plan,
            previous_response_id=answer_context_id,
        )
        answer_context_id = answer_result.response_id or answer_context_id
    except HTTPException:
        _log_dev_step("chat_answer_http_error", dataset_id=request.dataset_id)
        return InsightErrorResponse(
            error_code="llm_failure",
            message="A consulta foi executada, mas a LLM falhou ao gerar a resposta.",
            suggestions=["Tente novamente.", "Confira a saude da integracao OpenAI."],
            stages=stages,
            llm_context=llm_context_payload(),
        )
    except Exception:
        logger.exception("insights_dev | step=chat_answer_exception")
        return InsightErrorResponse(
            error_code="llm_failure",
            message="A consulta foi executada, mas ocorreu erro ao resumir os dados.",
            suggestions=["Tente novamente em alguns instantes."],
            stages=stages,
            llm_context=llm_context_payload(),
        )

    query_spec = _to_query_spec(plan, request.dataset_id)
    applied_filters = [_to_widget_filter(item) for item in plan.filters] + _period_filters(plan.period)
    llm_input_tokens = planner_result.input_tokens + (answer_result.input_tokens if answer_result else 0)
    llm_output_tokens = planner_result.output_tokens + (answer_result.output_tokens if answer_result else 0)
    llm_total_tokens = planner_result.total_tokens + (answer_result.total_tokens if answer_result else 0)
    conversation_cost_estimate_usd = _estimate_llm_cost_usd(
        planner_model,
        input_tokens=planner_result.input_tokens,
        output_tokens=planner_result.output_tokens,
    ) + _estimate_llm_cost_usd(
        answer_model,
        input_tokens=answer_result.input_tokens if answer_result else 0,
        output_tokens=answer_result.output_tokens if answer_result else 0,
    )

    payload = InsightAnswerResponse(
        answer=answer_result.answer if answer_result else "",
        interpreted_question=interpreted_question,
        query_plan=plan,
        query_config=query_spec,
        columns=execution.payload.columns,
        rows=execution.payload.rows[:50],
        row_count=execution.payload.row_count,
        calculation=InsightCalculationResponse(
            sql=query_sql,
            params=params,
            applied_filters=[_to_filter_spec_payload(item) for item in applied_filters],
            cost_estimate=cost_estimate,
            conversation_cost_estimate_usd=round(conversation_cost_estimate_usd, 8),
            llm_input_tokens=llm_input_tokens,
            llm_output_tokens=llm_output_tokens,
            llm_total_tokens=llm_total_tokens,
            execution_time_ms=execution.execution_time_ms,
            cache_hit=execution.cache_hit,
            deduped=execution.deduped,
            timeout_seconds=QUERY_TIMEOUT_SECONDS,
        ),
        cache_hit=False,
        stages=stages,
        llm_context=llm_context_payload(),
    )

    logger.info(
        "insights_audit | dataset_id=%s rows=%s cost=%s cache_hit=%s",
        request.dataset_id,
        execution.payload.row_count,
        cost_estimate,
        execution.cache_hit,
    )
    if allow_chat_cache:
        await _chat_cache_set(payload, normalized_question)
    _log_dev_step("chat_done", dataset_id=request.dataset_id, returned_rows=payload.row_count, answer_len=len(payload.answer))
    return payload
