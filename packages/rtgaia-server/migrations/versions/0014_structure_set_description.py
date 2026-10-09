"""structure_set 加 description（結構集可新增／刪除／編輯，使用者可寫描述）

Revision ID: 0014_structure_set_description
Revises: 0013_audit_outbox
Create Date: 2026-09-23
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_structure_set_description"
down_revision = "0013_audit_outbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("structure_set", sa.Column("description", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("structure_set", "description")
