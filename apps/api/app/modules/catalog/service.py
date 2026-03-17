from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import Dataset, Dimension, Metric, MetricDimension
from app.modules.datasets import validate_and_resolve_base_query_spec
from app.modules.widgets.domain import normalize_column_type

_TOKEN_PATTERN = re.compile(r"[^a-z0-9]+")
_ID_COLUMN_PATTERN = re.compile(r"(^id_|_id$)")
_METRIC_FORMULA_PATTERN = re.compile(r"^(SUM|COUNT|AVG|MIN|MAX)\((\*|[a-zA-Z_][a-zA-Z0-9_]*)\)$", re.IGNORECASE)
_VALID_IDENTIFIER_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_LOW_CARDINALITY_HINTS = {
    "status",
    "tipo",
    "type",
    "categoria",
    "category",
    "cidade",
    "city",
    "estado",
    "state",
    "pais",
    "country",
    "parceiro",
    "partner",
    "estacao",
    "station",
    "conector",
    "connector",
    "canal",
    "channel",
    "segmento",
    "segment",
}
_TEMPORAL_DERIVATIONS: tuple[tuple[str, str], ...] = (
    ("dia", "Dia"),
    ("semana", "Semana"),
    ("dia_semana", "Dia da semana"),
    ("hora_dia", "Hora do dia"),
    ("mes", "Mes"),
    ("ano", "Ano"),
)


@dataclass(slots=True)
class ColumnProfile:
    name: str
    semantic_type: str
    raw_type: str


@dataclass(slots=True)
class InferredMetric:
    name: str
    description: str
    formula: str
    unit: str | None
    default_grain: str | None
    synonyms: list[str]
    examples: list[str]


@dataclass(slots=True)
class InferredDimension:
    name: str
    description: str
    type: str
    synonyms: list[str]


