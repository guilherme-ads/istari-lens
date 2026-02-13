"""Add dashboard layout config

Revision ID: 002_dashboard_layout_config
Revises: 001
Create Date: 2026-02-11 14:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "002_dashboard_layout_config"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column(
            "layout_config",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.alter_column("dashboards", "layout_config", server_default=None)


def downgrade() -> None:
    op.drop_column("dashboards", "layout_config")
