"""Add dashboard edit locks and dashboard versions

Revision ID: 014
Revises: 013
Create Date: 2026-03-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "dashboard_versions"):
        op.create_table(
            "dashboard_versions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("version_number", sa.Integer(), nullable=False),
            sa.Column("snapshot", sa.JSON(), nullable=False),
            sa.Column("created_by_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dashboard_id"], ["dashboards.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_dashboard_id"):
        op.create_index("ix_dashboard_versions_dashboard_id", "dashboard_versions", ["dashboard_id"], unique=False)
    if not _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_created_by_id"):
        op.create_index("ix_dashboard_versions_created_by_id", "dashboard_versions", ["created_by_id"], unique=False)
    if not _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_created_at"):
        op.create_index("ix_dashboard_versions_created_at", "dashboard_versions", ["created_at"], unique=False)
    if not _has_index(inspector, "dashboard_versions", "dashboard_versions_dashboard_version_idx"):
        op.create_index(
            "dashboard_versions_dashboard_version_idx",
            "dashboard_versions",
            ["dashboard_id", "version_number"],
            unique=True,
        )

    inspector = sa.inspect(bind)
    if not _has_table(inspector, "dashboard_edit_locks"):
        op.create_table(
            "dashboard_edit_locks",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("acquired_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dashboard_id"], ["dashboards.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dashboard_id"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_dashboard_id"):
        op.create_index("ix_dashboard_edit_locks_dashboard_id", "dashboard_edit_locks", ["dashboard_id"], unique=True)
    if not _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_user_id"):
        op.create_index("ix_dashboard_edit_locks_user_id", "dashboard_edit_locks", ["user_id"], unique=False)
    if not _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_expires_at"):
        op.create_index("ix_dashboard_edit_locks_expires_at", "dashboard_edit_locks", ["expires_at"], unique=False)

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dashboards") and _has_column(inspector, "dashboards", "visibility"):
        op.execute(
            "UPDATE dashboards SET visibility = 'public_view' WHERE visibility = 'public'"
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "dashboard_edit_locks"):
        if _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_expires_at"):
            op.drop_index("ix_dashboard_edit_locks_expires_at", table_name="dashboard_edit_locks")
        if _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_user_id"):
            op.drop_index("ix_dashboard_edit_locks_user_id", table_name="dashboard_edit_locks")
        if _has_index(inspector, "dashboard_edit_locks", "ix_dashboard_edit_locks_dashboard_id"):
            op.drop_index("ix_dashboard_edit_locks_dashboard_id", table_name="dashboard_edit_locks")
        op.drop_table("dashboard_edit_locks")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dashboard_versions"):
        if _has_index(inspector, "dashboard_versions", "dashboard_versions_dashboard_version_idx"):
            op.drop_index("dashboard_versions_dashboard_version_idx", table_name="dashboard_versions")
        if _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_created_at"):
            op.drop_index("ix_dashboard_versions_created_at", table_name="dashboard_versions")
        if _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_created_by_id"):
            op.drop_index("ix_dashboard_versions_created_by_id", table_name="dashboard_versions")
        if _has_index(inspector, "dashboard_versions", "ix_dashboard_versions_dashboard_id"):
            op.drop_index("ix_dashboard_versions_dashboard_id", table_name="dashboard_versions")
        op.drop_table("dashboard_versions")
