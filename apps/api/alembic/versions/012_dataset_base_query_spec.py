"""Add dataset base_query_spec and semantic_columns

Revision ID: 012
Revises: 011
Create Date: 2026-03-04 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "datasets"):
        return

    if not _has_column(inspector, "datasets", "base_query_spec"):
        op.add_column("datasets", sa.Column("base_query_spec", sa.JSON(), nullable=True))
        inspector = sa.inspect(bind)

    if not _has_column(inspector, "datasets", "semantic_columns"):
        op.add_column("datasets", sa.Column("semantic_columns", sa.JSON(), nullable=True))
        op.execute("UPDATE datasets SET semantic_columns = '[]' WHERE semantic_columns IS NULL")
        op.alter_column("datasets", "semantic_columns", existing_type=sa.JSON(), nullable=False)
        inspector = sa.inspect(bind)

    # Keep legacy compatibility: allow datasets without a single backing view.
    op.alter_column("datasets", "view_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "datasets"):
        return

    if _has_column(inspector, "datasets", "semantic_columns"):
        op.drop_column("datasets", "semantic_columns")
    if _has_column(inspector, "datasets", "base_query_spec"):
        op.drop_column("datasets", "base_query_spec")
