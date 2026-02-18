from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.shared.infrastructure.database import get_db, get_analytics_connection
from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import User, View
from app.modules.core.legacy.schemas import ViewSchemaColumnResponse
from app.modules.widgets.domain.config import normalize_column_type
from app.shared.observability.external_query_logging import log_external_query

router = APIRouter(prefix="/views", tags=["views"])


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
    schema_name: str | None = Query(default=None),
    datasource_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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

    conn = None
    try:
        conn = await get_analytics_connection()
        sql = """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """
        params = (view.schema_name, view.view_name)
        log_external_query(
            sql=sql,
            params=params,
            context=f"view_schema_columns:view:{view.id}",
            datasource_id=view.datasource_id,
        )
        result = await conn.execute(sql, params)
        rows = await result.fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="No columns found for the view")
        return [
            ViewSchemaColumnResponse(
                column_name=row[0],
                column_type=row[1],
                normalized_type=normalize_column_type(row[1]),
            )
            for row in rows
        ]
    finally:
        if conn:
            await conn.close()


