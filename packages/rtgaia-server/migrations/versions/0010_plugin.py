"""plugin 登錄表（行程外 plugin 服務的登錄、manifest 快照、狀態）

Revision ID: 0010_plugin
Revises: 0009_structure_set_table
Create Date: 2026-09-17
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0010_plugin"
down_revision = "0009_structure_set_table"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plugin",
        sa.Column("plugin_id", sa.String(64), primary_key=True),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("token", sa.Text(), nullable=False, server_default=""),
        sa.Column("manifest", JSONB, nullable=False, server_default="{}"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("allow_licenses", JSONB, nullable=False, server_default="[]"),
        sa.Column("registered_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("last_seen_at", sa.String(32), nullable=True),
        sa.Column("health_failures", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("plugin")
