"""`export_record`（每次匯出／送出一筆，可依病人／病例／人查，可重送）；從既有的 export／send job 回填。

Revision ID: 0019_export_record
Revises: 0018_user_password_policy
Create Date: 2026-09-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0019_export_record"
down_revision = "0018_user_password_policy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "export_record",
        sa.Column("export_id", sa.String(32), primary_key=True),
        sa.Column("case_id", sa.String(32), nullable=False, server_default=""),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("target", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("requested_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("requested_at", sa.String(32), nullable=False),
        sa.Column("finished_at", sa.String(32), nullable=True),
        sa.Column("patient_ids", JSONB, nullable=False, server_default="[]"),
        sa.Column("node_id", sa.String(64), nullable=True),
        sa.Column("node_label", sa.Text, nullable=True),
        sa.Column("label", sa.Text, nullable=False, server_default=""),
        sa.Column("version_ids", JSONB, nullable=False, server_default="{}"),
        sa.Column("sop_uids_out", JSONB, nullable=False, server_default="[]"),
        sa.Column("series_uids", JSONB, nullable=False, server_default="[]"),
        sa.Column("blob_key", sa.String(128), nullable=True),
        sa.Column("blob_sha256", sa.String(64), nullable=True),
        sa.Column("profile", sa.String(32), nullable=True),
        sa.Column("anonymized", sa.Boolean, nullable=True),
        sa.Column("source_export_id", sa.String(32), nullable=True),
        sa.Column("resend_of", sa.String(32), nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("counts", JSONB, nullable=False, server_default="{}"),
        sa.Column("resend_spec", JSONB, nullable=False, server_default="{}"),
    )
    op.create_index("ix_export_record_case_id", "export_record", ["case_id"])
    op.create_index("ix_export_record_requested_by", "export_record", ["requested_by"])
    op.create_index("ix_export_record_requested_at", "export_record", ["requested_at"])
    op.create_index("ix_export_record_patient_ids", "export_record", ["patient_ids"], postgresql_using="gin")
    _backfill()


def _backfill() -> None:
    """既有的 export／send job → 紀錄。舊 job 的 result 沒有 `source_patient_id`／`sha256`：病人由病例的主影像
    （`case.selection`）推不到就留空；hash 留空（不回頭讀 blob）。"""
    from rtgaia_core.export_records import record_from_job

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT job_id, case_id, kind, status, request, result, result_blob_key, error, requested_by, "
            "requested_at, finished_at FROM job WHERE kind IN ('export', 'send') AND status IN ('done', 'failed')"
        )
    ).mappings()
    table = sa.table(
        "export_record",
        *[
            sa.column(c)
            for c in (
                "export_id case_id kind target status requested_by requested_at finished_at label node_id node_label "
                "blob_key blob_sha256 profile anonymized source_export_id resend_of error"
            ).split()
        ],
        *[sa.column(c, JSONB) for c in "patient_ids version_ids sop_uids_out series_uids counts resend_spec".split()],
    )
    out = []
    for r in rows:
        rec = record_from_job(dict(r))
        if rec is not None:
            out.append(rec.__dict__.copy())
    if out:
        op.bulk_insert(table, out)


def downgrade() -> None:
    op.drop_table("export_record")