class SemanticCatalogService:
    def __init__(self, db: Session) -> None:
        self._db = db

    def sync_existing_datasets(self) -> bool:
        changed = False
        datasets = (
            self._db.query(Dataset)
            .filter(Dataset.is_active == True)  # noqa: E712
            .all()
        )
        for dataset in datasets:
            _, _, dataset_changed = self.ensure_dataset_catalog(dataset=dataset)
            changed = changed or dataset_changed
        return changed

    def ensure_dataset_catalog(self, *, dataset: Dataset) -> tuple[list[Metric], list[Dimension], bool]:
        metrics = self.list_metrics(dataset_id=int(dataset.id))
        dimensions = self.list_dimensions(dataset_id=int(dataset.id))
        if metrics and dimensions:
            linked = self._ensure_metric_dimension_links(metrics=metrics, dimensions=dimensions)
            return metrics, dimensions, linked

        inferred_metrics, inferred_dimensions = self.infer_initial_suggestions(dataset=dataset)
        changed = False

        if not dimensions:
            for item in inferred_dimensions:
                self.validate_dimension(item)
                self._db.add(
                    Dimension(
                        dataset_id=dataset.id,
                        name=item.name,
                        description=item.description,
                        type=item.type,
                        synonyms=item.synonyms,
                    )
                )
            self._db.flush()
            dimensions = self.list_dimensions(dataset_id=int(dataset.id))
            changed = changed or bool(dimensions)

        if not metrics:
            for item in inferred_metrics:
                self.validate_metric(item)
                self._db.add(
                    Metric(
                        dataset_id=dataset.id,
                        name=item.name,
                        description=item.description,
                        formula=item.formula,
                        unit=item.unit,
                        default_grain=item.default_grain,
                        synonyms=item.synonyms,
                        examples=item.examples,
                    )
                )
            self._db.flush()
            metrics = self.list_metrics(dataset_id=int(dataset.id))
            changed = changed or bool(metrics)

        linked = self._ensure_metric_dimension_links(metrics=metrics, dimensions=dimensions)
        changed = changed or linked
        return metrics, dimensions, changed

    def list_metrics(self, *, dataset_id: int) -> list[Metric]:
        return (
            self._db.query(Metric)
            .filter(Metric.dataset_id == dataset_id)
            .order_by(Metric.name.asc())
            .all()
        )

    def list_dimensions(self, *, dataset_id: int) -> list[Dimension]:
        return (
            self._db.query(Dimension)
            .filter(Dimension.dataset_id == dataset_id)
            .order_by(Dimension.name.asc())
            .all()
        )

    def infer_initial_suggestions(self, *, dataset: Dataset) -> tuple[list[InferredMetric], list[InferredDimension]]:
        columns = self._resolve_columns(dataset=dataset)
        if not columns:
            return [], []
        dimensions = self._infer_dimensions(dataset=dataset, columns=columns)
        metrics = self._infer_metrics(dataset=dataset, columns=columns)
        return metrics, dimensions

    def validate_metric(self, metric: InferredMetric | Metric) -> None:
        name = (metric.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Metric name cannot be empty")
        formula = (metric.formula or "").strip()
        if not _METRIC_FORMULA_PATTERN.match(formula):
            raise HTTPException(
                status_code=400,
                detail=f"Metric formula is invalid: '{formula}'. Supported functions are SUM, COUNT, AVG, MIN and MAX",
            )

    def validate_dimension(self, dimension: InferredDimension | Dimension) -> None:
        name = (dimension.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Dimension name cannot be empty")
        dim_type = (dimension.type or "").strip().lower()
        if dim_type not in {"categorical", "temporal", "relational"}:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported dimension type '{dimension.type}'. Expected categorical, temporal or relational",
            )

    def _resolve_columns(self, *, dataset: Dataset) -> list[ColumnProfile]:
        seen: set[str] = set()
        columns: list[ColumnProfile] = []

        if isinstance(dataset.base_query_spec, dict):
            try:
                _, semantic_columns = validate_and_resolve_base_query_spec(
                    db=self._db,
                    datasource_id=int(dataset.datasource_id),
                    base_query_spec=dataset.base_query_spec,
                )
                for item in semantic_columns:
                    name = str(item.get("name") or "").strip()
                    if not name or name in seen:
                        continue
                    semantic_type = self._normalize_semantic_type(item.get("type"), item.get("raw_type"))
                    raw_type = str(item.get("raw_type") or semantic_type)
                    columns.append(ColumnProfile(name=name, semantic_type=semantic_type, raw_type=raw_type))
                    seen.add(name)
            except HTTPException:
                pass

        if not columns and dataset.view is not None:
            for column in dataset.view.columns:
                name = (column.column_name or "").strip()
                if not name or name in seen:
                    continue
                raw_type = str(column.column_type or "text")
                columns.append(
                    ColumnProfile(
                        name=name,
                        semantic_type=self._normalize_semantic_type(normalize_column_type(raw_type), raw_type),
                        raw_type=raw_type,
                    )
                )
                seen.add(name)

        if not columns and isinstance(dataset.semantic_columns, list):
            for raw in dataset.semantic_columns:
                if not isinstance(raw, dict):
                    continue
                name = str(raw.get("name") or "").strip()
                if not name or name in seen:
                    continue
                semantic_type = self._normalize_semantic_type(raw.get("type"), raw.get("raw_type"))
                raw_type = str(raw.get("raw_type") or semantic_type)
                columns.append(ColumnProfile(name=name, semantic_type=semantic_type, raw_type=raw_type))
                seen.add(name)
        return columns

    def _infer_metrics(self, *, dataset: Dataset, columns: list[ColumnProfile]) -> list[InferredMetric]:
        inferred: list[InferredMetric] = []
        seen_names: set[str] = set()
        dataset_slug = _slug(dataset.name) or "registros"
        numeric_columns = [column for column in columns if column.semantic_type == "numeric"]

        for column in numeric_columns:
            if _is_relational_identifier(column.name):
                # ID-like numeric columns should not generate SUM/AVG/MIN/MAX by default.
                continue
            identifier = _safe_identifier(column.name)
            if identifier is None:
                continue
            base_name = self._metric_base_name(column.name, dataset_slug=dataset_slug)
            total_name = f"{base_name}_total" if not base_name.endswith("_total") else base_name
            avg_name = f"{base_name}_medio"
            min_name = f"{base_name}_minimo"
            max_name = f"{base_name}_maximo"
            metric_specs = (
                (total_name, f"SUM({identifier})", "Soma total"),
                (avg_name, f"AVG({identifier})", "Media"),
                (min_name, f"MIN({identifier})", "Minimo"),
                (max_name, f"MAX({identifier})", "Maximo"),
            )
            for metric_name, formula, description_prefix in metric_specs:
                normalized_metric_name = _slug(metric_name)
                if not normalized_metric_name or normalized_metric_name in seen_names:
                    continue
                inferred.append(
                    InferredMetric(
                        name=normalized_metric_name,
                        description=f"{description_prefix} de {column.name}",
                        formula=formula,
                        unit=_infer_unit(column.name),
                        default_grain="all",
                        synonyms=_build_synonyms(column.name, prefix=description_prefix.lower()),
                        examples=[f"Qual o {normalized_metric_name}?"],
                    )
                )
                seen_names.add(normalized_metric_name)

        count_target = self._count_target(columns=columns)
        count_formula = f"COUNT({count_target})" if count_target != "*" else "COUNT(*)"
        count_name = _slug(f"numero_{dataset_slug}") or "numero_registros"
        if count_name not in seen_names:
            inferred.append(
                InferredMetric(
                    name=count_name,
                    description=f"Quantidade de registros em {dataset.name}",
                    formula=count_formula,
                    unit="count",
                    default_grain="all",
                    synonyms=_build_synonyms(dataset.name, prefix="quantidade"),
                    examples=[f"Quantos registros existem em {dataset.name}?"],
                )
            )
            seen_names.add(count_name)
        return inferred

    def _infer_dimensions(self, *, dataset: Dataset, columns: list[ColumnProfile]) -> list[InferredDimension]:
        _ = dataset
        inferred: list[InferredDimension] = []
        seen_names: set[str] = set()

        temporal_columns = [column for column in columns if column.semantic_type == "temporal"]
        for column in temporal_columns:
            prefix = "" if len(temporal_columns) == 1 else f"{_slug(column.name)}_"
            for suffix, label in _TEMPORAL_DERIVATIONS:
                name = _slug(f"{prefix}{suffix}")
                if not name or name in seen_names:
                    continue
                inferred.append(
                    InferredDimension(
                        name=name,
                        description=f"{label} derivado de {column.name}",
                        type="temporal",
                        synonyms=_build_synonyms(label),
                    )
                )
                seen_names.add(name)

        for column in columns:
            column_slug = _slug(column.name)
            if not column_slug or column_slug in seen_names:
                continue

            if _is_relational_identifier(column.name):
                inferred.append(
                    InferredDimension(
                        name=column_slug,
                        description=f"Identificador relacional baseado na coluna {column.name}",
                        type="relational",
                        synonyms=_build_synonyms(column.name, prefix="id"),
                    )
                )
                seen_names.add(column_slug)
                continue

            if column.semantic_type in {"text", "boolean"}:
                description = f"Segmentacao por {column.name}"
                if _looks_low_cardinality(column.name, semantic_type=column.semantic_type):
                    description = f"Segmentacao categorica (baixa cardinalidade) por {column.name}"
                inferred.append(
                    InferredDimension(
                        name=column_slug,
                        description=description,
                        type="categorical",
                        synonyms=_build_synonyms(column.name),
                    )
                )
                seen_names.add(column_slug)

        return inferred

    def _count_target(self, *, columns: list[ColumnProfile]) -> str:
        for column in columns:
            if _is_relational_identifier(column.name):
                identifier = _safe_identifier(column.name)
                if identifier:
                    return identifier
        return "*"

    def _metric_base_name(self, column_name: str, *, dataset_slug: str) -> str:
        column_slug = _slug(column_name)
        if column_slug.startswith("total_"):
            column_slug = f"{column_slug[6:]}_total"

        dataset_variants = {dataset_slug, _singularize(dataset_slug)}
        for token in dataset_variants:
            if not token:
                continue
            token_with_sep = f"_{token}"
            if column_slug.endswith(token_with_sep):
                column_slug = column_slug[: -len(token_with_sep)]
            token_with_sep = f"{token}_"
            if column_slug.startswith(token_with_sep):
                column_slug = column_slug[len(token_with_sep) :]
        cleaned = _slug(column_slug)
        return cleaned or "valor"

    def _normalize_semantic_type(self, semantic_type: object, raw_type: object) -> str:
        normalized = (str(semantic_type or "")).strip().lower()
        if normalized == "numeric":
            return "numeric"
        if normalized == "temporal":
            return "temporal"
        if normalized in {"text", "string"}:
            return "text"
        if normalized in {"boolean", "bool"}:
            return "boolean"

        by_raw = normalize_column_type(str(raw_type or ""))
        if by_raw in {"numeric", "temporal", "boolean"}:
            return by_raw
        return "text"

    def _ensure_metric_dimension_links(self, *, metrics: list[Metric], dimensions: list[Dimension]) -> bool:
        if not metrics or not dimensions:
            return False
        metric_ids = {int(item.id) for item in metrics}
        dimension_ids = {int(item.id) for item in dimensions}
        existing_rows = (
            self._db.query(MetricDimension)
            .filter(MetricDimension.metric_id.in_(metric_ids))
            .all()
        )
        existing_pairs = {(int(item.metric_id), int(item.dimension_id)) for item in existing_rows}
        pending: list[MetricDimension] = []
        for metric in metrics:
            for dimension in dimensions:
                key = (int(metric.id), int(dimension.id))
                if key in existing_pairs:
                    continue
                if int(dimension.id) not in dimension_ids:
                    continue
                pending.append(MetricDimension(metric_id=metric.id, dimension_id=dimension.id))
        if not pending:
            return False
        self._db.add_all(pending)
        self._db.flush()
        return True


def _slug(value: str | None) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    normalized = _TOKEN_PATTERN.sub("_", normalized).strip("_")
    normalized = re.sub(r"_+", "_", normalized)
    return normalized


def _singularize(value: str) -> str:
    token = _slug(value)
    if token.endswith("ies") and len(token) > 3:
        return f"{token[:-3]}y"
    if token.endswith("s") and len(token) > 1:
        return token[:-1]
    return token


def _safe_identifier(value: str) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if _VALID_IDENTIFIER_PATTERN.match(raw):
        return raw
    slugged = _slug(raw)
    if not slugged or not _VALID_IDENTIFIER_PATTERN.match(slugged):
        return None
    return slugged


def _is_relational_identifier(name: str) -> bool:
    return bool(_ID_COLUMN_PATTERN.search(_slug(name)))


def _looks_low_cardinality(name: str, *, semantic_type: str) -> bool:
    if semantic_type == "boolean":
        return True
    tokens = set(_slug(name).split("_"))
    if tokens.intersection(_LOW_CARDINALITY_HINTS):
        return True
    return False


def _build_synonyms(value: str, *, prefix: str | None = None) -> list[str]:
    base = _slug(value)
    if not base:
        return []
    result = {base, base.replace("_", " ")}
    if prefix:
        prefix_slug = _slug(prefix)
        if prefix_slug:
            result.add(f"{prefix_slug}_{base}")
            result.add(f"{prefix_slug} {base.replace('_', ' ')}")
    return sorted(item for item in result if item)


def _infer_unit(column_name: str) -> str | None:
    token = _slug(column_name)
    if not token:
        return None
    if "percent" in token or token.endswith("_pct") or token.endswith("_percentual"):
        return "percent"
    if "kwh" in token:
        return "kwh"
    if "valor" in token or "receita" in token or "price" in token:
        return "currency"
    return None
