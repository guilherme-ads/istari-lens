"""Remove legacy LLM chat storage tables

Revision ID: 008
Revises: 007
Create Date: 2026-02-16 00:00:00.000000
"""

from alembic import op


revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS insights_result_store CASCADE")
    op.execute("DROP TABLE IF EXISTS insights_query_logs CASCADE")
    op.execute("DROP TABLE IF EXISTS insights_messages CASCADE")
    op.execute("DROP TABLE IF EXISTS insights_conversations CASCADE")


def downgrade() -> None:
    # Historical downgrade intentionally omitted: legacy chat feature was removed.
    pass
