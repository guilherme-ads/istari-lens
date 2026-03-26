from copy import deepcopy
from datetime import datetime
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query, status
import psycopg
from psycopg import sql
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from typing import Any, List

from app.shared.infrastructure.database import get_db
from app.modules.core.legacy.models import (
    User,
    Dataset,
    DatasetEmailShare,
    View,
    DataSource,
    DatasetImportConfig,
    DatasetSyncRun,
    DatasetSyncSchedule,
)
from app.modules.datasets.sync_services import DatasetSyncSchedulerService, cleanup_imported_dataset_assets
from app.modules.catalog import SemanticCatalogService
from app.modules.engine.datasource import resolve_datasource_url
from app.modules.datasets.access import (
    can_view_organization_data,
    ensure_dataset_manage_access,
    find_dataset_email_share,
    load_dataset_with_access_relations,
    normalize_email,
)
from app.modules.datasets import (
    build_legacy_base_query_spec,
    has_published_import_binding,
    validate_and_resolve_base_query_spec,
)
from app.modules.core.legacy.schemas import (
    DatasetBulkImportEnableRequest,
    DatasetBulkImportEnableResponse,
    DatasetBulkImportEnableSkipItem,
    DatasetCreateRequest,
    DatasetEmailShareResponse,
    DatasetImportConfigResponse,
    DatasetImportConfigUpsertRequest,
    DatasetResponse,
    DatasetShareUpsertRequest,
    DatasetSharingResponse,
    DatasetSyncRunCreateRequest,
    DatasetSyncRunListResponse,
    DatasetSyncRunResponse,
    DatasetSyncScheduleResponse,
    DatasetSyncScheduleUpsertRequest,
    DatasetUpdateRequest,
)
from app.modules.auth.adapters.api.dependencies import get_current_user, get_current_admin_user

router = APIRouter(prefix="/datasets", tags=["datasets"])
logger = logging.getLogger(__name__)
_SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_JOIN_CARDINALITY_SAMPLE_LIMIT = 50000


def _to_psycopg_url(url: str) -> str:
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


def _normalize_identifier(raw_value: str) -> str:
    value = str(raw_value or "").strip().strip('"')
    if not value or not _SAFE_IDENTIFIER_RE.match(value):
        raise ValueError(f"Invalid identifier: {raw_value!r}")
    return value


def _split_resource_id(resource_id: str) -> tuple[str, str]:
    normalized = str(resource_id or "").strip()
    if "." not in normalized:
        raise ValueError("resource_id must be in 'schema.resource' format")
    schema_name, relation_name = normalized.split(".", 1)
    return _normalize_identifier(schema_name), _normalize_identifier(relation_name)


def _classify_join_cardinality(*, left_is_unique: bool, right_is_unique: bool) -> str:
    if left_is_unique and right_is_unique:
        return "1-1"
    if left_is_unique and not right_is_unique:
        return "1-N"
    if not left_is_unique and right_is_unique:
        return "N-1"
    return "N-N"


def _sampled_key_uniqueness(
    *,
    conn: psycopg.Connection,
    schema_name: str,
    relation_name: str,
    columns: list[str],
    sample_limit: int,
) -> tuple[bool | None, int]:
    if not columns:
        return None, 0
    normalized_columns = [_normalize_identifier(column) for column in columns]
    with conn.cursor() as cur:
        sample_count_sql = sql.SQL(
            "SELECT COUNT(*) FROM (SELECT 1 FROM {}.{} LIMIT %s) AS sampled_rows"
        ).format(sql.Identifier(schema_name), sql.Identifier(relation_name))
        cur.execute(sample_count_sql, (int(sample_limit),))
        sampled_rows_raw = cur.fetchone()
        sampled_rows = int(sampled_rows_raw[0] or 0) if sampled_rows_raw else 0
        if sampled_rows <= 1:
            return True if sampled_rows == 1 else None, sampled_rows

        grouped_columns = [sql.Identifier(column) for column in normalized_columns]
        not_null_checks = [
            sql.SQL("{} IS NOT NULL").format(sql.Identifier(column))
            for column in normalized_columns
        ]
        duplicates_sql = sql.SQL(
            "WITH sampled AS (SELECT {} FROM {}.{} LIMIT %s) "
            "SELECT EXISTS ("
            "SELECT 1 FROM sampled WHERE {} GROUP BY {} HAVING COUNT(*) > 1 LIMIT 1"
            ")"
        ).format(
            sql.SQL(", ").join(grouped_columns),
            sql.Identifier(schema_name),
            sql.Identifier(relation_name),
            sql.SQL(" AND ").join(not_null_checks),
            sql.SQL(", ").join(grouped_columns),
        )
        cur.execute(duplicates_sql, (int(sample_limit),))
        has_duplicates_raw = cur.fetchone()
        has_duplicates = bool(has_duplicates_raw[0]) if has_duplicates_raw else False
        return (not has_duplicates), sampled_rows


