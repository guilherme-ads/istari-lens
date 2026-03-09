"""Add dashboard public share key

Revision ID: 015
Revises: 014
Create Date: 2026-03-06 00:00:00.000000
"""

from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "dashboards"):
        return

    if not _has_column(inspector, "dashboards", "public_share_key"):
        op.add_column("dashboards", sa.Column("public_share_key", sa.String(length=64), nullable=True))
        inspector = sa.inspect(bind)

    rows = bind.execute(sa.text("SELECT id FROM dashboards WHERE public_share_key IS NULL")).fetchall()
    for row in rows:
        bind.execute(
            sa.text("UPDATE dashboards SET public_share_key = :key WHERE id = :id"),
            {"key": uuid4().hex, "id": row.id},
        )

    inspector = sa.inspect(bind)
    if not _has_index(inspector, "dashboards", "ix_dashboards_public_share_key"):
        op.create_index("ix_dashboards_public_share_key", "dashboards", ["public_share_key"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, "dashboards"):
        return
    if _has_index(inspector, "dashboards", "ix_dashboards_public_share_key"):
        op.drop_index("ix_dashboards_public_share_key", table_name="dashboards")
    inspector = sa.inspect(bind)
    if _has_column(inspector, "dashboards", "public_share_key"):
        op.drop_column("dashboards", "public_share_key")
