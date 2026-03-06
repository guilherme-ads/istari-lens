"""Add is_persistent flag to auth_sessions

Revision ID: 013
Revises: 012
Create Date: 2026-03-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_column(inspector, "auth_sessions", "is_persistent"):
        op.add_column(
            "auth_sessions",
            sa.Column("is_persistent", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
        op.alter_column("auth_sessions", "is_persistent", server_default=None)
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "auth_sessions", "ix_auth_sessions_is_persistent"):
        op.create_index(
            "ix_auth_sessions_is_persistent",
            "auth_sessions",
            ["is_persistent"],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_index(inspector, "auth_sessions", "ix_auth_sessions_is_persistent"):
        op.drop_index("ix_auth_sessions_is_persistent", table_name="auth_sessions")

    inspector = sa.inspect(bind)
    if _has_column(inspector, "auth_sessions", "is_persistent"):
        op.drop_column("auth_sessions", "is_persistent")
