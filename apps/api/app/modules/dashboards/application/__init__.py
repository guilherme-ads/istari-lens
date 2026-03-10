"""Dashboards application layer.

Dashboard orchestration currently lives in app.modules.widgets.application.execution_coordinator.
"""

from app.modules.dashboards.application.ai_generation import generate_dashboard_with_ai_service

__all__ = ["generate_dashboard_with_ai_service"]