def _estimate_join_cardinality_by_sampling(
    *,
    datasource: DataSource,
    base_query_spec: dict[str, Any],
    sample_limit: int = _JOIN_CARDINALITY_SAMPLE_LIMIT,
) -> dict[str, Any]:
    source_url = resolve_datasource_url(datasource)
    if not source_url:
        return base_query_spec

    spec = deepcopy(base_query_spec)
    base = spec.get("base") if isinstance(spec.get("base"), dict) else None
    if not isinstance(base, dict):
        return base_query_spec
    resources = base.get("resources") if isinstance(base.get("resources"), list) else []
    joins = base.get("joins") if isinstance(base.get("joins"), list) else []
    if not joins:
        return spec

    resources_by_id: dict[str, tuple[str, str]] = {}
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_key = str(item.get("id") or "").strip()
        resource_id = str(item.get("resource_id") or "").strip()
        if not resource_key or not resource_id:
            continue
        try:
            resources_by_id[_normalize_identifier(resource_key)] = _split_resource_id(resource_id)
        except Exception:
            continue

    safe_url = _to_psycopg_url(source_url)
    sampled_at = datetime.utcnow().isoformat()
    try:
        with psycopg.connect(safe_url) as conn:
            for join in joins:
                if not isinstance(join, dict):
                    continue
                left_resource = str(join.get("left_resource") or "").strip()
                right_resource = str(join.get("right_resource") or "").strip()
                try:
                    left_key = _normalize_identifier(left_resource)
                    right_key = _normalize_identifier(right_resource)
                except Exception:
                    continue
                left_ref = resources_by_id.get(left_key)
                right_ref = resources_by_id.get(right_key)
                if not left_ref or not right_ref:
                    continue
                on_items = join.get("on") if isinstance(join.get("on"), list) else []
                left_columns: list[str] = []
                right_columns: list[str] = []
                for item in on_items:
                    if not isinstance(item, dict):
                        continue
                    left_column = str(item.get("left_column") or "").strip()
                    right_column = str(item.get("right_column") or "").strip()
                    if not left_column or not right_column:
                        continue
                    left_columns.append(left_column)
                    right_columns.append(right_column)
                if not left_columns or not right_columns:
                    continue

                left_unique, left_rows = _sampled_key_uniqueness(
                    conn=conn,
                    schema_name=left_ref[0],
                    relation_name=left_ref[1],
                    columns=left_columns,
                    sample_limit=sample_limit,
                )
                right_unique, right_rows = _sampled_key_uniqueness(
                    conn=conn,
                    schema_name=right_ref[0],
                    relation_name=right_ref[1],
                    columns=right_columns,
                    sample_limit=sample_limit,
                )
                estimated_value = (
                    _classify_join_cardinality(left_is_unique=left_unique, right_is_unique=right_unique)
                    if left_unique is not None and right_unique is not None
                    else "indefinida"
                )
                previous = join.get("cardinality") if isinstance(join.get("cardinality"), dict) else {}
                actual = previous.get("actual") if isinstance(previous.get("actual"), dict) else None
                next_cardinality: dict[str, Any] = {
                    "estimated": {
                        "value": estimated_value,
                        "method": "sample_limit",
                        "sample_rows_left": int(left_rows),
                        "sample_rows_right": int(right_rows),
                        "sample_rows": int(min(left_rows, right_rows)),
                        "sample_limit": int(sample_limit),
                        "sampled_at": sampled_at,
                    }
                }
                if actual is not None:
                    next_cardinality["actual"] = actual
                join["cardinality"] = next_cardinality
    except Exception:
        logger.exception("Failed to estimate join cardinality by sampling")
        return base_query_spec

    return spec


def _semantic_description_map(raw_items: list[dict[str, Any]] | None) -> dict[str, str]:
    if not isinstance(raw_items, list):
        return {}
    result: dict[str, str] = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        description = item.get("description")
        if not isinstance(description, str):
            continue
        normalized = description.strip()
        if not normalized:
            continue
        result[name.strip()] = normalized
    return result


