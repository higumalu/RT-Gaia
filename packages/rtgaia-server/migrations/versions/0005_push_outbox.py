"""事件匯流排的 outbox：NOTIFY 只帶列 id，payload 在表裡

Revision ID: 0005_push_outbox
Revises: 0004_jobs_audit
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005_push_outbox"
down_revision = "0004_jobs_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_outbox",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("target", sa.String(64), nullable=False),
        sa.Column("message_type", sa.String(32), nullable=False),
        sa.Column("origin", sa.String(16), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_push_outbox_created_at", "push_outbox", ["created_at"])


def downgrade() -> None:
    op.drop_table("push_outbox")
