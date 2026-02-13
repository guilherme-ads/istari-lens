"""Add dashboards.native_filters

Revision ID: 006_dashboard_native_filters
Revises: 005_widget_execution_telemetry
Create Date: 2026-02-11 19:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "006_dashboard_native_filters"
down_revision = "005_widget_execution_telemetry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("native_filters", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")),
    )
    op.alter_column("dashboards", "native_filters", server_default=None)


def downgrade() -> None:
    op.drop_column("dashboards", "native_filters")

