from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.shared.infrastructure.database import get_db
from app.modules.auth.adapters.api.dependencies import get_current_admin_user, get_current_user
from app.modules.core.legacy.models import LLMIntegration, LLMIntegrationBillingSnapshot, User
from app.modules.core.legacy.schemas import (
    LLMIntegrationBillingRefreshResponse,
    LLMIntegrationCreateRequest,
    LLMIntegrationItemResponse,
    LLMIntegrationListResponse,
    LLMIntegrationResponse,
    OpenAIIntegrationTestRequest,
    OpenAIIntegrationTestResponse,
    OpenAIIntegrationUpsertRequest,
)
from app.shared.infrastructure.settings import get_settings

router = APIRouter(prefix="/api-config", tags=["api-config"])
settings = get_settings()
OPENAI_BASE_URL = "https://api.openai.com/v1"
BILLING_WINDOW_DAYS = max(
    1,
    int(getattr(settings, "api_config_billing_window_days", 30)),
)
BILLING_MONTHLY_BUDGET_USD = float(
    getattr(settings, "api_config_billing_monthly_budget_usd", 0.0)
)


def _mask_api_key(api_key: str) -> str:
    if len(api_key) <= 8:
        return "********"
    return f"{api_key[:4]}...{api_key[-4:]}"


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


async def _openai_chat_completion(api_key: str, model: str, messages: list[dict]) -> None:
    payload: dict[str, Any] = {
        "model": model,
        "input": messages,
        "store": False,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(f"{OPENAI_BASE_URL}/responses", headers=headers, json=payload)

    if response.status_code >= 400:
        try:
            body = response.json()
            detail = body.get("error", {}).get("message") or "OpenAI request failed"
        except Exception:
            detail = "OpenAI request failed"
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=400, detail="OpenAI API key invalida ou sem permissao")
        raise HTTPException(status_code=400, detail=f"Falha ao chamar OpenAI: {detail}")


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


@router.get("/integration", response_model=LLMIntegrationResponse)
async def get_integration_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
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
    _ = current_user
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
    except Exception:
        db.rollback()

    return OpenAIIntegrationTestResponse(
        ok=True,
        message="Conexao com OpenAI validada e saldo atualizado" if billing_updated else "Conexao com OpenAI validada (saldo nao atualizado)",
        model=integration.model,
    )


