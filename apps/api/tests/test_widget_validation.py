import pytest

from app.modules.widgets.domain.config import WidgetConfig, WidgetConfigValidationError, validate_widget_config_against_columns


COLUMN_TYPES = {
    "id_recarga": "bigint",
    "estacao": "text",
    "data": "timestamp",
    "kwh": "numeric",
    "valor": "numeric",
}


def test_kpi_sum_numeric_column_is_valid() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "sum", "column": "kwh"}],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_kpi_sum_non_numeric_column_fails() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "sum", "column": "estacao"}],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "metrics[0].column" in exc.value.field_errors


def test_line_requires_temporal_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "line",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": [],
            "time": {"column": "estacao", "granularity": "day"},
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "time.column" in exc.value.field_errors


def test_bar_requires_categorical_dimension() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "bar",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": ["kwh"],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "dimensions[0]" in exc.value.field_errors


def test_bar_top_n_must_be_positive() -> None:
    with pytest.raises(ValueError):
        WidgetConfig.model_validate(
            {
                "widget_type": "bar",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": ["estacao"],
                "filters": [],
                "order_by": [{"metric_ref": "m0", "direction": "desc"}],
                "top_n": 0,
            }
        )


def test_bar_allows_temporal_week_dimension_token() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "bar",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": ["__time_week__:data"],
            "filters": [],
            "order_by": [{"column": "__time_week__:data", "direction": "asc"}],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_column_allows_temporal_weekday_dimension_token() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "column",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": ["__time_weekday__:data"],
            "filters": [],
            "order_by": [{"column": "__time_weekday__:data", "direction": "asc"}],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_column_temporal_dimension_requires_temporal_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "column",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": ["__time_month__:estacao"],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "dimensions[0]" in exc.value.field_errors


def test_column_requires_categorical_dimension() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "column",
            "view_name": "public.vw_recargas",
            "metrics": [{"op": "count", "column": "id_recarga"}],
            "dimensions": ["kwh"],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "dimensions[0]" in exc.value.field_errors


def test_donut_top_n_must_be_positive() -> None:
    with pytest.raises(ValueError):
        WidgetConfig.model_validate(
            {
                "widget_type": "donut",
                "view_name": "public.vw_recargas",
                "metrics": [{"op": "count", "column": "id_recarga"}],
                "dimensions": ["estacao"],
                "filters": [],
                "order_by": [{"metric_ref": "m0", "direction": "desc"}],
                "top_n": 0,
            }
        )


def test_dre_requires_rows() -> None:
    with pytest.raises(ValueError):
        WidgetConfig.model_validate(
            {
                "widget_type": "dre",
                "view_name": "public.vw_recargas",
                "metrics": [],
                "dimensions": [],
                "dre_rows": [],
                "filters": [],
                "order_by": [],
            }
        )


def test_dre_metric_requires_numeric_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "dre",
            "view_name": "public.vw_recargas",
            "metrics": [],
            "dimensions": [],
            "dre_rows": [
                {
                    "title": "Faturamento",
                    "row_type": "result",
                    "metrics": [{"op": "sum", "column": "estacao"}],
                }
            ],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "dre_rows[0].metrics[0].column" in exc.value.field_errors


def test_dre_percent_base_row_must_reference_level_1_row() -> None:
    with pytest.raises(ValueError):
        WidgetConfig.model_validate(
            {
                "widget_type": "dre",
                "view_name": "public.vw_recargas",
                "metrics": [],
                "dimensions": [],
                "dre_percent_base_row_index": 1,
                "dre_rows": [
                    {"title": "Faturamento", "row_type": "result", "metrics": [{"op": "sum", "column": "valor"}]},
                    {"title": "Marketing", "row_type": "detail", "metrics": [{"op": "sum", "column": "valor"}]},
                ],
                "filters": [],
                "order_by": [],
            }
        )


def test_dre_percent_base_row_is_valid_for_level_1_row() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "dre",
            "view_name": "public.vw_recargas",
            "metrics": [],
            "dimensions": [],
            "dre_percent_base_row_index": 0,
            "dre_rows": [
                {"title": "Faturamento", "row_type": "result", "metrics": [{"op": "sum", "column": "valor"}]},
                {"title": "(-) Deducoes", "row_type": "deduction", "metrics": [{"op": "sum", "column": "valor"}]},
            ],
            "filters": [],
            "order_by": [],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_table_columns_must_exist() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "table",
            "view_name": "public.vw_recargas",
            "metrics": [],
            "dimensions": [],
            "columns": ["id_recarga", "inexistente"],
            "filters": [],
            "order_by": [],
            "limit": 10,
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "columns[1]" in exc.value.field_errors


def test_text_widget_requires_content() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "text",
            "view_name": "public.vw_recargas",
            "text_style": {"content": " ", "font_size": 18, "align": "left"},
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "text_style.content" in exc.value.field_errors


def test_kpi_composite_metric_is_valid() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "sum",
                "outer_agg": "avg",
                "value_column": "kwh",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_kpi_composite_count_without_value_column_is_valid() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "count",
                "outer_agg": "avg",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)


def test_kpi_composite_non_count_requires_value_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "sum",
                "outer_agg": "avg",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "composite_metric.value_column" in exc.value.field_errors


def test_kpi_composite_requires_temporal_time_column() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "agg_over_time_bucket",
                "inner_agg": "sum",
                "outer_agg": "avg",
                "value_column": "kwh",
                "time_column": "estacao",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    with pytest.raises(WidgetConfigValidationError) as exc:
        validate_widget_config_against_columns(config, COLUMN_TYPES)
    assert "composite_metric.time_column" in exc.value.field_errors


def test_kpi_composite_legacy_agg_field_is_still_supported() -> None:
    config = WidgetConfig.model_validate(
        {
            "widget_type": "kpi",
            "view_name": "public.vw_recargas",
            "composite_metric": {
                "type": "avg_per_time_bucket",
                "agg": "sum",
                "value_column": "kwh",
                "time_column": "data",
                "granularity": "day",
            },
            "metrics": [],
            "dimensions": [],
            "filters": [],
            "order_by": [],
        }
    )
    validate_widget_config_against_columns(config, COLUMN_TYPES)

