"""job.kind 放寬到 64 字（plugin job kind 是 `plugin:<plugin id>`，plugin id 最長 41 字）

Revision ID: 0011_job_kind_width
Revises: 0010_plugin
Create Date: 2026-09-17
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011_job_kind_width"
down_revision = "0010_plugin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("job", "kind", type_=sa.String(64), existing_type=sa.String(16), existing_nullable=False)


def downgrade() -> None:
    # 回退會截斷：plugin:<id> 這類長 kind 的 job 先刪（downgrade 本來就是破壞性的；測試的 downgrade_base 會走到這裡）
    op.execute("DELETE FROM job WHERE length(kind) > 16")
    op.alter_column("job", "kind", type_=sa.String(16), existing_type=sa.String(64), existing_nullable=False)
