"""Add dashboard favorites table

Revision ID: 018
Revises: 017
Create Date: 2026-03-20 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_unique_constraint(inspector: sa.Inspector, table_name: str, constraint_name: str) -> bool:
    return any(item["name"] == constraint_name for item in inspector.get_unique_constraints(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "dashboard_favorites"):
        op.create_table(
            "dashboard_favorites",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dashboard_id"], ["dashboards.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dashboard_id", "user_id", name="dashboard_favorite_unique_idx"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dashboard_favorites", "ix_dashboard_favorites_dashboard_id"):
        op.create_index(
            "ix_dashboard_favorites_dashboard_id",
            "dashboard_favorites",
            ["dashboard_id"],
            unique=False,
        )
    if not _has_index(inspector, "dashboard_favorites", "ix_dashboard_favorites_user_id"):
        op.create_index(
            "ix_dashboard_favorites_user_id",
            "dashboard_favorites",
            ["user_id"],
            unique=False,
        )
    has_unique_constraint = _has_unique_constraint(inspector, "dashboard_favorites", "dashboard_favorite_unique_idx")
    has_unique_index = _has_index(inspector, "dashboard_favorites", "dashboard_favorite_unique_idx")
    if (not has_unique_constraint) and (not has_unique_index):
        op.create_unique_constraint(
            "dashboard_favorite_unique_idx",
            "dashboard_favorites",
            ["dashboard_id", "user_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "dashboard_favorites"):
        if _has_index(inspector, "dashboard_favorites", "ix_dashboard_favorites_user_id"):
            op.drop_index("ix_dashboard_favorites_user_id", table_name="dashboard_favorites")
        if _has_index(inspector, "dashboard_favorites", "ix_dashboard_favorites_dashboard_id"):
            op.drop_index("ix_dashboard_favorites_dashboard_id", table_name="dashboard_favorites")
        op.drop_table("dashboard_favorites")
