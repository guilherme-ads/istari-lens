"""Add spreadsheet imports metadata and datasource type fields

Revision ID: 009
Revises: 008
Create Date: 2026-02-18 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "009"
down_revision = "008"
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

    if not _has_column(inspector, "datasources", "source_type"):
        op.add_column(
            "datasources",
            sa.Column("source_type", sa.String(length=64), nullable=False, server_default="postgres_external"),
        )
        inspector = sa.inspect(bind)

    if not _has_column(inspector, "datasources", "tenant_id"):
        op.add_column(
            "datasources",
            sa.Column("tenant_id", sa.Integer(), nullable=True),
        )
        inspector = sa.inspect(bind)

    if not _has_column(inspector, "datasources", "status"):
        op.add_column(
            "datasources",
            sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "datasources", "ix_datasources_source_type"):
        op.create_index("ix_datasources_source_type", "datasources", ["source_type"], unique=False)
    if not _has_index(inspector, "datasources", "ix_datasources_tenant_id"):
        op.create_index("ix_datasources_tenant_id", "datasources", ["tenant_id"], unique=False)
    if not _has_index(inspector, "datasources", "ix_datasources_status"):
        op.create_index("ix_datasources_status", "datasources", ["status"], unique=False)

    if not _has_table(inspector, "spreadsheet_imports"):
        op.create_table(
            "spreadsheet_imports",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("datasource_id", sa.Integer(), nullable=False),
            sa.Column("tenant_id", sa.Integer(), nullable=False),
            sa.Column("created_by_id", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="created"),
            sa.Column("display_name", sa.String(length=255), nullable=False),
            sa.Column("timezone", sa.String(length=64), nullable=False, server_default="UTC"),
            sa.Column("header_row", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("sheet_name", sa.String(length=255), nullable=True),
            sa.Column("cell_range", sa.String(length=64), nullable=True),
            sa.Column("csv_delimiter", sa.String(length=8), nullable=True),
            sa.Column("file_uri", sa.String(length=1024), nullable=True),
            sa.Column("file_hash", sa.String(length=128), nullable=True),
            sa.Column("file_size_bytes", sa.Integer(), nullable=True),
            sa.Column("file_format", sa.String(length=16), nullable=True),
            sa.Column("inferred_schema", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("mapped_schema", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("preview_rows", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("table_name", sa.String(length=255), nullable=True),
            sa.Column("resource_id", sa.String(length=512), nullable=True),
            sa.Column("dataset_id", sa.Integer(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("confirmed_at", sa.DateTime(), nullable=True),
            sa.Column("error_samples", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["datasource_id"], ["datasources.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        inspector = sa.inspect(bind)

    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_id"):
        op.create_index("ix_spreadsheet_imports_id", "spreadsheet_imports", ["id"], unique=False)
    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_datasource_id"):
        op.create_index("ix_spreadsheet_imports_datasource_id", "spreadsheet_imports", ["datasource_id"], unique=False)
    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_tenant_id"):
        op.create_index("ix_spreadsheet_imports_tenant_id", "spreadsheet_imports", ["tenant_id"], unique=False)
    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_created_by_id"):
        op.create_index("ix_spreadsheet_imports_created_by_id", "spreadsheet_imports", ["created_by_id"], unique=False)
    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_status"):
        op.create_index("ix_spreadsheet_imports_status", "spreadsheet_imports", ["status"], unique=False)
    if not _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_dataset_id"):
        op.create_index("ix_spreadsheet_imports_dataset_id", "spreadsheet_imports", ["dataset_id"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "spreadsheet_imports"):
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_dataset_id"):
            op.drop_index("ix_spreadsheet_imports_dataset_id", table_name="spreadsheet_imports")
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_status"):
            op.drop_index("ix_spreadsheet_imports_status", table_name="spreadsheet_imports")
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_created_by_id"):
            op.drop_index("ix_spreadsheet_imports_created_by_id", table_name="spreadsheet_imports")
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_tenant_id"):
            op.drop_index("ix_spreadsheet_imports_tenant_id", table_name="spreadsheet_imports")
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_datasource_id"):
            op.drop_index("ix_spreadsheet_imports_datasource_id", table_name="spreadsheet_imports")
        if _has_index(inspector, "spreadsheet_imports", "ix_spreadsheet_imports_id"):
            op.drop_index("ix_spreadsheet_imports_id", table_name="spreadsheet_imports")
        op.drop_table("spreadsheet_imports")
        inspector = sa.inspect(bind)

    if _has_index(inspector, "datasources", "ix_datasources_status"):
        op.drop_index("ix_datasources_status", table_name="datasources")
    if _has_index(inspector, "datasources", "ix_datasources_tenant_id"):
        op.drop_index("ix_datasources_tenant_id", table_name="datasources")
    if _has_index(inspector, "datasources", "ix_datasources_source_type"):
        op.drop_index("ix_datasources_source_type", table_name="datasources")

    if _has_column(inspector, "datasources", "status"):
        op.drop_column("datasources", "status")
    if _has_column(inspector, "datasources", "tenant_id"):
        op.drop_column("datasources", "tenant_id")
    if _has_column(inspector, "datasources", "source_type"):
        op.drop_column("datasources", "source_type")
