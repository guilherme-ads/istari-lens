"""Add imported dataset execution mode foundation

Revision ID: 019
Revises: 018
Create Date: 2026-03-23 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "019"
down_revision = "018"
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

    if _has_table(inspector, "datasources"):
        if not _has_column(inspector, "datasources", "copy_policy"):
            op.add_column(
                "datasources",
                sa.Column("copy_policy", sa.String(length=16), nullable=False, server_default="allowed"),
            )
            op.execute("UPDATE datasources SET copy_policy = 'allowed' WHERE copy_policy IS NULL")
            op.alter_column("datasources", "copy_policy", server_default=None)
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasources", "default_dataset_access_mode"):
            op.add_column(
                "datasources",
                sa.Column("default_dataset_access_mode", sa.String(length=16), nullable=False, server_default="direct"),
            )
            op.execute(
                "UPDATE datasources SET default_dataset_access_mode = 'direct' WHERE default_dataset_access_mode IS NULL"
            )
            op.alter_column("datasources", "default_dataset_access_mode", server_default=None)
            inspector = sa.inspect(bind)
        if not _has_index(inspector, "datasources", "ix_datasources_copy_policy"):
            op.create_index("ix_datasources_copy_policy", "datasources", ["copy_policy"], unique=False)
        if not _has_index(inspector, "datasources", "ix_datasources_default_dataset_access_mode"):
            op.create_index(
                "ix_datasources_default_dataset_access_mode",
                "datasources",
                ["default_dataset_access_mode"],
                unique=False,
            )

    if _has_table(inspector, "datasets"):
        if not _has_column(inspector, "datasets", "access_mode"):
            op.add_column(
                "datasets",
                sa.Column("access_mode", sa.String(length=16), nullable=False, server_default="direct"),
            )
            op.execute("UPDATE datasets SET access_mode = 'direct' WHERE access_mode IS NULL")
            op.alter_column("datasets", "access_mode", server_default=None)
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasets", "execution_datasource_id"):
            op.add_column(
                "datasets",
                sa.Column("execution_datasource_id", sa.Integer(), sa.ForeignKey("datasources.id"), nullable=True),
            )
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasets", "execution_view_id"):
            op.add_column(
                "datasets",
                sa.Column("execution_view_id", sa.Integer(), sa.ForeignKey("views.id"), nullable=True),
            )
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasets", "data_status"):
            op.add_column(
                "datasets",
                sa.Column("data_status", sa.String(length=32), nullable=False, server_default="ready"),
            )
            op.execute("UPDATE datasets SET data_status = 'ready' WHERE data_status IS NULL")
            op.alter_column("datasets", "data_status", server_default=None)
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasets", "last_successful_sync_at"):
            op.add_column("datasets", sa.Column("last_successful_sync_at", sa.DateTime(), nullable=True))
            inspector = sa.inspect(bind)
        if not _has_column(inspector, "datasets", "last_sync_run_id"):
            op.add_column("datasets", sa.Column("last_sync_run_id", sa.Integer(), nullable=True))
            inspector = sa.inspect(bind)

        if not _has_index(inspector, "datasets", "ix_datasets_access_mode"):
            op.create_index("ix_datasets_access_mode", "datasets", ["access_mode"], unique=False)
        if not _has_index(inspector, "datasets", "ix_datasets_data_status"):
            op.create_index("ix_datasets_data_status", "datasets", ["data_status"], unique=False)
        if not _has_index(inspector, "datasets", "ix_datasets_execution_datasource_id"):
            op.create_index(
                "ix_datasets_execution_datasource_id",
                "datasets",
                ["execution_datasource_id"],
                unique=False,
            )
        if not _has_index(inspector, "datasets", "ix_datasets_execution_view_id"):
            op.create_index("ix_datasets_execution_view_id", "datasets", ["execution_view_id"], unique=False)
        if not _has_index(inspector, "datasets", "ix_datasets_last_sync_run_id"):
            op.create_index("ix_datasets_last_sync_run_id", "datasets", ["last_sync_run_id"], unique=False)

    inspector = sa.inspect(bind)
    if not _has_table(inspector, "dataset_import_configs"):
        op.create_table(
            "dataset_import_configs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dataset_id", sa.Integer(), nullable=False),
            sa.Column("refresh_mode", sa.String(length=32), nullable=False),
            sa.Column("drift_policy", sa.String(length=32), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("max_runtime_seconds", sa.Integer(), nullable=True),
            sa.Column("state_hash", sa.String(length=128), nullable=True),
            sa.Column("created_by_id", sa.Integer(), nullable=True),
            sa.Column("updated_by_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dataset_id", name="dataset_import_configs_dataset_id_key"),
        )
        inspector = sa.inspect(bind)

    if not _has_table(inspector, "dataset_sync_schedules"):
        op.create_table(
            "dataset_sync_schedules",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dataset_id", sa.Integer(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("schedule_kind", sa.String(length=16), nullable=False),
            sa.Column("cron_expr", sa.String(length=128), nullable=True),
            sa.Column("interval_minutes", sa.Integer(), nullable=True),
            sa.Column("timezone", sa.String(length=64), nullable=False),
            sa.Column("next_run_at", sa.DateTime(), nullable=True),
            sa.Column("last_run_at", sa.DateTime(), nullable=True),
            sa.Column("misfire_policy", sa.String(length=16), nullable=False),
            sa.Column("updated_by_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["updated_by_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dataset_id", name="dataset_sync_schedules_dataset_id_key"),
        )
        inspector = sa.inspect(bind)

    if not _has_table(inspector, "dataset_sync_runs"):
        op.create_table(
            "dataset_sync_runs",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dataset_id", sa.Integer(), nullable=False),
            sa.Column("trigger_type", sa.String(length=16), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("queued_at", sa.DateTime(), nullable=False),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("attempt", sa.Integer(), nullable=False),
            sa.Column("worker_id", sa.String(length=128), nullable=True),
            sa.Column("lock_expires_at", sa.DateTime(), nullable=True),
            sa.Column("input_snapshot", sa.JSON(), nullable=False),
            sa.Column("stats", sa.JSON(), nullable=False),
            sa.Column("published_execution_view_id", sa.Integer(), nullable=True),
            sa.Column("drift_summary", sa.JSON(), nullable=True),
            sa.Column("error_code", sa.String(length=64), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("error_details", sa.JSON(), nullable=True),
            sa.Column("correlation_id", sa.String(length=128), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["published_execution_view_id"], ["views.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        inspector = sa.inspect(bind)

    if _has_table(inspector, "dataset_import_configs"):
        if not _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_dataset_id"):
            op.create_index("ix_dataset_import_configs_dataset_id", "dataset_import_configs", ["dataset_id"], unique=True)
        if not _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_created_by_id"):
            op.create_index(
                "ix_dataset_import_configs_created_by_id",
                "dataset_import_configs",
                ["created_by_id"],
                unique=False,
            )
        if not _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_updated_by_id"):
            op.create_index(
                "ix_dataset_import_configs_updated_by_id",
                "dataset_import_configs",
                ["updated_by_id"],
                unique=False,
            )

    if _has_table(inspector, "dataset_sync_schedules"):
        if not _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_dataset_id"):
            op.create_index("ix_dataset_sync_schedules_dataset_id", "dataset_sync_schedules", ["dataset_id"], unique=True)
        if not _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_next_run_at"):
            op.create_index(
                "ix_dataset_sync_schedules_next_run_at",
                "dataset_sync_schedules",
                ["next_run_at"],
                unique=False,
            )
        if not _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_updated_by_id"):
            op.create_index(
                "ix_dataset_sync_schedules_updated_by_id",
                "dataset_sync_schedules",
                ["updated_by_id"],
                unique=False,
            )

    if _has_table(inspector, "dataset_sync_runs"):
        if not _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_dataset_id"):
            op.create_index("ix_dataset_sync_runs_dataset_id", "dataset_sync_runs", ["dataset_id"], unique=False)
        if not _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_status"):
            op.create_index("ix_dataset_sync_runs_status", "dataset_sync_runs", ["status"], unique=False)
        if not _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_queued_at"):
            op.create_index("ix_dataset_sync_runs_queued_at", "dataset_sync_runs", ["queued_at"], unique=False)
        if not _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_lock_expires_at"):
            op.create_index("ix_dataset_sync_runs_lock_expires_at", "dataset_sync_runs", ["lock_expires_at"], unique=False)
        if not _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_correlation_id"):
            op.create_index("ix_dataset_sync_runs_correlation_id", "dataset_sync_runs", ["correlation_id"], unique=False)
        op.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_sync_runs_active_per_dataset
            ON dataset_sync_runs (dataset_id)
            WHERE status IN ('queued', 'running')
            """
        )

    inspector = sa.inspect(bind)
    if _has_table(inspector, "datasets") and _has_table(inspector, "dataset_sync_runs"):
        foreign_keys = inspector.get_foreign_keys("datasets")
        if not any(item.get("name") == "datasets_last_sync_run_id_fkey" for item in foreign_keys):
            op.create_foreign_key(
                "datasets_last_sync_run_id_fkey",
                "datasets",
                "dataset_sync_runs",
                ["last_sync_run_id"],
                ["id"],
                ondelete="SET NULL",
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "datasets"):
        foreign_keys = inspector.get_foreign_keys("datasets")
        if any(item.get("name") == "datasets_last_sync_run_id_fkey" for item in foreign_keys):
            op.drop_constraint("datasets_last_sync_run_id_fkey", "datasets", type_="foreignkey")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dataset_sync_runs"):
        op.execute("DROP INDEX IF EXISTS uq_dataset_sync_runs_active_per_dataset")
        if _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_correlation_id"):
            op.drop_index("ix_dataset_sync_runs_correlation_id", table_name="dataset_sync_runs")
        if _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_lock_expires_at"):
            op.drop_index("ix_dataset_sync_runs_lock_expires_at", table_name="dataset_sync_runs")
        if _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_queued_at"):
            op.drop_index("ix_dataset_sync_runs_queued_at", table_name="dataset_sync_runs")
        if _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_status"):
            op.drop_index("ix_dataset_sync_runs_status", table_name="dataset_sync_runs")
        if _has_index(inspector, "dataset_sync_runs", "ix_dataset_sync_runs_dataset_id"):
            op.drop_index("ix_dataset_sync_runs_dataset_id", table_name="dataset_sync_runs")
        op.drop_table("dataset_sync_runs")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dataset_sync_schedules"):
        if _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_updated_by_id"):
            op.drop_index("ix_dataset_sync_schedules_updated_by_id", table_name="dataset_sync_schedules")
        if _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_next_run_at"):
            op.drop_index("ix_dataset_sync_schedules_next_run_at", table_name="dataset_sync_schedules")
        if _has_index(inspector, "dataset_sync_schedules", "ix_dataset_sync_schedules_dataset_id"):
            op.drop_index("ix_dataset_sync_schedules_dataset_id", table_name="dataset_sync_schedules")
        op.drop_table("dataset_sync_schedules")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "dataset_import_configs"):
        if _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_updated_by_id"):
            op.drop_index("ix_dataset_import_configs_updated_by_id", table_name="dataset_import_configs")
        if _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_created_by_id"):
            op.drop_index("ix_dataset_import_configs_created_by_id", table_name="dataset_import_configs")
        if _has_index(inspector, "dataset_import_configs", "ix_dataset_import_configs_dataset_id"):
            op.drop_index("ix_dataset_import_configs_dataset_id", table_name="dataset_import_configs")
        op.drop_table("dataset_import_configs")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "datasets"):
        if _has_index(inspector, "datasets", "ix_datasets_last_sync_run_id"):
            op.drop_index("ix_datasets_last_sync_run_id", table_name="datasets")
        if _has_index(inspector, "datasets", "ix_datasets_execution_view_id"):
            op.drop_index("ix_datasets_execution_view_id", table_name="datasets")
        if _has_index(inspector, "datasets", "ix_datasets_execution_datasource_id"):
            op.drop_index("ix_datasets_execution_datasource_id", table_name="datasets")
        if _has_index(inspector, "datasets", "ix_datasets_data_status"):
            op.drop_index("ix_datasets_data_status", table_name="datasets")
        if _has_index(inspector, "datasets", "ix_datasets_access_mode"):
            op.drop_index("ix_datasets_access_mode", table_name="datasets")
        if _has_column(inspector, "datasets", "last_sync_run_id"):
            op.drop_column("datasets", "last_sync_run_id")
        if _has_column(inspector, "datasets", "last_successful_sync_at"):
            op.drop_column("datasets", "last_successful_sync_at")
        if _has_column(inspector, "datasets", "data_status"):
            op.drop_column("datasets", "data_status")
        if _has_column(inspector, "datasets", "execution_view_id"):
            op.drop_column("datasets", "execution_view_id")
        if _has_column(inspector, "datasets", "execution_datasource_id"):
            op.drop_column("datasets", "execution_datasource_id")
        if _has_column(inspector, "datasets", "access_mode"):
            op.drop_column("datasets", "access_mode")

    inspector = sa.inspect(bind)
    if _has_table(inspector, "datasources"):
        if _has_index(inspector, "datasources", "ix_datasources_default_dataset_access_mode"):
            op.drop_index("ix_datasources_default_dataset_access_mode", table_name="datasources")
        if _has_index(inspector, "datasources", "ix_datasources_copy_policy"):
            op.drop_index("ix_datasources_copy_policy", table_name="datasources")
        if _has_column(inspector, "datasources", "default_dataset_access_mode"):
            op.drop_column("datasources", "default_dataset_access_mode")
        if _has_column(inspector, "datasources", "copy_policy"):
            op.drop_column("datasources", "copy_policy")
