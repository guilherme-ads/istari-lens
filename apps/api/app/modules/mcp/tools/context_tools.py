from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.modules.mcp.context import (
    dataset_semantic_columns,
    list_accessible_datasets,
    load_accessible_dataset,
    normalize_semantic_type,
)
from app.modules.mcp.runtime import MCPToolRuntimeContext
from app.modules.mcp.tools.common import ok


class ListDatasetsArgs(BaseModel):
    search: str | None = Field(default=None, max_length=255)
    limit: int = Field(default=25, ge=1, le=100)


class DatasetArgs(BaseModel):
    dataset_id: int = Field(gt=0)


class SearchMetricsDimensionsArgs(BaseModel):
    dataset_id: int = Field(gt=0)
    query: str = Field(min_length=1, max_length=255)
    limit: int = Field(default=20, ge=1, le=100)


async def tool_list_datasets(args: ListDatasetsArgs, runtime: MCPToolRuntimeContext):
    datasets = list_accessible_datasets(
        db=runtime.db,
        current_user=runtime.current_user,
        limit=args.limit,
        search=args.search,
    )
    items = []
    for item in datasets:
        semantic = item.semantic_columns if isinstance(item.semantic_columns, list) else []
        items.append(
            {
                "dataset_id": int(item.id),
                "name": item.name,
                "description": item.description,
                "access_mode": item.access_mode,
                "data_status": item.data_status,
                "is_active": bool(item.is_active),
                "datasource_id": int(item.datasource_id),
                "view_id": int(item.view_id) if item.view_id is not None else None,
                "semantic_columns_count": len([raw for raw in semantic if isinstance(raw, dict)]),
                "metrics_count": len(item.metrics or []),
                "dimensions_count": len(item.dimensions or []),
            }
        )
    return ok(
        data={"items": items, "count": len(items)},
        metadata={"compatibility_tool": True},
        suggestions=["Para fluxo de agente v1 orientado a dataset unico, prefira passar dataset_id direto nas demais tools."],
    )


