"""刪除 → 暫存區（14 天後自動清除或手動清除）；已簽核的被刪 → 封存區（只有管理者）。
`structure` 表加 deleted_by／deleted_set_label／archived_at／archive_note。既有已刪除的列：狀態是 approved 的歸封存區。

Revision ID: 0016_trash_archive
Revises: 0015_patient_name_hash
Create Date: 2026-09-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_trash_archive"
down_revision = "0015_patient_name_hash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("structure", sa.Column("deleted_by", sa.String(64), nullable=False, server_default=""))
    op.add_column("structure", sa.Column("deleted_set_label", sa.Text(), nullable=False, server_default=""))
    op.add_column("structure", sa.Column("archived_at", sa.String(32), nullable=True))
    op.add_column("structure", sa.Column("archive_note", sa.Text(), nullable=False, server_default=""))
    op.execute("UPDATE structure SET archived_at = deleted_at WHERE deleted_at IS NOT NULL AND status = 'approved'")


def downgrade() -> None:
    for col in ("archive_note", "archived_at", "deleted_set_label", "deleted_by"):
        op.drop_column("structure", col)
