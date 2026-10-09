"""audit_outbox：稽核寫入失敗時的待送表

Revision ID: 0013_audit_outbox
Revises: 0012_plugin_trust
Create Date: 2026-09-23
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0013_audit_outbox"
down_revision = "0012_plugin_trust"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_outbox",
        sa.Column("event_id", sa.String(32), primary_key=True),
        sa.Column("event", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
    )
    op.create_index("ix_audit_outbox_created_at", "audit_outbox", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_audit_outbox_created_at", table_name="audit_outbox")
    op.drop_table("audit_outbox")
