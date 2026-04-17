from __future__ import annotations

from datetime import datetime

from app.modules.mcp.schemas import MCPDatasetExecutionPlan, MCPToolPlanStep


def build_default_dataset_execution_plan(*, dataset_id: int, user_question: str) -> MCPDatasetExecutionPlan:
    return MCPDatasetExecutionPlan(
        dataset_id=int(dataset_id),
        user_question=user_question.strip(),
        created_at=datetime.utcnow(),
        steps=[
            MCPToolPlanStep(
                step_id="context.semantic",
                tool="lens.get_dataset_semantic_layer",
                category="context",
                goal="Carregar semantica e schema do dataset para reduzir ambiguidade.",
                required=True,
            ),
            MCPToolPlanStep(
                step_id="analysis.profile",
                tool="lens.profile_dataset",
                category="analysis",
                goal="Inspecionar distribuicao e qualidade dos dados para guiar analise.",
                required=False,
            ),
            MCPToolPlanStep(
                step_id="analysis.iteration",
                tool="lens.run_query",
                category="analysis",
                goal="Executar iteracoes analiticas para responder a pergunta do usuario.",
                required=True,
            ),
            MCPToolPlanStep(
                step_id="builder.draft",
                tool="lens.create_dashboard_draft",
                category="builder",
                goal="Criar draft de dashboard quando a resposta exigir artefato persistente.",
                required=False,
            ),
            MCPToolPlanStep(
                step_id="validation.dashboard",
                tool="lens.validate_dashboard_draft",
                category="validation",
                goal="Validar consistencia final antes de aplicar/salvar.",
                required=False,
            ),
        ],
    )
