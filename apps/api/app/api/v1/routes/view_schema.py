from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.shared.infrastructure.database import get_db
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import User, View
from app.modules.core.legacy.schemas import ViewSchemaColumnResponse
from app.modules.engine.client import get_engine_client
from app.modules.engine.access import resolve_datasource_access
from app.modules.widgets.domain.config import normalize_column_type

router = APIRouter(prefix="/views", tags=["views"])


def _resolve_correlation_id(request: Request) -> str | None:
    return request.headers.get("x-correlation-id") or request.headers.get("x-request-id")


def _resolve_view(
    db: Session,
    view_name: str,
    schema_name: str | None,
    datasource_id: int | None,
) -> View | None:
    schema_from_path = schema_name
    name_from_path = view_name

    if "." in view_name:
        parts = view_name.split(".", 1)
        schema_from_path = schema_from_path or parts[0]
        name_from_path = parts[1]

    query = db.query(View).filter(View.view_name == name_from_path)
    if schema_from_path:
        query = query.filter(View.schema_name == schema_from_path)
    if datasource_id is not None:
        query = query.filter(View.datasource_id == datasource_id)
    return query.first()


@router.get("/{view_name}/columns", response_model=list[ViewSchemaColumnResponse])
async def get_view_columns(
    view_name: str,
    request: Request,
    schema_name: str | None = Query(default=None),
    datasource_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    view = _resolve_view(db, view_name, schema_name, datasource_id)
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    if view.columns:
        return [
            ViewSchemaColumnResponse(
                column_name=col.column_name,
                column_type=col.column_type,
                normalized_type=normalize_column_type(col.column_type),
            )
            for col in view.columns
        ]

    payload = await get_engine_client().get_schema(
        datasource_id=int(view.datasource_id),
        workspace_id=int(view.datasource.created_by_id),
        dataset_id=None,
        resource_id=f"{view.schema_name}.{view.view_name}",
        datasource_url=resolve_datasource_access(
            datasource=view.datasource,
            dataset=None,
            current_user=current_user,
        ).datasource_url,
        actor_user_id=current_user.id,
        correlation_id=_resolve_correlation_id(request),
    )
    fields = payload.get("fields", [])
    if not fields:
        raise HTTPException(status_code=404, detail="No columns found for the view")
    return [
        ViewSchemaColumnResponse(
            column_name=field["name"],
            column_type=field["data_type"],
            normalized_type=normalize_column_type(field["data_type"]),
        )
        for field in fields
    ]