def _apply_semantic_descriptions(
    semantic_columns: list[dict[str, Any]],
    description_map: dict[str, str],
) -> list[dict[str, Any]]:
    if not semantic_columns:
        return semantic_columns
    if not description_map:
        return semantic_columns
    enriched: list[dict[str, Any]] = []
    for item in semantic_columns:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        name = next_item.get("name")
        if isinstance(name, str):
            description = description_map.get(name.strip())
            if description:
                next_item["description"] = description
        enriched.append(next_item)
    return enriched


def _resolve_dataset_view(
    *,
    db: Session,
    datasource_id: int,
    view_id: int | None,
) -> View | None:
    if view_id is None:
        return None
    view = (
        db.query(View)
        .filter(
            View.id == view_id,
            View.datasource_id == datasource_id,
        )
        .first()
    )
    if not view:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="View not found for the provided datasource",
        )
    if not view.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="View is inactive",
        )
    if not view.datasource or not view.datasource.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Datasource is inactive",
        )
    return view


def _resolve_dataset_datasource(*, db: Session, datasource_id: int) -> DataSource:
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Datasource not found")
    if not datasource.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Datasource is inactive")
    return datasource


def _datasource_allows_import(datasource: DataSource) -> bool:
    return str(getattr(datasource, "copy_policy", "allowed") or "allowed").strip().lower() != "forbidden"


def _datasource_is_spreadsheet_origin(datasource: DataSource | None) -> bool:
    if datasource is None:
        return False
    source_type = str(getattr(datasource, "source_type", "") or "").strip().lower()
    return source_type == "file_spreadsheet_import"


def _validate_dataset_access_mode_for_datasource(*, datasource: DataSource, access_mode: str) -> None:
    normalized_mode = str(access_mode or "direct").strip().lower()
    if normalized_mode == "imported" and not _datasource_allows_import(datasource):
        raise HTTPException(status_code=400, detail="Datasource copy_policy forbids imported mode")
    if normalized_mode == "direct" and _datasource_is_spreadsheet_origin(datasource):
        raise HTTPException(
            status_code=400,
            detail="Spreadsheet-origin datasets must use imported access_mode",
        )


def _normalize_dataset_access_mode(value: str | None, *, fallback: str = "direct") -> str:
    normalized = str(value or fallback).strip().lower()
    if normalized not in {"direct", "imported"}:
        return "direct"
    return normalized


def _resource_schema_name(resource_id: str | None) -> str | None:
    value = str(resource_id or "").strip()
    if "." not in value:
        return None
    schema, _ = value.split(".", 1)
    schema_name = schema.strip().strip('"')
    if not schema_name:
        return None
    return schema_name.lower()


def _base_query_spec_uses_workspace_internal_schema(
    *,
    base_query_spec: dict[str, Any] | None,
    workspace_id: int,
) -> bool:
    if not isinstance(base_query_spec, dict):
        return False
    expected_schema = f"lens_imp_t{int(workspace_id)}".lower()
    base = base_query_spec.get("base")
    if not isinstance(base, dict):
        return False

    primary_resource = base.get("primary_resource")
    if isinstance(primary_resource, str) and _resource_schema_name(primary_resource) == expected_schema:
        return True

    resources = base.get("resources")
    if not isinstance(resources, list):
        return False
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_id = item.get("resource_id")
        if isinstance(resource_id, str) and _resource_schema_name(resource_id) == expected_schema:
            return True
    return False


_ACTIVE_SYNC_RUN_STATUSES = {"queued", "running"}
_RETRYABLE_SYNC_RUN_STATUSES = {"failed", "drift_blocked", "canceled", "skipped"}


def _ensure_dataset_import_mode(dataset: Dataset) -> None:
    if str(getattr(dataset, "access_mode", "direct") or "direct").strip().lower() != "imported":
        raise HTTPException(status_code=409, detail="Dataset access_mode must be imported for this operation")


def _to_sync_run_response(run: DatasetSyncRun, *, coalesced: bool = False) -> DatasetSyncRunResponse:
    payload = DatasetSyncRunResponse.model_validate(run)
    payload.coalesced = coalesced
    return payload


def _find_active_sync_run(*, db: Session, dataset_id: int) -> DatasetSyncRun | None:
    return (
        db.query(DatasetSyncRun)
        .filter(
            DatasetSyncRun.dataset_id == dataset_id,
            DatasetSyncRun.status.in_(list(_ACTIVE_SYNC_RUN_STATUSES)),
        )
        .order_by(DatasetSyncRun.id.desc())
        .first()
    )


