from __future__ import annotations

from typing import Any

from app.modules.mcp.tool_registry import MCPToolRegistry, tool_registry

OPENAI_TOOL_SUGGESTION_ALLOWLIST_READ_ONLY = [
    "lens.get_dataset_semantic_layer",
    "lens.get_dataset_schema",
    "lens.get_dataset_catalog",
    "lens.search_metrics_and_dimensions",
    "lens.profile_dataset",
    "lens.run_query",
    "lens.explain_metric",
    "lens.validate_query_inputs",
    "lens.suggest_best_visualization",
]


def is_openai_tool_suggestion_allowed(tool_name: str) -> bool:
    return str(tool_name) in OPENAI_TOOL_SUGGESTION_ALLOWLIST_READ_ONLY


def build_openai_tool_spec_from_mcp_tool(*, registry: MCPToolRegistry, tool_name: str) -> dict[str, Any] | None:
    spec = registry.get(tool_name)
    if spec is None:
        return None
    return {
        "type": "function",
        "name": spec.name,
        "description": spec.description,
        "parameters": spec.input_model.model_json_schema(),
    }


def list_openai_compatible_read_tools(*, registry: MCPToolRegistry | None = None) -> list[dict[str, Any]]:
    resolved_registry = registry or tool_registry
    items: list[dict[str, Any]] = []
    for tool_name in OPENAI_TOOL_SUGGESTION_ALLOWLIST_READ_ONLY:
        mapped = build_openai_tool_spec_from_mcp_tool(registry=resolved_registry, tool_name=tool_name)
        if isinstance(mapped, dict):
            items.append(mapped)
    return items
