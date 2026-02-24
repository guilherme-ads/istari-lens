"""DataSource management endpoints."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from sqlalchemy import text
from datetime import datetime
import re
from cryptography.fernet import InvalidToken

from app.modules.core.legacy import models, schemas
from app.shared.infrastructure.database import get_db
from app.modules.auth.adapters.api.dependencies import get_current_admin_user
from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.shared.observability.external_query_logging import log_external_query

router = APIRouter(prefix="/datasources", tags=["datasources"])

try:
    import psycopg2
except ModuleNotFoundError:  # pragma: no cover - environment-dependent dependency
    psycopg2 = None


def _require_psycopg2() -> None:
    if psycopg2 is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="psycopg2 is required for datasource connectivity checks",
        )


def _validate_schema_pattern(pattern: str | None) -> None:
    if pattern is None:
        return
    if len(pattern) > 256:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="schema_pattern is too long",
        )
    try:
        re.compile(pattern)
    except re.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="schema_pattern is not a valid regex",
        )


@router.post("/", response_model=schemas.DataSourceResponse)
def create_datasource(
    request: schemas.DataSourceCreateRequest,
    current_user: models.User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Create a new data source. Admin only."""
    _require_psycopg2()
    _validate_schema_pattern(request.schema_pattern)
    # Validate connection before saving
    try:
        conn = psycopg2.connect(request.database_url)
        conn.close()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to connect to database",
        )
    
    # Encrypt the database URL before storing
    encrypted_url = credential_encryptor.encrypt(request.database_url)
    
    datasource = models.DataSource(
        name=request.name,
        description=request.description,
        database_url=encrypted_url,
        schema_pattern=request.schema_pattern,
        created_by_id=current_user.id,
    )
    db.add(datasource)
    db.commit()
    db.refresh(datasource)
    return datasource


@router.get("/", response_model=list[schemas.DataSourceResponse])
def list_datasources(
    skip: int = 0,
    limit: int = 100,
    is_active: bool = None,
    db: Session = Depends(get_db),
):
    """List all data sources."""
    query = db.query(models.DataSource)
    query = query.filter(
        (models.DataSource.status.is_(None)) | (models.DataSource.status != "draft")
    )
    
    if is_active is not None:
        query = query.filter(models.DataSource.is_active == is_active)
    
    return query.offset(skip).limit(limit).all()


@router.get("/{datasource_id}", response_model=schemas.DataSourceDetailResponse)
def get_datasource(
    datasource_id: int,
    db: Session = Depends(get_db),
):
    """Get a specific data source with its views."""
    datasource = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id
    ).first()
    
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="DataSource not found",
        )
    
    return datasource


