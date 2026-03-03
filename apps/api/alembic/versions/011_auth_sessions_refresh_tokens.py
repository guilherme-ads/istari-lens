"""Add auth_sessions for refresh token rotation

Revision ID: 011
Revises: 010
Create Date: 2026-03-03 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "auth_sessions"):
        op.create_table(
            "auth_sessions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("token_hash", sa.String(length=128), nullable=False),
            sa.Column("ip_address", sa.String(length=64), nullable=True),
            sa.Column("user_agent", sa.String(length=512), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token_hash"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "auth_sessions", "ix_auth_sessions_user_id"):
        op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"], unique=False)
    if not _has_index(inspector, "auth_sessions", "ix_auth_sessions_token_hash"):
        op.create_index("ix_auth_sessions_token_hash", "auth_sessions", ["token_hash"], unique=False)
    if not _has_index(inspector, "auth_sessions", "ix_auth_sessions_expires_at"):
        op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"], unique=False)
    if not _has_index(inspector, "auth_sessions", "ix_auth_sessions_revoked_at"):
        op.create_index("ix_auth_sessions_revoked_at", "auth_sessions", ["revoked_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "auth_sessions"):
        if _has_index(inspector, "auth_sessions", "ix_auth_sessions_revoked_at"):
            op.drop_index("ix_auth_sessions_revoked_at", table_name="auth_sessions")
        if _has_index(inspector, "auth_sessions", "ix_auth_sessions_expires_at"):
            op.drop_index("ix_auth_sessions_expires_at", table_name="auth_sessions")
        if _has_index(inspector, "auth_sessions", "ix_auth_sessions_token_hash"):
            op.drop_index("ix_auth_sessions_token_hash", table_name="auth_sessions")
        if _has_index(inspector, "auth_sessions", "ix_auth_sessions_user_id"):
            op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
        op.drop_table("auth_sessions")
