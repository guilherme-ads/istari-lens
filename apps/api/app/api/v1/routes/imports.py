from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.modules.auth.adapters.api.dependencies import get_current_user
from app.modules.core.legacy.models import DataSource, SpreadsheetImport, User, View, ViewColumn
from app.modules.imports.services import (
    build_resource_id,
    build_table_name,
    create_import_table_and_load_rows,
    detect_file_format,
    infer_filename_from_file_uri,
    load_file_from_uri,
    normalize_column_name,
    parse_spreadsheet,
    store_uploaded_file,
)
from app.modules.security.adapters.fernet_encryptor import credential_encryptor
from app.shared.infrastructure.database import get_db
from app.shared.infrastructure.settings import get_settings

router = APIRouter(prefix="/imports", tags=["imports"])
settings = get_settings()


class ImportCreateRequest(BaseModel):
    tenant_id: int
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    header_row: int = Field(default=1, ge=1, le=100)
    sheet_name: str | None = Field(default=None, max_length=255)
    cell_range: str | None = Field(default=None, max_length=64)
    delimiter: str | None = Field(default=",", max_length=8)


class ImportColumnSchema(BaseModel):
    source_name: str = Field(min_length=1, max_length=255)
    target_name: str = Field(min_length=1, max_length=255)
    type: str = Field(pattern="^(string|number|date|bool)$")


class ImportSchemaUpdateRequest(BaseModel):
    columns: list[ImportColumnSchema] = Field(default_factory=list)


class ImportTransformUpdateRequest(BaseModel):
    header_row: int = Field(default=1, ge=1, le=100)
    sheet_name: str | None = Field(default=None, max_length=255)
    cell_range: str | None = Field(default=None, max_length=64)
    delimiter: str | None = Field(default=",", max_length=8)


class ImportResponse(BaseModel):
    id: int
    datasource_id: int
    tenant_id: int
    created_by_id: int
    status: str
    display_name: str
    timezone: str
    header_row: int
    sheet_name: str | None = None
    cell_range: str | None = None
    csv_delimiter: str | None = None
    file_uri: str | None = None
    file_hash: str | None = None
    file_size_bytes: int | None = None
    file_format: str | None = None
    inferred_schema: list[dict[str, Any]] = Field(default_factory=list)
    mapped_schema: list[dict[str, Any]] = Field(default_factory=list)
    preview_rows: list[dict[str, Any]] = Field(default_factory=list)
    available_sheet_names: list[str] = Field(default_factory=list)
    selected_sheet_name: str | None = None
    row_count: int = 0
    table_name: str | None = None
    resource_id: str | None = None
    dataset_id: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    confirmed_at: datetime | None = None
    error_samples: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ImportConfirmedTableResponse(BaseModel):
    table_id: int
    table_name: str
    resource_id: str
    row_count: int
    sheet_name: str | None = None


class ImportConfirmResponse(BaseModel):
    import_id: int
    datasource_id: int
    row_count: int
    tables: list[ImportConfirmedTableResponse] = Field(default_factory=list)
    error_samples: list[dict[str, Any]] = Field(default_factory=list)
    status: str


def _ensure_import_access(spreadsheet_import: SpreadsheetImport, current_user: User) -> None:
    if current_user.is_admin:
        return
    if spreadsheet_import.created_by_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not authorized to access this import")


def _require_analytics_db_url() -> str:
    analytics_db_url = settings.analytics_db_url or settings.app_db_url
    if not analytics_db_url:
        raise HTTPException(status_code=500, detail="Analytics database URL is not configured")
    return analytics_db_url


def _sanitize_mapped_schema(columns: list[ImportColumnSchema], inferred_schema: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not columns:
        return []
    inferred_names = {str(item.get("source_name")) for item in inferred_schema}
    mapped: list[dict[str, Any]] = []
    target_names: set[str] = set()
    for item in columns:
        if item.source_name not in inferred_names:
            raise HTTPException(status_code=400, detail=f"Unknown source column '{item.source_name}'")
        target_name = normalize_column_name(item.target_name, fallback_index=len(mapped) + 1)
        if target_name in target_names:
            raise HTTPException(status_code=400, detail=f"Duplicated target column '{target_name}'")
        target_names.add(target_name)
        mapped.append(
            {
                "source_name": item.source_name,
                "target_name": target_name,
                "type": item.type,
            }
        )
    return mapped


def _default_mapped_schema(inferred_schema: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "source_name": str(item.get("source_name", "")),
            "target_name": str(item.get("target_name") or item.get("source_name") or ""),
            "type": str(item.get("type") or "string"),
        }
        for item in inferred_schema
        if item.get("source_name")
    ]


