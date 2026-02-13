"""Add dashboard widget config version and backfill from layout config

Revision ID: 003_widget_config_versioning
Revises: 002_dashboard_layout_config
Create Date: 2026-02-11 16:05:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "003_widget_config_versioning"
down_revision = "002_dashboard_layout_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboard_widgets",
        sa.Column("config_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.alter_column("dashboard_widgets", "config_version", server_default=None)

    # Legacy adapter: if widgets are stored only in dashboards.layout_config, backfill dashboard_widgets rows.
    op.execute(
        """
        INSERT INTO dashboard_widgets (
          dashboard_id,
          widget_type,
          title,
          position,
          query_config,
          config_version,
          visualization_config,
          created_at,
          updated_at
        )
        SELECT
          d.id AS dashboard_id,
          COALESCE(widget_data->>'type', 'table') AS widget_type,
          widget_data->>'title' AS title,
          COALESCE((widget_data->>'position')::int, 0) AS position,
          CASE
            WHEN widget_data ? 'query_config' THEN widget_data->'query_config'
            ELSE jsonb_build_object(
              'widget_type', COALESCE(widget_data->>'type', 'table'),
              'view_name', '',
              'metrics', COALESCE(widget_data->'metrics', '[]'::jsonb),
              'dimensions', COALESCE(widget_data->'dimensions', '[]'::jsonb),
              'filters', COALESCE(widget_data->'filters', '[]'::jsonb),
              'order_by', COALESCE(widget_data->'sorts', '[]'::jsonb),
              'columns', COALESCE(widget_data->'columns', '[]'::jsonb),
              'limit', COALESCE((widget_data->>'limit')::int, NULL),
              'offset', COALESCE((widget_data->>'offset')::int, NULL)
            )
          END AS query_config,
          1 AS config_version,
          NULL AS visualization_config,
          NOW() AS created_at,
          NOW() AS updated_at
        FROM dashboards d
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.layout_config::jsonb, '[]'::jsonb)) section_data
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section_data->'widgets', '[]'::jsonb)) widget_data
        WHERE NOT EXISTS (
          SELECT 1
          FROM dashboard_widgets dw
          WHERE dw.dashboard_id = d.id
        );
        """
    )


def downgrade() -> None:
    op.drop_column("dashboard_widgets", "config_version")