@router.patch("/{datasource_id}", response_model=schemas.DataSourceResponse)
def update_datasource(
    datasource_id: int,
    request: schemas.DataSourceUpdateRequest,
    current_user: models.User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Update a data source. Admin only."""
    datasource = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id
    ).first()
    
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="DataSource not found",
        )
    
    if request.name:
        datasource.name = request.name
    if request.description is not None:
        datasource.description = request.description
    if request.schema_pattern is not None:
        _validate_schema_pattern(request.schema_pattern)
        datasource.schema_pattern = request.schema_pattern
    if request.is_active is not None:
        datasource.is_active = request.is_active
        datasource.status = "active" if request.is_active else "inactive"
        if request.is_active is False:
            db.query(models.View).filter(
                models.View.datasource_id == datasource_id,
                models.View.is_active == True,  # noqa: E712
            ).update({"is_active": False}, synchronize_session=False)
            db.query(models.Dataset).filter(
                models.Dataset.datasource_id == datasource_id,
                models.Dataset.is_active == True,  # noqa: E712
            ).update({"is_active": False}, synchronize_session=False)

    datasource.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(datasource)
    return datasource


@router.get("/{datasource_id}/deletion-impact", response_model=schemas.DataSourceDeletionImpactResponse)
def get_datasource_deletion_impact(
    datasource_id: int,
    current_user: models.User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    datasource = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="DataSource not found",
        )

    datasets = db.query(models.Dataset).filter(models.Dataset.datasource_id == datasource_id).all()
    dataset_ids = [dataset.id for dataset in datasets]
    dashboards: list[models.Dashboard] = []
    if dataset_ids:
        dashboards = (
            db.query(models.Dashboard)
            .filter(models.Dashboard.dataset_id.in_(dataset_ids))
            .order_by(models.Dashboard.id.asc())
            .all()
        )

    dataset_name_by_id = {dataset.id: dataset.name for dataset in datasets}
    return schemas.DataSourceDeletionImpactResponse(
        datasource_id=datasource.id,
        datasource_name=datasource.name,
        datasets_count=len(datasets),
        dashboards_count=len(dashboards),
        dashboards=[
            schemas.DataSourceDeletionImpactDashboardResponse(
                dashboard_id=item.id,
                dashboard_name=item.name,
                dataset_id=item.dataset_id,
                dataset_name=dataset_name_by_id.get(item.dataset_id, f"Dataset {item.dataset_id}"),
            )
            for item in dashboards
        ],
    )


@router.delete("/{datasource_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_datasource(
    datasource_id: int,
    current_user: models.User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Delete a data source. Admin only."""
    datasource = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id
    ).first()
    
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="DataSource not found",
        )

    if datasource.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="DataSource must be deactivated before deletion",
        )

    analyses_has_datasource_id = db.execute(
        text(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = 'analyses'
              AND column_name = 'datasource_id'
            LIMIT 1
            """
        )
    ).first()

    if analyses_has_datasource_id:
        usage_count = db.query(func.count(models.Analysis.id)).filter(
            models.Analysis.datasource_id == datasource_id
        ).scalar()
    else:
        usage_count = db.execute(
            text(
                """
                SELECT COUNT(a.id)
                FROM analyses a
                JOIN views v ON v.id = a.dataset_id
                WHERE v.datasource_id = :datasource_id
                """
            ),
            {"datasource_id": datasource_id},
        ).scalar()

    if usage_count and usage_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="DataSource cannot be deleted because it is used in analyses",
        )

    db.delete(datasource)
    db.commit()


@router.post("/{datasource_id}/sync")
def sync_views(
    datasource_id: int,
    current_user: models.User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """
    Sync views from remote PostgreSQL database.
    Connects to the external DB, reads INFORMATION_SCHEMA, and creates View records.
    """
    _require_psycopg2()
    datasource = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id
    ).first()
    
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="DataSource not found",
        )
    if not datasource.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="DataSource is inactive and cannot be synchronized",
        )
    
    try:
        # Decrypt the database URL
        decrypted_url = credential_encryptor.decrypt(datasource.database_url)

        synced_count = 0
        created_count = 0
        updated_count = 0
        pattern = re.compile(datasource.schema_pattern) if datasource.schema_pattern else None

        # Connect to remote database
        with psycopg2.connect(decrypted_url) as conn:
            with conn.cursor() as cursor:
                # Get all views from information_schema
                sql_list_views = """
                    SELECT 
                        table_schema,
                        table_name
                    FROM information_schema.views
                    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY table_schema, table_name
                """
                log_external_query(
                    sql=sql_list_views,
                    params=(),
                    context=f"datasource_sync:list_views:{datasource_id}",
                    datasource_id=datasource_id,
                )
                cursor.execute(sql_list_views)

                remote_views = cursor.fetchall()

                for schema_name, view_name in remote_views:
                    # Check if schema matches pattern (if provided)
                    if pattern and not pattern.match(schema_name):
                        continue

                    # Check if view already exists
                    existing_view = db.query(models.View).filter(
                        models.View.datasource_id == datasource_id,
                        models.View.schema_name == schema_name,
                        models.View.view_name == view_name,
                    ).first()

                    # Get columns for this view
                    sql_list_columns = """
                        SELECT 
                            column_name,
                            data_type,
                            column_default,
                            is_nullable
                        FROM information_schema.columns
                        WHERE table_schema = %s AND table_name = %s
                        ORDER BY ordinal_position
                    """
                    log_external_query(
                        sql=sql_list_columns,
                        params=(schema_name, view_name),
                        context=f"datasource_sync:list_columns:{datasource_id}:{schema_name}.{view_name}",
                        datasource_id=datasource_id,
                    )
                    cursor.execute(sql_list_columns, (schema_name, view_name))

                    columns = cursor.fetchall()

                    if existing_view:
                        view = existing_view
                        db.query(models.ViewColumn).filter(models.ViewColumn.view_id == view.id).delete()
                        updated_count += 1
                    else:
                        view = models.View(
                            datasource_id=datasource_id,
                            schema_name=schema_name,
                            view_name=view_name,
                            is_active=True,
                        )
                        db.add(view)
                        db.flush()  # Get the view ID
                        created_count += 1

                    # Rebuild ViewColumn records based on current remote metadata.
                    for col_name, col_type, col_default, is_nullable in columns:
                        col_type_norm = (col_type or "").lower()
                        is_numeric = any(t in col_type_norm for t in ["int", "decimal", "numeric", "float", "double"])
                        is_date = "date" in col_type_norm or "time" in col_type_norm

                        view_column = models.ViewColumn(
                            view_id=view.id,
                            column_name=col_name,
                            column_type=col_type,
                            is_aggregatable=is_numeric,
                            is_filterable=True,
                            is_groupable=is_date or not is_numeric,
                        )
                        db.add(view_column)

                    synced_count += 1

                # Update last synced timestamp
                datasource.last_synced_at = datetime.utcnow()
                db.commit()

        db.refresh(datasource)
        return {
            "status": "success",
            "synced_views": synced_count,
            "created_views": created_count,
            "updated_views": updated_count,
            "datasource_id": datasource_id,
            "last_synced_at": datasource.last_synced_at,
        }

    except HTTPException:
        raise
    except InvalidToken:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Datasource credentials are invalid for current encryption key. Recreate datasource with a valid database URL.",
        )
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to sync views: {repr(e)}",
        )


