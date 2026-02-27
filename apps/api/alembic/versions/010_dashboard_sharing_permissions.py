"""Add dashboard sharing visibility and email permissions

Revision ID: 010
Revises: 009
Create Date: 2026-02-27 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(inspector: sa.Inspector, table_name: str, constraint_name: str) -> bool:
    return any(item["name"] == constraint_name for item in inspector.get_unique_constraints(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "dashboards", "visibility"):
        op.add_column(
            "dashboards",
            sa.Column("visibility", sa.String(length=32), nullable=False, server_default="private"),
        )
        op.execute("UPDATE dashboards SET visibility = 'private' WHERE visibility IS NULL")
        op.alter_column("dashboards", "visibility", server_default=None)
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dashboards", "ix_dashboards_visibility"):
        op.create_index("ix_dashboards_visibility", "dashboards", ["visibility"], unique=False)

    if not _has_table(inspector, "dashboard_email_shares"):
        op.create_table(
            "dashboard_email_shares",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("permission", sa.String(length=16), nullable=False, server_default="view"),
            sa.Column("created_by_id", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["dashboard_id"], ["dashboards.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dashboard_id", "email", name="dashboard_email_share_unique_idx"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_dashboard_id"):
        op.create_index(
            "ix_dashboard_email_shares_dashboard_id",
            "dashboard_email_shares",
            ["dashboard_id"],
            unique=False,
        )
    if not _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_email"):
        op.create_index(
            "ix_dashboard_email_shares_email",
            "dashboard_email_shares",
            ["email"],
            unique=False,
        )
    if not _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_created_by_id"):
        op.create_index(
            "ix_dashboard_email_shares_created_by_id",
            "dashboard_email_shares",
            ["created_by_id"],
            unique=False,
        )
    has_unique_constraint = _has_unique_constraint(inspector, "dashboard_email_shares", "dashboard_email_share_unique_idx")
    has_unique_index = _has_index(inspector, "dashboard_email_shares", "dashboard_email_share_unique_idx")
    if (not has_unique_constraint) and (not has_unique_index):
        op.create_unique_constraint(
            "dashboard_email_share_unique_idx",
            "dashboard_email_shares",
            ["dashboard_id", "email"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "dashboard_email_shares"):
        if _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_created_by_id"):
            op.drop_index("ix_dashboard_email_shares_created_by_id", table_name="dashboard_email_shares")
        if _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_email"):
            op.drop_index("ix_dashboard_email_shares_email", table_name="dashboard_email_shares")
        if _has_index(inspector, "dashboard_email_shares", "ix_dashboard_email_shares_dashboard_id"):
            op.drop_index("ix_dashboard_email_shares_dashboard_id", table_name="dashboard_email_shares")
        op.drop_table("dashboard_email_shares")

    if _has_column(inspector, "dashboards", "visibility"):
        if _has_index(inspector, "dashboards", "ix_dashboards_visibility"):
            op.drop_index("ix_dashboards_visibility", table_name="dashboards")
        op.drop_column("dashboards", "visibility")