def _build_import_response(
    spreadsheet_import: SpreadsheetImport,
    *,
    available_sheet_names: list[str] | None = None,
    selected_sheet_name: str | None = None,
) -> ImportResponse:
    return ImportResponse.model_validate(
        spreadsheet_import,
        from_attributes=True,
    ).model_copy(
        update={
            "available_sheet_names": available_sheet_names or [],
            "selected_sheet_name": selected_sheet_name,
        }
    )


@router.post("/create", response_model=ImportResponse)
async def create_import(
    request: ImportCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    analytics_db_url = _require_analytics_db_url()
    datasource = DataSource(
        name=f"{request.name} (Spreadsheet)",
        description=(request.description or f"Spreadsheet import datasource for {request.name}"),
        database_url=credential_encryptor.encrypt(analytics_db_url),
        source_type="file_spreadsheet_import",
        tenant_id=request.tenant_id,
        status="draft",
        is_active=True,
        created_by_id=current_user.id,
    )
    db.add(datasource)
    db.flush()

    spreadsheet_import = SpreadsheetImport(
        datasource_id=datasource.id,
        tenant_id=request.tenant_id,
        created_by_id=current_user.id,
        status="created",
        display_name=request.name,
        timezone=request.timezone,
        header_row=request.header_row,
        sheet_name=request.sheet_name,
        cell_range=request.cell_range,
        csv_delimiter=request.delimiter,
    )
    db.add(spreadsheet_import)
    db.commit()
    db.refresh(spreadsheet_import)
    return _build_import_response(spreadsheet_import)


@router.get("/{import_id}", response_model=ImportResponse)
async def get_import(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)
    available_sheet_names: list[str] = []
    selected_sheet_name: str | None = None
    if spreadsheet_import.file_uri and spreadsheet_import.file_format == "xlsx":
        try:
            raw = load_file_from_uri(file_uri=spreadsheet_import.file_uri, settings=settings)
            parsed = parse_spreadsheet(
                raw=raw,
                file_format=spreadsheet_import.file_format,
                header_row=spreadsheet_import.header_row,
                sheet_name=spreadsheet_import.sheet_name,
                cell_range=spreadsheet_import.cell_range,
                delimiter=spreadsheet_import.csv_delimiter,
                max_rows=settings.import_max_rows,
                max_columns=settings.import_max_columns,
                preview_rows=settings.import_preview_rows,
            )
            available_sheet_names = parsed.sheet_names
            selected_sheet_name = parsed.selected_sheet_name
        except Exception:
            available_sheet_names = []
            selected_sheet_name = None
    return _build_import_response(
        spreadsheet_import,
        available_sheet_names=available_sheet_names,
        selected_sheet_name=selected_sheet_name,
    )


@router.post("/{import_id}/upload", response_model=ImportResponse)
async def upload_import_file(
    import_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        file_format = detect_file_format(file.filename or "")
        stored = store_uploaded_file(
            settings=settings,
            import_id=spreadsheet_import.id,
            filename=file.filename or f"import_{spreadsheet_import.id}.{file_format}",
            raw=raw,
        )
        parsed = parse_spreadsheet(
            raw=raw,
            file_format=file_format,
            header_row=spreadsheet_import.header_row,
            sheet_name=spreadsheet_import.sheet_name,
            cell_range=spreadsheet_import.cell_range,
            delimiter=spreadsheet_import.csv_delimiter,
            max_rows=settings.import_max_rows,
            max_columns=settings.import_max_columns,
            preview_rows=settings.import_preview_rows,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    spreadsheet_import.file_uri = stored.file_uri
    spreadsheet_import.file_hash = stored.file_hash
    spreadsheet_import.file_size_bytes = stored.size_bytes
    spreadsheet_import.file_format = parsed.file_format
    spreadsheet_import.inferred_schema = jsonable_encoder(parsed.inferred_schema)
    spreadsheet_import.mapped_schema = [
        {
            "source_name": item["source_name"],
            "target_name": item["target_name"],
            "type": item["type"],
        }
        for item in parsed.inferred_schema
    ]
    spreadsheet_import.mapped_schema = jsonable_encoder(spreadsheet_import.mapped_schema)
    spreadsheet_import.preview_rows = jsonable_encoder(parsed.preview_rows)
    spreadsheet_import.row_count = parsed.row_count
    spreadsheet_import.status = "uploaded"
    spreadsheet_import.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(spreadsheet_import)
    return _build_import_response(
        spreadsheet_import,
        available_sheet_names=parsed.sheet_names,
        selected_sheet_name=parsed.selected_sheet_name,
    )


@router.patch("/{import_id}/transform", response_model=ImportResponse)
async def update_import_transform(
    import_id: int,
    request: ImportTransformUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)
    if not spreadsheet_import.file_uri or not spreadsheet_import.file_format:
        raise HTTPException(status_code=400, detail="Upload a file before configuring transformation")

    spreadsheet_import.header_row = request.header_row
    spreadsheet_import.sheet_name = request.sheet_name
    spreadsheet_import.cell_range = request.cell_range
    spreadsheet_import.csv_delimiter = request.delimiter

    try:
        raw = load_file_from_uri(file_uri=spreadsheet_import.file_uri, settings=settings)
        parsed = parse_spreadsheet(
            raw=raw,
            file_format=spreadsheet_import.file_format,
            header_row=spreadsheet_import.header_row,
            sheet_name=spreadsheet_import.sheet_name,
            cell_range=spreadsheet_import.cell_range,
            delimiter=spreadsheet_import.csv_delimiter,
            max_rows=settings.import_max_rows,
            max_columns=settings.import_max_columns,
            preview_rows=settings.import_preview_rows,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    spreadsheet_import.inferred_schema = jsonable_encoder(parsed.inferred_schema)
    spreadsheet_import.mapped_schema = jsonable_encoder(_default_mapped_schema(parsed.inferred_schema))
    spreadsheet_import.preview_rows = jsonable_encoder(parsed.preview_rows)
    spreadsheet_import.row_count = parsed.row_count
    spreadsheet_import.status = "transformed"
    spreadsheet_import.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(spreadsheet_import)
    return _build_import_response(
        spreadsheet_import,
        available_sheet_names=parsed.sheet_names,
        selected_sheet_name=parsed.selected_sheet_name,
    )


@router.patch("/{import_id}/schema", response_model=ImportResponse)
async def update_import_schema(
    import_id: int,
    request: ImportSchemaUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)
    if not spreadsheet_import.inferred_schema:
        raise HTTPException(status_code=400, detail="Upload a file before editing schema")
    if len(request.columns) > settings.import_max_columns:
        raise HTTPException(status_code=400, detail=f"Maximum number of columns is {settings.import_max_columns}")

    mapped_schema = _sanitize_mapped_schema(request.columns, spreadsheet_import.inferred_schema)
    if not mapped_schema:
        raise HTTPException(status_code=400, detail="Schema mapping cannot be empty")
    spreadsheet_import.mapped_schema = mapped_schema
    spreadsheet_import.status = "mapped"
    spreadsheet_import.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(spreadsheet_import)
    return _build_import_response(spreadsheet_import)


@router.post("/{import_id}/confirm", response_model=ImportConfirmResponse)
async def confirm_import(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)
    if not spreadsheet_import.file_uri or not spreadsheet_import.file_format:
        raise HTTPException(status_code=400, detail="Upload a file before confirmation")

    analytics_db_url = _require_analytics_db_url()

    spreadsheet_import.status = "processing"
    spreadsheet_import.started_at = datetime.utcnow()
    spreadsheet_import.error_samples = []
    db.commit()
    db.refresh(spreadsheet_import)

    try:
        raw = load_file_from_uri(file_uri=spreadsheet_import.file_uri, settings=settings)
        parsed = parse_spreadsheet(
            raw=raw,
            file_format=spreadsheet_import.file_format,
            header_row=spreadsheet_import.header_row,
            sheet_name=spreadsheet_import.sheet_name,
            cell_range=spreadsheet_import.cell_range,
            delimiter=spreadsheet_import.csv_delimiter,
            max_rows=settings.import_max_rows,
            max_columns=settings.import_max_columns,
            preview_rows=settings.import_preview_rows,
        )

        sheet_names: list[str | None]
        if spreadsheet_import.file_format == "xlsx":
            if spreadsheet_import.sheet_name:
                sheet_names = [spreadsheet_import.sheet_name]
            else:
                sheet_names = parsed.sheet_names
        else:
            sheet_names = [None]

        type_map = {"string": "text", "number": "double precision", "date": "timestamp", "bool": "boolean"}
        tables: list[ImportConfirmedTableResponse] = []
        all_error_samples: list[dict[str, Any]] = []
        total_rows = 0

        for index, current_sheet_name in enumerate(sheet_names, start=1):
            current_parsed = parsed
            if spreadsheet_import.file_format == "xlsx" and current_sheet_name != parsed.selected_sheet_name:
                current_parsed = parse_spreadsheet(
                    raw=raw,
                    file_format=spreadsheet_import.file_format,
                    header_row=spreadsheet_import.header_row,
                    sheet_name=current_sheet_name,
                    cell_range=spreadsheet_import.cell_range,
                    delimiter=spreadsheet_import.csv_delimiter,
                    max_rows=settings.import_max_rows,
                    max_columns=settings.import_max_columns,
                    preview_rows=settings.import_preview_rows,
                )

            if spreadsheet_import.file_format == "xlsx" and not spreadsheet_import.sheet_name:
                mapped_schema = _default_mapped_schema(current_parsed.inferred_schema)
            else:
                mapped_schema = spreadsheet_import.mapped_schema or _default_mapped_schema(current_parsed.inferred_schema)

            table_name = build_table_name(
                spreadsheet_import.id,
                display_name=spreadsheet_import.display_name,
                sheet_name=current_sheet_name,
                sheet_index=index,
            )
            resource_id = build_resource_id(table_name)
            row_count, error_samples = create_import_table_and_load_rows(
                analytics_db_url=analytics_db_url,
                table_name=table_name,
                import_id=spreadsheet_import.id,
                mapped_schema=mapped_schema,
                rows=current_parsed.rows,
                error_sample_limit=settings.import_error_sample_limit,
            )
            total_rows += row_count
            all_error_samples.extend(
                [{**item, "table_name": table_name, "sheet_name": current_sheet_name} for item in error_samples]
            )

            existing_view = (
                db.query(View)
                .filter(
                    View.datasource_id == spreadsheet_import.datasource_id,
                    View.schema_name == "public",
                    View.view_name == table_name,
                )
                .first()
            )
            if existing_view:
                view = existing_view
                db.query(ViewColumn).filter(ViewColumn.view_id == view.id).delete()
            else:
                view = View(
                    datasource_id=spreadsheet_import.datasource_id,
                    schema_name="public",
                    view_name=table_name,
                    description=f"Imported spreadsheet #{spreadsheet_import.id}",
                    is_active=True,
                )
                db.add(view)
                db.flush()

            for item in mapped_schema:
                data_type = type_map.get(str(item["type"]), "text")
                is_numeric = data_type in {"double precision"}
                is_temporal = data_type == "timestamp"
                table_column = ViewColumn(
                    view_id=view.id,
                    column_name=str(item["target_name"]),
                    column_type=data_type,
                    is_aggregatable=is_numeric,
                    is_filterable=True,
                    is_groupable=not is_numeric or is_temporal,
                )
                db.add(table_column)

            tables.append(
                ImportConfirmedTableResponse(
                    table_id=view.id,
                    table_name=table_name,
                    resource_id=resource_id,
                    row_count=row_count,
                    sheet_name=current_sheet_name,
                )
            )

        datasource = db.query(DataSource).filter(DataSource.id == spreadsheet_import.datasource_id).first()
        if datasource:
            datasource.status = "active"
            datasource.is_active = True

        spreadsheet_import.table_name = tables[0].table_name if len(tables) == 1 else None
        spreadsheet_import.resource_id = tables[0].resource_id if len(tables) == 1 else None
        spreadsheet_import.dataset_id = None
        spreadsheet_import.row_count = total_rows
        spreadsheet_import.error_samples = all_error_samples
        spreadsheet_import.status = "completed"
        spreadsheet_import.finished_at = datetime.utcnow()
        spreadsheet_import.confirmed_at = datetime.utcnow()
        spreadsheet_import.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(spreadsheet_import)
        return ImportConfirmResponse(
            import_id=spreadsheet_import.id,
            datasource_id=spreadsheet_import.datasource_id,
            row_count=total_rows,
            tables=tables,
            error_samples=all_error_samples,
            status=spreadsheet_import.status,
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
        if spreadsheet_import:
            spreadsheet_import.status = "failed"
            spreadsheet_import.finished_at = datetime.utcnow()
            spreadsheet_import.updated_at = datetime.utcnow()
            spreadsheet_import.error_samples = [{"error": str(exc)}]
            db.commit()
        raise HTTPException(status_code=500, detail=f"Import confirmation failed: {str(exc)}") from exc


@router.get("/{import_id}/download")
async def download_import_file(
    import_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    spreadsheet_import = db.query(SpreadsheetImport).filter(SpreadsheetImport.id == import_id).first()
    if not spreadsheet_import:
        raise HTTPException(status_code=404, detail="Import not found")
    _ensure_import_access(spreadsheet_import, current_user)
    if not spreadsheet_import.file_uri:
        raise HTTPException(status_code=400, detail="Import has no uploaded file")

    try:
        raw = load_file_from_uri(file_uri=spreadsheet_import.file_uri, settings=settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to download import file: {str(exc)}") from exc

    filename = infer_filename_from_file_uri(
        spreadsheet_import.file_uri,
        fallback=f"import_{spreadsheet_import.id}.{spreadsheet_import.file_format or 'bin'}",
    )
    media_type = "application/octet-stream"
    if filename.lower().endswith(".csv"):
        media_type = "text/csv"
    elif filename.lower().endswith(".xlsx"):
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    return Response(
        content=raw,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
