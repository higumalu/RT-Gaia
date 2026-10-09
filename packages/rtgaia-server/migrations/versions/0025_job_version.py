"""工作列的寫入版本：`job.version`。

以前 `update` 整列覆寫、最後寫的贏：取消被 worker 的進度蓋回 running、plugin 早到的結果被派工的寫回蓋掉、
worker 寫進度時把領取當下的租約寫回去。現在每次寫入版本加一，寫回時版本不同就重讀重套（`jobs.mutate_job`）。

Revision ID: 0025_job_version
Revises: 0024_version_seq
Create Date: 2026-10-10
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025_job_version"
down_revision = "0024_version_seq"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("job", sa.Column("version", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("job", "version")
