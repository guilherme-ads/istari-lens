from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from app.api.v1.routes.queries import execute_preview_query
from app.modules.core.legacy.schemas import QueryPreviewResponse, QuerySpec
from app.modules.mcp.context import (
    dataset_column_types,
    dataset_semantic_columns,
    load_accessible_dataset,
    normalize_semantic_type,
)
from app.modules.mcp.runtime import MCPToolRuntimeContext
from app.modules.mcp.schemas import MCPToolValidationError
from app.modules.mcp.tools.common import fail, ok

VALID_AGG_OPS = {"count", "sum", "avg", "min", "max", "distinct_count"}
VALID_FILTER_OPS = {
    "eq",
    "neq",
    "gt",
    "lt",
    "gte",
    "lte",
    "in",
    "not_in",
    "contains",
    "not_contains",
    "is_null",
    "not_null",
    "between",
}
VALID_SORT_DIR = {"asc", "desc"}


class QueryMetricArgs(BaseModel):
    field: str = Field(min_length=1, max_length=255)
    agg: str = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def validate_agg(self) -> "QueryMetricArgs":
        normalized = str(self.agg).strip().lower()
        if normalized not in VALID_AGG_OPS:
            raise ValueError(f"agg must be one of: {sorted(VALID_AGG_OPS)}")
        self.agg = normalized
        return self


class QueryFilterArgs(BaseModel):
    field: str = Field(min_length=1, max_length=255)
    op: str = Field(min_length=1, max_length=32)
    value: list[Any] | None = None

    @model_validator(mode="after")
    def validate_op(self) -> "QueryFilterArgs":
        normalized = str(self.op).strip().lower()
        if normalized not in VALID_FILTER_OPS:
            raise ValueError(f"op must be one of: {sorted(VALID_FILTER_OPS)}")
        self.op = normalized
        return self


class QuerySortArgs(BaseModel):
    field: str = Field(min_length=1, max_length=255)
    dir: str = Field(default="desc", min_length=3, max_length=4)

    @model_validator(mode="after")
    def validate_dir(self) -> "QuerySortArgs":
        normalized = str(self.dir).strip().lower()
        if normalized not in VALID_SORT_DIR:
            raise ValueError("dir must be 'asc' or 'desc'")
        self.dir = normalized
        return self


class DatasetIdArgs(BaseModel):
    dataset_id: int = Field(gt=0)


class ProfileDatasetArgs(DatasetIdArgs):
    include_row_count: bool = True


class RunQueryArgs(DatasetIdArgs):
    metrics: list[QueryMetricArgs] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[QueryFilterArgs] = Field(default_factory=list)
    sort: list[QuerySortArgs] = Field(default_factory=list)
    limit: int = Field(default=50, ge=1, le=500)
    offset: int = Field(default=0, ge=0, le=5000)

    @model_validator(mode="after")
    def validate_metrics(self) -> "RunQueryArgs":
        if len(self.metrics) < 1:
            raise ValueError("metrics must contain at least one item")
        return self


class ExplainMetricArgs(DatasetIdArgs):
    metric_id: int | None = Field(default=None, gt=0)
    metric_name: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def validate_identifier(self) -> "ExplainMetricArgs":
        has_id = self.metric_id is not None
        has_name = isinstance(self.metric_name, str) and self.metric_name.strip() != ""
        if not has_id and not has_name:
            raise ValueError("Provide metric_id or metric_name")
        return self


class ValidateQueryInputsArgs(DatasetIdArgs):
    metrics: list[QueryMetricArgs] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    filters: list[QueryFilterArgs] = Field(default_factory=list)
    sort: list[QuerySortArgs] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_metrics(self) -> "ValidateQueryInputsArgs":
        if len(self.metrics) < 1:
            raise ValueError("metrics must contain at least one item")
        return self


def _column_name_set(dataset) -> set[str]:
    column_types = dataset_column_types(dataset)
    return set(column_types.keys())


