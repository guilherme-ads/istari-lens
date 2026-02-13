"""Add dashboards.created_by_id

Revision ID: 004_dashboard_created_by
Revises: 003_widget_config_versioning
Create Date: 2026-02-11 18:10:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "004_dashboard_created_by"
down_revision = "003_widget_config_versioning"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("created_by_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "dashboards_created_by_id_fkey",
        "dashboards",
        "users",
        ["created_by_id"],
        ["id"],
    )
    op.create_index("dashboard_created_by_idx", "dashboards", ["created_by_id"], unique=False)

    op.execute(
        """
        UPDATE dashboards d
        SET created_by_id = ds.created_by_id
        FROM datasets dt
        JOIN datasources ds ON ds.id = dt.datasource_id
        WHERE d.dataset_id = dt.id
          AND d.created_by_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("dashboard_created_by_idx", table_name="dashboards")
    op.drop_constraint("dashboards_created_by_id_fkey", "dashboards", type_="foreignkey")
    op.drop_column("dashboards", "created_by_id")

