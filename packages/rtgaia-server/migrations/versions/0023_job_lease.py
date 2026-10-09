"""工作租約 —— `job.lease_until`（微秒 ISO 字串）、`job.attempt_id`。

升級當下還在 running 的列：一般工作以「started_at ＋ 30 分鐘」換算成租約（等同舊的回收門檻，不會因為升級就被立刻重派）；
plugin／service.call（已派送給外部、由自己的 deadline 管）不給租約。attempt 標 `legacy`。

Revision ID: 0023_job_lease
Revises: 0022_storage_location
Create Date: 2026-09-30
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023_job_lease"
down_revision = "0022_storage_location"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("job", sa.Column("lease_until", sa.String(32), nullable=True))
    op.add_column("job", sa.Column("attempt_id", sa.String(32), nullable=True))
    op.execute(
        """
        UPDATE job SET attempt_id = 'legacy',
          lease_until = CASE
            WHEN kind LIKE 'plugin:%' OR kind = 'service.call' THEN NULL
            ELSE to_char((COALESCE(started_at, requested_at)::timestamptz + interval '30 minutes') AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"')
          END
        WHERE status = 'running'
        """
    )


def downgrade() -> None:
    op.drop_column("job", "attempt_id")
    op.drop_column("job", "lease_until")