def _validate_query_inputs(
    *,
    dataset,
    metrics: list[QueryMetricArgs],
    dimensions: list[str],
    filters: list[QueryFilterArgs],
    sort: list[QuerySortArgs],
) -> tuple[list[MCPToolValidationError], list[str], dict[str, Any]]:
    known_columns = _column_name_set(dataset)
    errors: list[MCPToolValidationError] = []
    warnings: list[str] = []

    for index, item in enumerate(metrics):
        if item.field not in known_columns:
            errors.append(
                MCPToolValidationError(
                    code="unknown_metric_field",
                    field=f"metrics[{index}].field",
                    message=f"Column '{item.field}' does not exist in dataset schema",
                )
            )

    for index, item in enumerate(dimensions):
        if item not in known_columns:
            errors.append(
                MCPToolValidationError(
                    code="unknown_dimension_field",
                    field=f"dimensions[{index}]",
                    message=f"Column '{item}' does not exist in dataset schema",
                )
            )

    for index, item in enumerate(filters):
        if item.field not in known_columns:
            errors.append(
                MCPToolValidationError(
                    code="unknown_filter_field",
                    field=f"filters[{index}].field",
                    message=f"Column '{item.field}' does not exist in dataset schema",
                )
            )
        if item.op in {"is_null", "not_null"} and item.value is not None:
            warnings.append(f"filters[{index}] op '{item.op}' ignores provided value")
        if item.op in {"in", "not_in", "between"} and (not isinstance(item.value, list) or len(item.value) == 0):
            errors.append(
                MCPToolValidationError(
                    code="invalid_filter_value",
                    field=f"filters[{index}].value",
                    message=f"Operator '{item.op}' requires a non-empty list value",
                )
            )

    for index, item in enumerate(sort):
        if item.field not in known_columns and not item.field.startswith("m"):
            warnings.append(f"sort[{index}] field '{item.field}' is not a known column or metric alias")

    normalized_spec = {
        "datasetId": int(dataset.id),
        "metrics": [{"field": item.field, "agg": item.agg} for item in metrics],
        "dimensions": dimensions,
        "filters": [{"field": item.field, "op": item.op, "value": item.value} for item in filters],
        "sort": [{"field": item.field, "dir": item.dir} for item in sort],
    }
    return errors, warnings, normalized_spec


