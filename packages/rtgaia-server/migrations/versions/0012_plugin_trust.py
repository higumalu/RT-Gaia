"""plugin 表加 artifact_origins（admin 核可的 artifact 來源）與 ui_digest（UI bundle sha256）

Revision ID: 0012_plugin_trust
Revises: 0011_job_kind_width
Create Date: 2026-09-23
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0012_plugin_trust"
down_revision = "0011_job_kind_width"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("plugin", sa.Column("artifact_origins", JSONB, nullable=False, server_default="[]"))
    op.add_column("plugin", sa.Column("ui_digest", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("plugin", "ui_digest")
    op.drop_column("plugin", "artifact_origins")
