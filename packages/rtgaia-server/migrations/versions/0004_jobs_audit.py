"""job 佇列與 append-only 稽核

Revision ID: 0004_jobs_audit
Revises: 0003_cases
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_jobs_audit"
down_revision = "0003_cases"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "job",
        sa.Column("job_id", sa.String(32), primary_key=True),
        sa.Column("case_id", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("phase", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("percent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("request", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("result", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("result_blob_key", sa.String(128), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("requested_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("requested_at", sa.String(32), nullable=False),
        sa.Column("started_at", sa.String(32), nullable=True),
        sa.Column("finished_at", sa.String(32), nullable=True),
        sa.Column("worker_id", sa.String(64), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_job_case_id", "job", ["case_id"])
    op.create_index("ix_job_status", "job", ["status"])
    op.create_table(
        "audit_event",
        sa.Column("event_id", sa.String(32), primary_key=True),
        sa.Column("at", sa.String(32), nullable=False),
        sa.Column("user", sa.String(64), nullable=False),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("status", sa.Integer(), nullable=False),
        sa.Column("object_type", sa.String(32), nullable=True),
        sa.Column("object_id", sa.String(128), nullable=True),
        sa.Column("case_id", sa.String(32), nullable=True),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("remote_addr", sa.String(64), nullable=True),
        sa.Column("detail", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.create_index("ix_audit_event_at", "audit_event", ["at"])
    op.create_index("ix_audit_event_user", "audit_event", ["user"])
    op.create_index("ix_audit_event_case_id", "audit_event", ["case_id"])
    # 🔴 append-only：資料庫層拒絕改寫與刪除（法規產品的正確取捨；歸檔走另外的匯出，不走 DELETE）
    op.execute(
        """
        CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'audit_event is append-only (% not allowed)', TG_OP;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_event_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_event
        FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_event_no_update_delete ON audit_event")
    op.execute("DROP FUNCTION IF EXISTS audit_event_immutable()")
    op.drop_table("audit_event")
    op.drop_table("job")
