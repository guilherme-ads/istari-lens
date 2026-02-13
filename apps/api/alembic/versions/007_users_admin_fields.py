"""Add user admin-management fields

Revision ID: 007
Revises: 006_dashboard_native_filters
Create Date: 2026-02-11 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "007"
down_revision = "006_dashboard_native_filters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.create_index("ix_users_deleted_at", "users", ["deleted_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_column("users", "deleted_at")
    op.drop_column("users", "last_login_at")
