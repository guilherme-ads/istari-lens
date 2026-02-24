from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import Dataset, User, View
from app.modules.core.legacy.schemas import (
    QueryPreviewBatchItemResponse,
    QueryPreviewBatchRequest,
    QueryPreviewBatchResponse,
    QueryPreviewResponse,
    QuerySpec,
)
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.engine import get_engine_client, resolve_datasource_access, to_engine_query_spec

router = APIRouter(prefix="/query", tags=["query"])


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _validate_dataset_and_view(spec: QuerySpec, db: Session) -> tuple[Dataset, View]:
    dataset = db.query(Dataset).filter(Dataset.id == spec.datasetId).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if not dataset.is_active:
        raise HTTPException(status_code=400, detail="Dataset is inactive")

    view = dataset.view
    if not view or not view.is_active:
        raise HTTPException(status_code=400, detail="Dataset view is inactive")
    if not dataset.datasource or not dataset.datasource.is_active:
        raise HTTPException(status_code=400, detail="Dataset datasource is inactive")

    return dataset, view


async def execute_preview_query(
    spec: QuerySpec,
    db: Session,
    current_user: User,
    correlation_id: str | None = None,
) -> QueryPreviewResponse:
    _ = current_user
    dataset, view = _validate_dataset_and_view(spec, db)
    access = resolve_datasource_access(
        datasource=dataset.datasource,
        dataset=dataset,
        current_user=current_user,
    )
    payload = await get_engine_client().execute_query(
        datasource_id=access.datasource_id,
        workspace_id=access.workspace_id,
        dataset_id=access.dataset_id,
        query_spec=to_engine_query_spec(spec, view=view),
        datasource_url=access.datasource_url,
        actor_user_id=access.actor_user_id,
        correlation_id=correlation_id,
    )
    return QueryPreviewResponse(
        columns=payload.get("columns", []),
        rows=payload.get("rows", []),
        row_count=int(payload.get("row_count", 0)),
    )


@router.post("/preview", response_model=QueryPreviewResponse)
async def preview_query(
    spec: QuerySpec,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await execute_preview_query(spec, db, current_user, _resolve_correlation_id(request))


@router.post("/execute", response_model=QueryPreviewResponse)
async def execute_query(
    spec: QuerySpec,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await execute_preview_query(spec, db, current_user, _resolve_correlation_id(request))


@router.post("/preview/batch", response_model=QueryPreviewBatchResponse)
async def preview_query_batch(
    request: QueryPreviewBatchRequest,
    http_request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not request.queries:
        return QueryPreviewBatchResponse(results=[])

    correlation_id = _resolve_correlation_id(http_request)
    indexed_queries: list[dict[str, object]] = []
    for item in request.queries:
        dataset, view = _validate_dataset_and_view(item.spec, db)
        indexed_queries.append(
            {
                "request_id": item.widget_id,
                "spec": to_engine_query_spec(item.spec, view=view),
                "access": resolve_datasource_access(
                    datasource=dataset.datasource,
                    dataset=dataset,
                    current_user=current_user,
                ),
            }
        )

    grouped_by_access: dict[tuple[int, int, int | None, str], list[dict[str, object]]] = {}
    for item in indexed_queries:
        access = item["access"]
        group_key = (
            access.datasource_id,
            access.workspace_id,
            access.dataset_id,
            access.datasource_url,
        )
        grouped_by_access.setdefault(group_key, []).append(item)

    by_request_id: dict[str, dict[str, object]] = {}
    for _group_key, group in grouped_by_access.items():
        access = group[0]["access"]
        payload = await get_engine_client().execute_query_batch(
            datasource_id=access.datasource_id,
            workspace_id=access.workspace_id,
            dataset_id=access.dataset_id,
            queries=[{"request_id": item["request_id"], "spec": item["spec"]} for item in group],
            datasource_url=access.datasource_url,
            actor_user_id=access.actor_user_id,
            correlation_id=correlation_id,
        )
        for item in payload.get("results", []):
            by_request_id[str(item.get("request_id"))] = item.get("result", {})

    results: list[QueryPreviewBatchItemResponse] = []
    for item in request.queries:
        engine_item = by_request_id.get(item.widget_id)
        if engine_item is None:
            raise HTTPException(status_code=500, detail=f"Missing batch result for widget_id={item.widget_id}")
        results.append(
            QueryPreviewBatchItemResponse(
                widget_id=item.widget_id,
                columns=engine_item.get("columns", []),
                rows=engine_item.get("rows", []),
                row_count=int(engine_item.get("row_count", 0)),
                cache_hit=bool(engine_item.get("cache_hit", False)),
            )
        )

    return QueryPreviewBatchResponse(results=results)