def _ensure_import_config(*, db: Session, dataset: Dataset, actor_user_id: int) -> DatasetImportConfig:
    if dataset.import_config is not None:
        return dataset.import_config
    config = DatasetImportConfig(
        dataset_id=int(dataset.id),
        refresh_mode="full_refresh",
        drift_policy="block_on_breaking",
        enabled=True,
        max_runtime_seconds=None,
        state_hash=None,
        created_by_id=actor_user_id,
        updated_by_id=actor_user_id,
    )
    db.add(config)
    db.flush()
    return config


def _enqueue_sync_run(
    *,
    db: Session,
    dataset: Dataset,
    trigger_type: str,
    attempt: int,
    input_snapshot: dict[str, Any] | None = None,
    status: str = "queued",
) -> DatasetSyncRun:
    run = DatasetSyncRun(
        dataset_id=int(dataset.id),
        trigger_type=trigger_type,
        status=status,
        attempt=attempt,
        queued_at=datetime.utcnow(),
        input_snapshot=input_snapshot or {},
        stats={},
    )
    db.add(run)
    db.flush()
    dataset.last_sync_run_id = int(run.id)
    if has_published_import_binding(dataset):
        dataset.data_status = "syncing"
    else:
        dataset.data_status = "initializing"
    return run


def _bootstrap_imported_dataset(
    *,
    db: Session,
    dataset: Dataset,
    actor_user_id: int,
    trigger_type: str = "initial",
    enqueue_initial_sync: bool = True,
) -> bool:
    _ensure_import_config(db=db, dataset=dataset, actor_user_id=actor_user_id)
    if has_published_import_binding(dataset):
        return False
    if dataset.data_status not in {"initializing", "syncing"}:
        dataset.data_status = "initializing"
    if not enqueue_initial_sync:
        return False
    active_run = _find_active_sync_run(db=db, dataset_id=int(dataset.id))
    if active_run is not None:
        return False
    _enqueue_sync_run(
        db=db,
        dataset=dataset,
        trigger_type=trigger_type,
        attempt=1,
        input_snapshot={},
    )
    return True


