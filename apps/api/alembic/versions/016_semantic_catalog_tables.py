"""Add semantic catalog tables

Revision ID: 016
Revises: 015
Create Date: 2026-03-16 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, "metrics"):
        op.create_table(
            "metrics",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("formula", sa.Text(), nullable=False),
            sa.Column("unit", sa.String(length=64), nullable=True),
            sa.Column("default_grain", sa.String(length=64), nullable=True),
            sa.Column("synonyms", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")),
            sa.Column("examples", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        )
        op.execute("CREATE UNIQUE INDEX metrics_dataset_name_idx ON metrics(dataset_id, name)")
        op.execute("CREATE INDEX ix_metrics_dataset_id ON metrics(dataset_id)")
        op.execute("CREATE INDEX ix_metrics_name ON metrics(name)")

    inspector = sa.inspect(bind)
    if not _has_table(inspector, "dimensions"):
        op.create_table(
            "dimensions",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("type", sa.String(length=32), nullable=False, server_default="categorical"),
            sa.Column("synonyms", sa.JSON(), nullable=False, server_default=sa.text("'[]'::json")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        )
        op.execute("CREATE UNIQUE INDEX dimensions_dataset_name_idx ON dimensions(dataset_id, name)")
        op.execute("CREATE INDEX ix_dimensions_dataset_id ON dimensions(dataset_id)")
        op.execute("CREATE INDEX ix_dimensions_name ON dimensions(name)")
        op.execute("CREATE INDEX ix_dimensions_type ON dimensions(type)")

    inspector = sa.inspect(bind)
    if not _has_table(inspector, "metric_dimensions"):
        op.create_table(
            "metric_dimensions",
            sa.Column("metric_id", sa.Integer(), sa.ForeignKey("metrics.id", ondelete="CASCADE"), nullable=False),
            sa.Column("dimension_id", sa.Integer(), sa.ForeignKey("dimensions.id", ondelete="CASCADE"), nullable=False),
            sa.PrimaryKeyConstraint("metric_id", "dimension_id", name="pk_metric_dimensions"),
        )
        op.execute("CREATE INDEX ix_metric_dimensions_dimension_id ON metric_dimensions(dimension_id)")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "metric_dimensions"):
        if _has_index(inspector, "metric_dimensions", "ix_metric_dimensions_dimension_id"):
            op.drop_index("ix_metric_dimensions_dimension_id", table_name="metric_dimensions")
        op.drop_table("metric_dimensions")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dimensions"):
        if _has_index(inspector, "dimensions", "ix_dimensions_type"):
            op.drop_index("ix_dimensions_type", table_name="dimensions")
        if _has_index(inspector, "dimensions", "ix_dimensions_name"):
            op.drop_index("ix_dimensions_name", table_name="dimensions")
        if _has_index(inspector, "dimensions", "ix_dimensions_dataset_id"):
            op.drop_index("ix_dimensions_dataset_id", table_name="dimensions")
        if _has_index(inspector, "dimensions", "dimensions_dataset_name_idx"):
            op.drop_index("dimensions_dataset_name_idx", table_name="dimensions")
        op.drop_table("dimensions")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "metrics"):
        if _has_index(inspector, "metrics", "ix_metrics_name"):
            op.drop_index("ix_metrics_name", table_name="metrics")
        if _has_index(inspector, "metrics", "ix_metrics_dataset_id"):
            op.drop_index("ix_metrics_dataset_id", table_name="metrics")
        if _has_index(inspector, "metrics", "metrics_dataset_name_idx"):
            op.drop_index("metrics_dataset_name_idx", table_name="metrics")
        op.drop_table("metrics")