async def tool_get_dataset_semantic_layer(args: DatasetArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    semantic_columns = dataset_semantic_columns(dataset)
    view_columns = []
    if dataset.view is not None:
        view_columns = [
            {
                "name": item.column_name,
                "type": item.column_type,
                "normalized_type": normalize_semantic_type(item.column_type),
                "description": item.description or item.column_name,
            }
            for item in dataset.view.columns
        ]

    metrics = [
        {
            "id": int(item.id),
            "name": item.name,
            "description": item.description,
            "formula": item.formula,
            "unit": item.unit,
            "default_grain": item.default_grain,
            "synonyms": item.synonyms if isinstance(item.synonyms, list) else [],
            "examples": item.examples if isinstance(item.examples, list) else [],
        }
        for item in sorted(dataset.metrics or [], key=lambda metric: str(metric.name).lower())
    ]
    dimensions = [
        {
            "id": int(item.id),
            "name": item.name,
            "description": item.description,
            "type": item.type,
            "synonyms": item.synonyms if isinstance(item.synonyms, list) else [],
        }
        for item in sorted(dataset.dimensions or [], key=lambda dimension: str(dimension.name).lower())
    ]
    return ok(
        data={
            "dataset": {
                "id": int(dataset.id),
                "name": dataset.name,
                "description": dataset.description,
                "access_mode": dataset.access_mode,
                "data_status": dataset.data_status,
                "is_active": bool(dataset.is_active),
                "datasource_id": int(dataset.datasource_id),
                "view_id": int(dataset.view_id) if dataset.view_id is not None else None,
            },
            "semantic_columns": semantic_columns,
            "view_columns": view_columns,
            "metrics": metrics,
            "dimensions": dimensions,
        },
        suggestions=[
            "Use lens.search_metrics_and_dimensions para localizar metricas/dimensoes relevantes para a pergunta.",
            "Use lens.profile_dataset para entender cobertura e qualidade antes de montar visualizacoes.",
        ],
    )


async def tool_get_dataset_catalog(args: DatasetArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    metric_items = [
        {
            "id": int(item.id),
            "name": item.name,
            "description": item.description,
            "formula": item.formula,
            "unit": item.unit,
            "default_grain": item.default_grain,
            "synonyms": item.synonyms if isinstance(item.synonyms, list) else [],
            "examples": item.examples if isinstance(item.examples, list) else [],
        }
        for item in sorted(dataset.metrics or [], key=lambda metric: str(metric.name).lower())
    ]
    dimension_items = [
        {
            "id": int(item.id),
            "name": item.name,
            "description": item.description,
            "type": item.type,
            "synonyms": item.synonyms if isinstance(item.synonyms, list) else [],
        }
        for item in sorted(dataset.dimensions or [], key=lambda dimension: str(dimension.name).lower())
    ]
    return ok(
        data={
            "dataset_id": int(dataset.id),
            "metrics": metric_items,
            "dimensions": dimension_items,
            "counts": {
                "metrics": len(metric_items),
                "dimensions": len(dimension_items),
            },
        },
        suggestions=[
            "Use lens.explain_metric para traduzir formulas tecnicas em explicacao de negocio.",
            "Use lens.search_metrics_and_dimensions para encontrar rapidamente itens do catalogo.",
        ],
    )


async def tool_get_dataset_schema(args: DatasetArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    semantic_columns = dataset_semantic_columns(dataset)
    by_name = {item["name"]: item for item in semantic_columns}
    schema_fields = []
    if dataset.view is not None:
        for item in dataset.view.columns:
            semantic = by_name.get(item.column_name)
            schema_fields.append(
                {
                    "name": item.column_name,
                    "raw_type": item.column_type,
                    "semantic_type": semantic["type"] if semantic else normalize_semantic_type(item.column_type),
                    "description": semantic["description"] if semantic else (item.description or item.column_name),
                    "source": semantic["source"] if semantic else "view",
                }
            )
    else:
        schema_fields = [
            {
                "name": item["name"],
                "raw_type": item.get("raw_type", item["type"]),
                "semantic_type": item["type"],
                "description": item["description"],
                "source": item.get("source", "semantic"),
            }
            for item in semantic_columns
        ]

    return ok(
        data={"dataset_id": int(dataset.id), "fields": schema_fields, "field_count": len(schema_fields)},
        suggestions=["Use lens.validate_query_inputs antes de executar run_query para erros acionaveis."],
    )


def _match_score(*, query_tokens: list[str], values: list[str]) -> int:
    score = 0
    lowered_values = [value.lower() for value in values if value]
    for token in query_tokens:
        for value in lowered_values:
            if token == value:
                score += 5
            elif token in value:
                score += 2
    return score


async def tool_search_metrics_and_dimensions(args: SearchMetricsDimensionsArgs, runtime: MCPToolRuntimeContext):
    dataset = load_accessible_dataset(
        db=runtime.db,
        dataset_id=args.dataset_id,
        current_user=runtime.current_user,
    )
    query_tokens = [token.strip().lower() for token in args.query.split() if token.strip()]
    if not query_tokens:
        return ok(data={"metrics": [], "dimensions": [], "count": 0})

    metric_hits: list[dict[str, Any]] = []
    for item in dataset.metrics or []:
        values = [
            str(item.name or ""),
            str(item.description or ""),
            str(item.formula or ""),
            *[str(value) for value in (item.synonyms if isinstance(item.synonyms, list) else [])],
            *[str(value) for value in (item.examples if isinstance(item.examples, list) else [])],
        ]
        score = _match_score(query_tokens=query_tokens, values=values)
        if score <= 0:
            continue
        metric_hits.append(
            {
                "id": int(item.id),
                "name": item.name,
                "description": item.description,
                "formula": item.formula,
                "score": score,
                "kind": "metric",
            }
        )
    metric_hits = sorted(metric_hits, key=lambda hit: (-int(hit["score"]), str(hit["name"]).lower()))[: args.limit]

    dimension_hits: list[dict[str, Any]] = []
    for item in dataset.dimensions or []:
        values = [
            str(item.name or ""),
            str(item.description or ""),
            str(item.type or ""),
            *[str(value) for value in (item.synonyms if isinstance(item.synonyms, list) else [])],
        ]
        score = _match_score(query_tokens=query_tokens, values=values)
        if score <= 0:
            continue
        dimension_hits.append(
            {
                "id": int(item.id),
                "name": item.name,
                "description": item.description,
                "type": item.type,
                "score": score,
                "kind": "dimension",
            }
        )
    dimension_hits = sorted(dimension_hits, key=lambda hit: (-int(hit["score"]), str(hit["name"]).lower()))[: args.limit]

    return ok(
        data={
            "dataset_id": int(dataset.id),
            "query": args.query,
            "metrics": metric_hits,
            "dimensions": dimension_hits,
            "count": len(metric_hits) + len(dimension_hits),
        },
        suggestions=["Use lens.explain_metric para detalhar metricas encontradas no resultado."],
    )


CONTEXT_TOOL_SPECS = [
    {
        "name": "lens.list_datasets",
        "category": "context",
        "description": "Tool de compatibilidade para listar datasets acessiveis (na v1 o dataset_id ja vem definido).",
        "input_model": ListDatasetsArgs,
        "handler": tool_list_datasets,
    },
    {
        "name": "lens.get_dataset_semantic_layer",
        "category": "context",
        "description": "Retorna camada semantica do dataset com semantic_columns, metricas e dimensoes.",
        "input_model": DatasetArgs,
        "handler": tool_get_dataset_semantic_layer,
    },
    {
        "name": "lens.get_dataset_catalog",
        "category": "context",
        "description": "Retorna catalogo semantico do dataset (metricas e dimensoes).",
        "input_model": DatasetArgs,
        "handler": tool_get_dataset_catalog,
    },
    {
        "name": "lens.get_dataset_schema",
        "category": "context",
        "description": "Retorna schema de colunas do dataset com tipos semanticos normalizados.",
        "input_model": DatasetArgs,
        "handler": tool_get_dataset_schema,
    },
    {
        "name": "lens.search_metrics_and_dimensions",
        "category": "context",
        "description": "Pesquisa metricas e dimensoes no catalogo do dataset por texto livre.",
        "input_model": SearchMetricsDimensionsArgs,
        "handler": tool_search_metrics_and_dimensions,
    },
]
