"""Add owner role flag and dataset sharing table

Revision ID: 017
Revises: 016
Create Date: 2026-03-20 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "017"
down_revision = "016"
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

    if not _has_column(inspector, "users", "is_owner"):
        op.add_column(
            "users",
            sa.Column("is_owner", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
        op.execute("UPDATE users SET is_owner = FALSE WHERE is_owner IS NULL")
        op.alter_column("users", "is_owner", server_default=None)
        inspector = sa.inspect(bind)

    if not _has_table(inspector, "dataset_email_shares"):
        op.create_table(
            "dataset_email_shares",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dataset_id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("created_by_id", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dataset_id", "email", name="dataset_email_share_unique_idx"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_dataset_id"):
        op.create_index(
            "ix_dataset_email_shares_dataset_id",
            "dataset_email_shares",
            ["dataset_id"],
            unique=False,
        )
    if not _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_email"):
        op.create_index(
            "ix_dataset_email_shares_email",
            "dataset_email_shares",
            ["email"],
            unique=False,
        )
    if not _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_created_by_id"):
        op.create_index(
            "ix_dataset_email_shares_created_by_id",
            "dataset_email_shares",
            ["created_by_id"],
            unique=False,
        )
    has_unique_constraint = _has_unique_constraint(inspector, "dataset_email_shares", "dataset_email_share_unique_idx")
    has_unique_index = _has_index(inspector, "dataset_email_shares", "dataset_email_share_unique_idx")
    if (not has_unique_constraint) and (not has_unique_index):
        op.create_unique_constraint(
            "dataset_email_share_unique_idx",
            "dataset_email_shares",
            ["dataset_id", "email"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "dataset_email_shares"):
        if _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_created_by_id"):
            op.drop_index("ix_dataset_email_shares_created_by_id", table_name="dataset_email_shares")
        if _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_email"):
            op.drop_index("ix_dataset_email_shares_email", table_name="dataset_email_shares")
        if _has_index(inspector, "dataset_email_shares", "ix_dataset_email_shares_dataset_id"):
            op.drop_index("ix_dataset_email_shares_dataset_id", table_name="dataset_email_shares")
        op.drop_table("dataset_email_shares")

    if _has_column(inspector, "users", "is_owner"):
        op.drop_column("users", "is_owner")