async def tool_validate_query_inputs(args: ValidateQueryInputsArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    errors, warnings, normalized_spec = _validate_query_inputs(
        dataset=dataset,
        metrics=args.metrics,
        dimensions=args.dimensions,
        filters=args.filters,
        sort=args.sort,
    )
    if errors:
        return fail(
            error="Query input validation failed",
            validation_errors=errors,
            warnings=warnings,
            data={"dataset_id": int(dataset.id), "normalized_spec": normalized_spec},
            suggestions=["Corrija os campos reportados em validation_errors antes de chamar lens.run_query."],
        )
    return ok(
        data={"dataset_id": int(dataset.id), "normalized_spec": normalized_spec},
        warnings=warnings,
        suggestions=["Inputs validados. Proximo passo recomendado: lens.run_query."],
    )


async def tool_run_query(args: RunQueryArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    errors, warnings, normalized_spec = _validate_query_inputs(
        dataset=dataset,
        metrics=args.metrics,
        dimensions=args.dimensions,
        filters=args.filters,
        sort=args.sort,
    )
    if errors:
        return fail(
            error="Query input validation failed",
            validation_errors=errors,
            warnings=warnings,
            data={"normalized_spec": normalized_spec},
            suggestions=["Use lens.validate_query_inputs para validar incrementalmente cada ajuste."],
        )

    query_spec = QuerySpec(
        datasetId=args.dataset_id,
        metrics=normalized_spec["metrics"],
        dimensions=normalized_spec["dimensions"],
        filters=normalized_spec["filters"],
        sort=normalized_spec["sort"],
        limit=args.limit,
        offset=args.offset,
    )
    payload: QueryPreviewResponse = await execute_preview_query(query_spec, runtime.db, runtime.current_user, correlation_id=None)
    return ok(
        data={
            "query_spec": query_spec.model_dump(mode="json"),
            "columns": payload.columns,
            "rows": payload.rows,
            "row_count": payload.row_count,
        },
        warnings=warnings,
        metadata={"limit": args.limit, "offset": args.offset},
        suggestions=["Para perguntas iterativas, ajuste filtros/sort e execute lens.run_query novamente."],
    )


async def tool_preview_query(args: RunQueryArgs, runtime: MCPToolRuntimeContext):
    response = await tool_run_query(args, runtime)
    response.metadata = {
        **(response.metadata or {}),
        "compatibility_tool": True,
    }
    return response


async def tool_profile_dataset(args: ProfileDatasetArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    semantic_columns = dataset_semantic_columns(dataset)
    type_counts: dict[str, int] = {"numeric": 0, "temporal": 0, "text": 0, "boolean": 0}
    for item in semantic_columns:
        item_type = normalize_semantic_type(str(item.get("type") or "text"))
        type_counts[item_type] = int(type_counts.get(item_type, 0)) + 1

    warnings: list[str] = []
    row_count: int | None = None
    if args.include_row_count:
        try:
            fallback_column = semantic_columns[0]["name"] if semantic_columns else "id"
            count_payload = await execute_preview_query(
                QuerySpec(
                    datasetId=int(dataset.id),
                    metrics=[{"field": fallback_column, "agg": "count"}],
                    dimensions=[],
                    filters=[],
                    sort=[],
                    limit=1,
                    offset=0,
                ),
                runtime.db,
                runtime.current_user,
                correlation_id=None,
            )
            if count_payload.rows and isinstance(count_payload.rows[0], dict):
                first = count_payload.rows[0]
                if "m0" in first and isinstance(first.get("m0"), (int, float)):
                    row_count = int(first["m0"])
                else:
                    for value in first.values():
                        if isinstance(value, (int, float)):
                            row_count = int(value)
                            break
        except Exception:
            warnings.append("Nao foi possivel estimar row_count via engine para este dataset.")

    return ok(
        data={
            "dataset_id": int(dataset.id),
            "dataset_name": dataset.name,
            "columns": semantic_columns,
            "column_type_counts": type_counts,
            "metrics_count": len(dataset.metrics or []),
            "dimensions_count": len(dataset.dimensions or []),
            "estimated_row_count": row_count,
        },
        warnings=warnings,
        suggestions=[
            "Use lens.search_metrics_and_dimensions para escolher metricas/dimensoes para a pergunta atual.",
            "Use lens.run_query para validar hipoteses de negocio antes de montar dashboard.",
        ],
    )


async def tool_explain_metric(args: ExplainMetricArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    metric = None
    if args.metric_id is not None:
        metric = next((item for item in (dataset.metrics or []) if int(item.id) == int(args.metric_id)), None)
    if metric is None and args.metric_name:
        target = args.metric_name.strip().lower()
        metric = next((item for item in (dataset.metrics or []) if str(item.name).strip().lower() == target), None)
    if metric is None:
        return fail(
            error="Metric not found in dataset catalog",
            validation_errors=[
                MCPToolValidationError(
                    code="metric_not_found",
                    field="metric_id" if args.metric_id is not None else "metric_name",
                    message="Metric does not exist in this dataset catalog",
                )
            ],
            suggestions=["Use lens.search_metrics_and_dimensions para localizar a metrica correta."],
        )

    explanation = (
        f"A metrica '{metric.name}' usa a formula '{metric.formula}'. "
        "Interprete este resultado como agregado principal para responder perguntas de desempenho."
    )
    return ok(
        data={
            "dataset_id": int(dataset.id),
            "metric": {
                "id": int(metric.id),
                "name": metric.name,
                "description": metric.description,
                "formula": metric.formula,
                "unit": metric.unit,
                "default_grain": metric.default_grain,
                "synonyms": metric.synonyms if isinstance(metric.synonyms, list) else [],
                "examples": metric.examples if isinstance(metric.examples, list) else [],
            },
            "explanation": explanation,
        },
        suggestions=["Use lens.run_query com esta metrica para validar a leitura no periodo/filtro desejado."],
    )


ANALYSIS_TOOL_SPECS = [
    {
        "name": "lens.preview_query",
        "category": "analysis",
        "description": "Tool de compatibilidade para preview de query; na v1 prefira lens.run_query.",
        "input_model": RunQueryArgs,
        "handler": tool_preview_query,
    },
    {
        "name": "lens.profile_dataset",
        "category": "analysis",
        "description": "Gera perfil inicial do dataset para orientar analise iterativa.",
        "input_model": ProfileDatasetArgs,
        "handler": tool_profile_dataset,
    },
    {
        "name": "lens.run_query",
        "category": "analysis",
        "description": "Executa query analitica no dataset e retorna preview tabular.",
        "input_model": RunQueryArgs,
        "handler": tool_run_query,
    },
    {
        "name": "lens.explain_metric",
        "category": "analysis",
        "description": "Explica metrica do catalogo semantico no contexto do dataset.",
        "input_model": ExplainMetricArgs,
        "handler": tool_explain_metric,
    },
    {
        "name": "lens.validate_query_inputs",
        "category": "analysis",
        "description": "Valida inputs de query contra schema/semantica antes da execucao.",
        "input_model": ValidateQueryInputsArgs,
        "handler": tool_validate_query_inputs,
    },
]