@router.get("", response_model=List[DatasetResponse])
async def list_datasets(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List all active datasets available to the user."""
    query = (
        db.query(Dataset)
        .join(DataSource, DataSource.id == Dataset.datasource_id)
        .filter(Dataset.is_active == True)
    )
    if not can_view_organization_data(current_user):
        normalized_email = normalize_email(current_user.email)
        share_exists = (
            db.query(DatasetEmailShare.id)
            .filter(
                DatasetEmailShare.dataset_id == Dataset.id,
                func.lower(DatasetEmailShare.email) == normalized_email,
            )
            .exists()
        )
        query = query.filter(
            or_(
                DataSource.created_by_id == current_user.id,
                share_exists,
            )
        )
    datasets = query.all()
    response_items: list[DatasetResponse] = []
    for dataset in datasets:
        persisted_descriptions = _semantic_description_map(
            dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None
        )
        runtime_semantic_columns = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        if isinstance(dataset.base_query_spec, dict):
            try:
                _, runtime_semantic_columns = validate_and_resolve_base_query_spec(
                    db=db,
                    datasource_id=int(dataset.datasource_id),
                    base_query_spec=dataset.base_query_spec,
                )
            except HTTPException:
                runtime_semantic_columns = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        runtime_semantic_columns = _apply_semantic_descriptions(runtime_semantic_columns, persisted_descriptions)
        payload = DatasetResponse.model_validate(dataset)
        payload.semantic_columns = runtime_semantic_columns
        response_items.append(payload)
    return response_items


@router.post("", response_model=DatasetResponse)
async def create_dataset(
    request: DatasetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a dataset from legacy view reference or from base_query_spec."""
    datasource = _resolve_dataset_datasource(db=db, datasource_id=request.datasource_id)
    if not current_user.is_admin and int(datasource.created_by_id) != int(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to create datasets for this datasource")
    resolved_access_mode = _normalize_dataset_access_mode(
        request.access_mode,
        fallback=str(datasource.default_dataset_access_mode or "direct"),
    )
    view = _resolve_dataset_view(db=db, datasource_id=request.datasource_id, view_id=request.view_id)

    resolved_base_query_spec = request.base_query_spec
    allow_workspace_internal_resources = (
        resolved_access_mode == "imported"
        or _base_query_spec_uses_workspace_internal_schema(
            base_query_spec=request.base_query_spec if isinstance(request.base_query_spec, dict) else None,
            workspace_id=int(datasource.created_by_id),
        )
    )
    if resolved_base_query_spec is not None:
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=request.datasource_id,
            base_query_spec=resolved_base_query_spec,
            allow_workspace_internal_resources=allow_workspace_internal_resources,
            workspace_id=int(datasource.created_by_id),
        )
        resolved_base_query_spec = _estimate_join_cardinality_by_sampling(
            datasource=datasource,
            base_query_spec=resolved_base_query_spec,
        )
    elif view is not None:
        resolved_base_query_spec = build_legacy_base_query_spec(
            datasource_id=request.datasource_id,
            view=view,
        )
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=request.datasource_id,
            base_query_spec=resolved_base_query_spec,
            allow_workspace_internal_resources=allow_workspace_internal_resources,
            workspace_id=int(datasource.created_by_id),
        )
        resolved_base_query_spec = _estimate_join_cardinality_by_sampling(
            datasource=datasource,
            base_query_spec=resolved_base_query_spec,
        )
    else:
        semantic_columns = []
    semantic_columns = _apply_semantic_descriptions(
        semantic_columns,
        _semantic_description_map(request.semantic_columns),
    )
    if _base_query_spec_uses_workspace_internal_schema(
        base_query_spec=resolved_base_query_spec if isinstance(resolved_base_query_spec, dict) else None,
        workspace_id=int(datasource.created_by_id),
    ):
        resolved_access_mode = "imported"
    _validate_dataset_access_mode_for_datasource(datasource=datasource, access_mode=resolved_access_mode)

    dataset = Dataset(
        datasource_id=request.datasource_id,
        view_id=request.view_id,
        access_mode=resolved_access_mode,
        data_status="initializing" if resolved_access_mode == "imported" else "ready",
        name=request.name,
        description=request.description,
        base_query_spec=resolved_base_query_spec,
        semantic_columns=semantic_columns,
        is_active=request.is_active,
    )
    db.add(dataset)
    db.flush()
    if dataset.access_mode == "imported":
        _bootstrap_imported_dataset(
            db=db,
            dataset=dataset,
            actor_user_id=int(current_user.id),
            trigger_type="initial",
            enqueue_initial_sync=True,
        )
    SemanticCatalogService(db).ensure_dataset_catalog(dataset=dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


@router.patch("/{dataset_id}", response_model=DatasetResponse)
async def update_dataset(
    dataset_id: int,
    request: DatasetUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update dataset metadata/base_query_spec."""
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if dataset.datasource is None:
        raise HTTPException(status_code=400, detail="Dataset datasource is unavailable")

    if request.name is not None:
        dataset.name = request.name
    if request.description is not None:
        dataset.description = request.description
    if request.view_id is not None:
        view = _resolve_dataset_view(db=db, datasource_id=dataset.datasource_id, view_id=request.view_id)
        dataset.view_id = request.view_id
        if request.base_query_spec is None and view is not None:
            resolved_base_query_spec = build_legacy_base_query_spec(
                datasource_id=dataset.datasource_id,
                view=view,
            )
            resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
                db=db,
                datasource_id=dataset.datasource_id,
                base_query_spec=resolved_base_query_spec,
                allow_workspace_internal_resources=dataset.access_mode == "imported",
                workspace_id=int(dataset.datasource.created_by_id),
            )
            resolved_base_query_spec = _estimate_join_cardinality_by_sampling(
                datasource=dataset.datasource,
                base_query_spec=resolved_base_query_spec,
            )
            dataset.base_query_spec = resolved_base_query_spec
            dataset.semantic_columns = _apply_semantic_descriptions(
                semantic_columns,
                _semantic_description_map(request.semantic_columns)
                or _semantic_description_map(dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None),
            )
    if request.base_query_spec is not None:
        requested_access_mode = _normalize_dataset_access_mode(
            request.access_mode,
            fallback=str(dataset.access_mode or "direct"),
        )
        allow_workspace_internal_resources = (
            requested_access_mode == "imported"
            or _base_query_spec_uses_workspace_internal_schema(
                base_query_spec=request.base_query_spec,
                workspace_id=int(dataset.datasource.created_by_id),
            )
        )
        resolved_base_query_spec, semantic_columns = validate_and_resolve_base_query_spec(
            db=db,
            datasource_id=dataset.datasource_id,
            base_query_spec=request.base_query_spec,
            allow_workspace_internal_resources=allow_workspace_internal_resources,
            workspace_id=int(dataset.datasource.created_by_id),
        )
        resolved_base_query_spec = _estimate_join_cardinality_by_sampling(
            datasource=dataset.datasource,
            base_query_spec=resolved_base_query_spec,
        )
        dataset.base_query_spec = resolved_base_query_spec
        dataset.semantic_columns = _apply_semantic_descriptions(
            semantic_columns,
            _semantic_description_map(request.semantic_columns)
            or _semantic_description_map(dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else None),
        )
        # Imported datasets with an already published binding should not regress
        # to "initializing" on metadata/base_query_spec saves.
        if dataset.access_mode == "imported" and not has_published_import_binding(dataset):
            dataset.data_status = "initializing"
    elif request.semantic_columns is not None:
        current_semantic = dataset.semantic_columns if isinstance(dataset.semantic_columns, list) else []
        dataset.semantic_columns = _apply_semantic_descriptions(
            [dict(item) for item in current_semantic if isinstance(item, dict)],
            _semantic_description_map(request.semantic_columns),
        )

    next_access_mode = _normalize_dataset_access_mode(
        request.access_mode,
        fallback=str(dataset.access_mode or "direct"),
    )
    if _base_query_spec_uses_workspace_internal_schema(
        base_query_spec=dataset.base_query_spec if isinstance(dataset.base_query_spec, dict) else None,
        workspace_id=int(dataset.datasource.created_by_id),
    ):
        next_access_mode = "imported"
    _validate_dataset_access_mode_for_datasource(
        datasource=dataset.datasource,
        access_mode=next_access_mode,
    )
    if next_access_mode != dataset.access_mode:
        dataset.access_mode = next_access_mode
        if next_access_mode == "direct":
            dataset.execution_datasource_id = None
            dataset.execution_view_id = None
            dataset.data_status = "ready"
            dataset.last_successful_sync_at = None
            dataset.last_sync_run_id = None
            if dataset.sync_schedule is not None:
                dataset.sync_schedule.enabled = False
                dataset.sync_schedule.next_run_at = None
        else:
            _bootstrap_imported_dataset(
                db=db,
                dataset=dataset,
                actor_user_id=int(current_user.id),
                trigger_type="initial",
                enqueue_initial_sync=True,
            )

    if request.is_active is not None:
        dataset.is_active = request.is_active

    SemanticCatalogService(db).ensure_dataset_catalog(dataset=dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


@router.get("/{dataset_id}/import-config", response_model=DatasetImportConfigResponse)
async def get_dataset_import_config(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if dataset.import_config is None:
        raise HTTPException(status_code=404, detail="Dataset import config not found")
    return DatasetImportConfigResponse.model_validate(dataset.import_config)


@router.put("/{dataset_id}/import-config", response_model=DatasetImportConfigResponse)
async def upsert_dataset_import_config(
    dataset_id: int,
    request: DatasetImportConfigUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    config = _ensure_import_config(db=db, dataset=dataset, actor_user_id=int(current_user.id))
    config.refresh_mode = "full_refresh"
    config.drift_policy = "block_on_breaking"
    config.enabled = request.enabled
    config.max_runtime_seconds = request.max_runtime_seconds
    config.updated_by_id = int(current_user.id)
    db.commit()
    db.refresh(config)
    return DatasetImportConfigResponse.model_validate(config)


@router.post("/{dataset_id}/syncs", response_model=DatasetSyncRunResponse)
async def trigger_dataset_sync(
    dataset_id: int,
    request: DatasetSyncRunCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    _ensure_dataset_import_mode(dataset)
    _ensure_import_config(db=db, dataset=dataset, actor_user_id=int(current_user.id))

    active_run = _find_active_sync_run(db=db, dataset_id=int(dataset.id))
    if active_run is not None:
        return _to_sync_run_response(active_run, coalesced=True)

    run = _enqueue_sync_run(
        db=db,
        dataset=dataset,
        trigger_type="manual",
        attempt=1,
        input_snapshot=request.input_snapshot,
    )
    db.commit()
    db.refresh(run)
    return _to_sync_run_response(run, coalesced=False)


@router.get("/{dataset_id}/syncs", response_model=DatasetSyncRunListResponse)
async def list_dataset_sync_runs(
    dataset_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    runs = (
        db.query(DatasetSyncRun)
        .filter(DatasetSyncRun.dataset_id == dataset.id)
        .order_by(DatasetSyncRun.id.desc())
        .limit(limit)
        .all()
    )
    return DatasetSyncRunListResponse(
        items=[_to_sync_run_response(item, coalesced=False) for item in runs]
    )


@router.get("/{dataset_id}/syncs/{run_id}", response_model=DatasetSyncRunResponse)
async def get_dataset_sync_run(
    dataset_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    run = (
        db.query(DatasetSyncRun)
        .filter(
            DatasetSyncRun.id == run_id,
            DatasetSyncRun.dataset_id == dataset.id,
        )
        .first()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Dataset sync run not found")
    return _to_sync_run_response(run, coalesced=False)


@router.post("/{dataset_id}/syncs/{run_id}/retry", response_model=DatasetSyncRunResponse)
async def retry_dataset_sync_run(
    dataset_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    _ensure_dataset_import_mode(dataset)

    previous_run = (
        db.query(DatasetSyncRun)
        .filter(
            DatasetSyncRun.id == run_id,
            DatasetSyncRun.dataset_id == dataset.id,
        )
        .first()
    )
    if previous_run is None:
        raise HTTPException(status_code=404, detail="Dataset sync run not found")

    active_run = _find_active_sync_run(db=db, dataset_id=int(dataset.id))
    if active_run is not None:
        return _to_sync_run_response(active_run, coalesced=True)

    if previous_run.status not in _RETRYABLE_SYNC_RUN_STATUSES:
        raise HTTPException(status_code=409, detail="Dataset sync run is not retryable")

    next_attempt = int(previous_run.attempt or 1) + 1
    run = _enqueue_sync_run(
        db=db,
        dataset=dataset,
        trigger_type="retry",
        attempt=next_attempt,
        input_snapshot=previous_run.input_snapshot if isinstance(previous_run.input_snapshot, dict) else {},
    )
    db.commit()
    db.refresh(run)
    return _to_sync_run_response(run, coalesced=False)


@router.get("/{dataset_id}/sync-schedule", response_model=DatasetSyncScheduleResponse)
async def get_dataset_sync_schedule(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if dataset.sync_schedule is None:
        raise HTTPException(status_code=404, detail="Dataset sync schedule not found")
    return DatasetSyncScheduleResponse.model_validate(dataset.sync_schedule)


@router.put("/{dataset_id}/sync-schedule", response_model=DatasetSyncScheduleResponse)
async def upsert_dataset_sync_schedule(
    dataset_id: int,
    request: DatasetSyncScheduleUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    _ensure_dataset_import_mode(dataset)

    schedule = dataset.sync_schedule
    if schedule is None:
        schedule = DatasetSyncSchedule(
            dataset_id=int(dataset.id),
            enabled=request.enabled,
            schedule_kind=request.schedule_kind,
            cron_expr=request.cron_expr,
            interval_minutes=request.interval_minutes,
            timezone=request.timezone,
            misfire_policy=request.misfire_policy,
            updated_by_id=int(current_user.id),
        )
        db.add(schedule)
        db.flush()

    schedule.enabled = request.enabled
    schedule.schedule_kind = request.schedule_kind
    schedule.cron_expr = request.cron_expr
    schedule.interval_minutes = request.interval_minutes
    schedule.timezone = request.timezone
    schedule.misfire_policy = request.misfire_policy
    schedule.updated_by_id = int(current_user.id)
    if request.enabled:
        schedule.next_run_at = DatasetSyncSchedulerService.compute_next_run_at(
            schedule_kind=request.schedule_kind,
            interval_minutes=request.interval_minutes,
            cron_expr=request.cron_expr,
            base_time=datetime.utcnow(),
            timezone_name=request.timezone,
        )
    else:
        schedule.next_run_at = None

    db.commit()
    db.refresh(schedule)
    return DatasetSyncScheduleResponse.model_validate(schedule)


@router.delete("/{dataset_id}/sync-schedule", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset_sync_schedule(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    if dataset.sync_schedule is not None:
        db.delete(dataset.sync_schedule)
        db.commit()


@router.post("/datasources/{datasource_id}/import-enable", response_model=DatasetBulkImportEnableResponse)
async def bulk_enable_imported_mode(
    datasource_id: int,
    request: DatasetBulkImportEnableRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    datasource = _resolve_dataset_datasource(db=db, datasource_id=datasource_id)
    if not current_user.is_admin and int(datasource.created_by_id) != int(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission for this datasource")
    if not _datasource_allows_import(datasource):
        raise HTTPException(status_code=400, detail="Datasource copy_policy forbids imported mode")

    dataset_ids = sorted(set(request.dataset_ids or []))
    query = db.query(Dataset).filter(Dataset.datasource_id == datasource_id, Dataset.is_active == True)  # noqa: E712
    if dataset_ids:
        query = query.filter(Dataset.id.in_(dataset_ids))
    rows = query.all()
    found_ids = {int(item.id) for item in rows}

    skipped_items: list[DatasetBulkImportEnableSkipItem] = []
    for missing_id in [item for item in dataset_ids if item not in found_ids]:
        skipped_items.append(
            DatasetBulkImportEnableSkipItem(
                dataset_id=int(missing_id),
                reason="dataset_not_found_or_not_in_datasource",
            )
        )

    updated_count = 0
    run_enqueued_count = 0
    for dataset in rows:
        changed = False
        if dataset.access_mode != "imported":
            dataset.access_mode = "imported"
            changed = True

        published_binding = has_published_import_binding(dataset)
        if not published_binding and dataset.data_status not in {"initializing", "syncing"}:
            dataset.data_status = "initializing"
            changed = True

        if dataset.import_config is None:
            config = DatasetImportConfig(
                dataset_id=int(dataset.id),
                refresh_mode="full_refresh",
                drift_policy="block_on_breaking",
                enabled=True,
                state_hash=None,
                created_by_id=int(current_user.id),
                updated_by_id=int(current_user.id),
            )
            db.add(config)
            changed = True

        if request.enqueue_initial_sync and not published_binding:
            active_run = (
                db.query(DatasetSyncRun)
                .filter(
                    DatasetSyncRun.dataset_id == dataset.id,
                    DatasetSyncRun.status.in_(["queued", "running"]),
                )
                .first()
            )
            if active_run is None:
                run = DatasetSyncRun(
                    dataset_id=int(dataset.id),
                    trigger_type="initial",
                    status="queued",
                    attempt=1,
                    queued_at=datetime.utcnow(),
                    input_snapshot={},
                    stats={},
                )
                db.add(run)
                db.flush()
                dataset.last_sync_run_id = int(run.id)
                changed = True
                run_enqueued_count += 1

        if changed:
            updated_count += 1

    db.commit()
    return DatasetBulkImportEnableResponse(
        targeted_count=len(rows),
        updated_count=updated_count,
        skipped_count=len(skipped_items),
        run_enqueued_count=run_enqueued_count,
        skipped_items=skipped_items,
    )


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_admin_user),
):
    """Delete a dataset and its dashboards. Admin only."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )
    requires_import_cleanup = (
        str(getattr(dataset, "access_mode", "direct") or "direct").strip().lower() == "imported"
        or dataset.execution_datasource_id is not None
        or dataset.execution_view_id is not None
    )
    if requires_import_cleanup:
        # Break FK from datasets.execution_view_id -> views.id before physical cleanup
        # removes internal view metadata rows.
        dataset.execution_view_id = None
        db.flush()
        cleanup_imported_dataset_assets(db=db, dataset=dataset)
    db.delete(dataset)
    db.commit()


@router.get("/{dataset_id}/sharing", response_model=DatasetSharingResponse)
async def get_dataset_sharing(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


@router.post("/{dataset_id}/sharing/email", response_model=DatasetSharingResponse)
async def upsert_dataset_email_share(
    dataset_id: int,
    request: DatasetShareUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)

    normalized_email = normalize_email(request.email)
    if normalized_email == normalize_email(current_user.email):
        raise HTTPException(status_code=400, detail="Owner already has dataset access")

    invitee = (
        db.query(User)
        .filter(
            func.lower(User.email) == normalized_email,
            User.deleted_at.is_(None),
            User.is_active.is_(True),
        )
        .first()
    )
    if invitee is None:
        raise HTTPException(status_code=400, detail="Email must belong to an active user")

    share = find_dataset_email_share(
        db=db,
        dataset_id=dataset.id,
        normalized_email=normalized_email,
    )
    if share:
        share.updated_at = datetime.utcnow()
    else:
        share = DatasetEmailShare(
            dataset_id=dataset.id,
            email=normalized_email,
            created_by_id=current_user.id,
        )
        db.add(share)

    db.commit()
    db.refresh(dataset)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


@router.delete("/{dataset_id}/sharing/email/{share_id}", response_model=DatasetSharingResponse)
async def delete_dataset_email_share(
    dataset_id: int,
    share_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset = load_dataset_with_access_relations(db=db, dataset_id=dataset_id)
    ensure_dataset_manage_access(dataset=dataset, user=current_user)

    share = (
        db.query(DatasetEmailShare)
        .filter(
            DatasetEmailShare.id == share_id,
            DatasetEmailShare.dataset_id == dataset.id,
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    db.delete(share)
    db.commit()
    db.refresh(dataset)
    shares = sorted(dataset.email_shares, key=lambda item: (item.email, item.id))
    return DatasetSharingResponse(
        dataset_id=dataset.id,
        shares=[DatasetEmailShareResponse.model_validate(item) for item in shares],
    )


