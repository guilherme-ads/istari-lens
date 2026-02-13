"""Add execution telemetry columns to dashboard_widgets

Revision ID: 005_widget_execution_telemetry
Revises: 004_dashboard_created_by
Create Date: 2026-02-11 18:35:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "005_widget_execution_telemetry"
down_revision = "004_dashboard_created_by"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboard_widgets", sa.Column("last_execution_ms", sa.Integer(), nullable=True))
    op.add_column("dashboard_widgets", sa.Column("last_executed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("dashboard_widgets", "last_executed_at")
    op.drop_column("dashboard_widgets", "last_execution_ms")

