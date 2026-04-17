import asyncio
from types import SimpleNamespace

from app.modules.dashboards.application import ai_generation
from app.modules.openai_adapter.errors import OpenAIAdapterSchemaError
from app.modules.openai_adapter.schemas import OpenAITraceMetadata


def _mock_integration() -> SimpleNamespace:
    return SimpleNamespace(
        encrypted_api_key="encrypted-key",
        model="gpt-4o-mini",
    )


def test_ai_generation_uses_valid_widget_config_from_plan(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano com config completo valido.",
            "sections": [
                {
                    "title": "Comercial",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "bar",
                            "title": "Receita por categoria",
                            "width": 1,
                            "height": 0.5,
                            "config": {
                                "widget_type": "bar",
                                "view_name": "__dataset_base",
                                "show_title": True,
                                "visual_padding": "normal",
                                "visual_palette": "default",
                                "size": {"width": 4, "height": 2},
                                "metrics": [{"op": "sum", "column": "amount"}],
                                "dimensions": ["category"],
                                "filters": [],
                                "order_by": [],
                                "top_n": 5,
                            },
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),  # not used thanks to monkeypatch
            dataset_name="sales",
            column_types={"amount": "numeric", "category": "text", "created_at": "timestamp"},
            semantic_columns=[
                {"name": "amount", "type": "numeric", "description": "Receita em BRL"},
                {"name": "category", "type": "text", "description": "Categoria comercial"},
            ],
            prompt="ranking por categoria",
            title="Dashboard Comercial",
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert result["title"] == "Dashboard Comercial"
    assert widget_config["widget_type"] == "bar"
    assert widget_config["metrics"][0]["column"] == "amount"
    assert widget_config["dimensions"] == ["category"]
    assert widget_config["top_n"] == 5
    assert result["planning_steps"] == ["Plano com config completo valido"]
    # explicit width/height in widget plan must override config.size
    assert widget_config["size"]["width"] == 1
    assert widget_config["size"]["height"] == 0.5


def test_ai_generation_preserves_planning_steps_from_plan(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano narrativo.",
            "planning_steps": [
                "Mapear colunas relevantes para KPIs",
                "Montar secao de tendencia temporal",
                "",
            ],
            "sections": [
                {
                    "title": "Visao Geral",
                    "columns": 2,
                    "widgets": [],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="sales",
            column_types={"amount": "numeric", "category": "text"},
            semantic_columns=None,
            prompt="painel executivo",
            title="Painel",
        )
    )

    assert result["planning_steps"] == [
        "Mapear colunas relevantes para KPIs",
        "Montar secao de tendencia temporal",
    ]


def test_ai_generation_falls_back_to_default_config_when_plan_config_is_invalid(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano invalido para forcar fallback.",
            "sections": [
                {
                    "title": "Tendencia",
                    "columns": 4,
                    "widgets": [
                        {
                            "type": "line",
                            "title": "Evolucao",
                            "config": {
                                "widget_type": "line",
                                "view_name": "__dataset_base",
                                "metrics": [],
                                "dimensions": [],
                                "filters": [],
                                "order_by": [],
                                # invalid on purpose: missing required "time" and metrics
                            },
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="sales",
            column_types={"amount": "numeric", "category": "text", "created_at": "timestamp"},
            semantic_columns=None,
            prompt="evolucao mensal",
            title=None,
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert widget_config["widget_type"] == "line"
    assert isinstance(widget_config.get("metrics"), list) and len(widget_config["metrics"]) >= 1
    assert isinstance(widget_config.get("time"), dict)
    assert widget_config["time"]["column"] == "created_at"


def test_extract_plan_from_responses_output_accepts_structured_json_payload() -> None:
    payload = {
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_json",
                        "json": {
                            "explanation": "ok",
                            "sections": [
                                {
                                    "title": "Visao Geral",
                                    "columns": 2,
                                    "widgets": [],
                                }
                            ],
                        },
                    }
                ],
            }
        ]
    }
    parsed = ai_generation._extract_plan_from_responses_output(payload)
    assert isinstance(parsed, dict)
    assert parsed["explanation"] == "ok"
    assert parsed["sections"][0]["columns"] == 2


def test_extract_plan_from_responses_output_accepts_top_level_output_text() -> None:
    payload = {
        "output_text": '{"explanation":"ok","sections":[{"title":"Visao Geral","columns":2,"widgets":[]}]}'
    }
    parsed = ai_generation._extract_plan_from_responses_output(payload)
    assert isinstance(parsed, dict)
    assert parsed["explanation"] == "ok"
    assert parsed["sections"][0]["title"] == "Visao Geral"


def test_ai_generation_logs_audit_issue_for_filter_without_value(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano com filtro incompleto.",
            "sections": [
                {
                    "title": "Visao Geral",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "kpi",
                            "title": "Receita total",
                            "config": {
                                "widget_type": "kpi",
                                "view_name": "__dataset_base",
                                "show_title": True,
                                "size": {"width": 1, "height": 1},
                                "metrics": [{"op": "sum", "column": "amount"}],
                                "dimensions": [],
                                "filters": [{"column": "category", "op": "eq"}],
                                "order_by": [],
                            },
                        }
                    ],
                }
            ],
        }

    warnings: list[str] = []

    def _capture_warning(message, *args, **kwargs):
        rendered = str(message) % args if args else str(message)
        warnings.append(rendered)

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)
    monkeypatch.setattr(ai_generation.logger, "warning", _capture_warning)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="sales",
            column_types={"amount": "numeric", "category": "text"},
            semantic_columns=None,
            prompt="kpi",
            title="Painel",
        )
    )

    assert result["sections"][0]["widgets"][0]["config"]["widget_type"] == "kpi"
    assert any("AI dashboard generation audit issues" in item for item in warnings)


