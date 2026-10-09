"""`structure.interpreted_type`（RTROIInterpretedType）—— 匯出 profile 用來源類型，沒有才依名字推。

Revision ID: 0017_structure_interpreted_type
Revises: 0016_trash_archive
Create Date: 2026-09-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_structure_interpreted_type"
down_revision = "0016_trash_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("structure", sa.Column("interpreted_type", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("structure", "interpreted_type")