def test_ai_generation_auto_repair_applies_before_fallback(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano com config parcialmente invalido.",
            "sections": [
                {
                    "title": "Ranking",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "bar",
                            "title": "Top cidades",
                            "config": {
                                "widget_type": "bar",
                                "view_name": "__dataset_base",
                                "show_title": True,
                                "size": {"width": 2, "height": 2},
                                "metrics": [{"op": "sum", "column": "amount"}],
                                "dimensions": [],
                                "filters": [{"column": "city", "op": "eq"}],
                                "order_by": [],
                                "top_n": 5,
                            },
                        }
                    ],
                }
            ],
        }

    warnings: list[str] = []

    def _capture_warning(message, *args, **kwargs):
        rendered = str(message) % args if args else str(message)
        warnings.append(rendered)

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)
    monkeypatch.setattr(ai_generation.logger, "warning", _capture_warning)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="clientes",
            column_types={"amount": "numeric", "city": "text"},
            semantic_columns=None,
            prompt="ranking",
            title="Painel",
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert widget_config["widget_type"] == "bar"
    assert len(widget_config["dimensions"]) == 1
    assert widget_config["top_n"] == 5
    assert any("auto-repair aplicado" in item for item in warnings)


def test_ai_generation_auto_repairs_unknown_metric_ref_for_categorical_ordering(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano com order_by de metric_ref invalido.",
            "sections": [
                {
                    "title": "Ranking",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "bar",
                            "title": "Top cidades por gastos",
                            "config": {
                                "widget_type": "bar",
                                "view_name": "__dataset_base",
                                "show_title": True,
                                "size": {"width": 2, "height": 2},
                                "metrics": [{"op": "sum", "column": "amount"}],
                                "dimensions": ["city"],
                                "filters": [],
                                "order_by": [{"metric_ref": "Total Gastos", "direction": "desc"}],
                                "top_n": 5,
                            },
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="clientes",
            column_types={"amount": "numeric", "city": "text"},
            semantic_columns=None,
            prompt="ranking",
            title="Painel",
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert widget_config["widget_type"] == "bar"
    assert len(widget_config["order_by"]) == 1
    assert widget_config["order_by"][0]["metric_ref"] == "m0"
    assert widget_config["order_by"][0]["direction"] == "desc"


def test_ai_generation_clamps_widget_width_to_section_columns(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano com width acima do limite da secao.",
            "sections": [
                {
                    "title": "Resumo",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "bar",
                            "title": "Ranking por cidade",
                            "width": 4,
                            "config": {
                                "widget_type": "bar",
                                "view_name": "__dataset_base",
                                "show_title": True,
                                "size": {"width": 4, "height": 2},
                                "metrics": [{"op": "sum", "column": "amount"}],
                                "dimensions": ["city"],
                                "filters": [],
                                "order_by": [{"metric_ref": "m0", "direction": "desc"}],
                            },
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="clientes",
            column_types={"amount": "numeric", "city": "text"},
            semantic_columns=None,
            prompt="ranking por cidade",
            title="Painel",
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert result["sections"][0]["columns"] == 2
    assert widget_config["size"]["width"] == 2


def test_ai_generation_uses_section_columns_for_default_line_width(monkeypatch) -> None:
    async def _mock_plan(**_kwargs):
        return {
            "explanation": "Plano de tendencia sem width explicito.",
            "sections": [
                {
                    "title": "Tendencia",
                    "columns": 2,
                    "widgets": [
                        {
                            "type": "line",
                            "title": "Evolucao mensal",
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(ai_generation, "_active_openai_integration", lambda _db: _mock_integration())
    monkeypatch.setattr(ai_generation.credential_encryptor, "decrypt", lambda _v: "sk-test")
    monkeypatch.setattr(ai_generation, "_generate_dashboard_plan_with_openai", _mock_plan)

    result = asyncio.run(
        ai_generation.generate_dashboard_with_ai_service(
            db=object(),
            dataset_name="sales",
            column_types={"amount": "numeric", "created_at": "timestamp"},
            semantic_columns=None,
            prompt="evolucao",
            title="Painel",
        )
    )

    widget_config = result["sections"][0]["widgets"][0]["config"]
    assert result["sections"][0]["columns"] == 2
    assert widget_config["widget_type"] == "line"
    assert widget_config["size"]["width"] == 2


def test_dashboard_plan_generation_uses_openai_adapter_structured_path(monkeypatch) -> None:
    class StubAdapter:
        def __init__(self) -> None:
            self.structured_calls = 0

        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            self.structured_calls += 1
            return (
                {
                    "explanation": "Plano estruturado",
                    "planning_steps": ["Passo 1"],
                    "native_filters": [],
                    "sections": [{"title": "Resumo", "columns": 2, "widgets": []}],
                },
                OpenAITraceMetadata(
                    call_id="call-structured",
                    lens_trace_id="trace-structured",
                    task="dashboard_plan_generation",
                    model="gpt-4o-mini",
                    schema_name="dashboard_plan",
                ),
            )

    stub = StubAdapter()
    monkeypatch.setattr(ai_generation, "get_openai_adapter_client", lambda: stub)

    plan = asyncio.run(
        ai_generation._generate_dashboard_plan_with_openai(
            api_key="sk-test",
            model="gpt-4o-mini",
            dataset_name="sales",
            columns=[{"name": "amount", "type": "numeric", "description": "Receita"}],
            prompt="Resumo executivo",
        )
    )

    assert stub.structured_calls == 1
    assert plan["explanation"] == "Plano estruturado"
    assert plan["sections"][0]["title"] == "Resumo"


def test_dashboard_plan_generation_falls_back_to_legacy_when_structured_fails(monkeypatch) -> None:
    class StubAdapter:
        def __init__(self) -> None:
            self.legacy_calls = 0

        async def responses_structured(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            raise OpenAIAdapterSchemaError("schema fail")

        async def responses_request(self, **kwargs):  # noqa: ANN003
            _ = kwargs
            self.legacy_calls += 1
            return (
                {
                    "output_text": (
                        '{"explanation":"Fallback","planning_steps":["Fallback step"],'
                        '"native_filters":[],"sections":[{"title":"Fallback","columns":2,"widgets":[]}]}'
                    )
                },
                OpenAITraceMetadata(
                    call_id="call-legacy",
                    lens_trace_id="trace-legacy",
                    task="dashboard_plan_generation_legacy_fallback",
                    model="gpt-4o-mini",
                ),
            )

        def extract_json_payload(self, payload):  # noqa: ANN001, ANN201
            import json

            return json.loads(payload["output_text"])

    stub = StubAdapter()
    monkeypatch.setattr(ai_generation, "get_openai_adapter_client", lambda: stub)

    plan = asyncio.run(
        ai_generation._generate_dashboard_plan_with_openai(
            api_key="sk-test",
            model="gpt-4o-mini",
            dataset_name="sales",
            columns=[{"name": "amount", "type": "numeric", "description": "Receita"}],
            prompt="Resumo executivo",
        )
    )

    assert stub.legacy_calls == 1
    assert plan["explanation"] == "Fallback"
    assert plan["sections"][0]["title"] == "Fallback"
