"""工作集表（多人「各自新增、可合併」）

Revision ID: 0009_structure_set_table
Revises: 0008_structure_set
Create Date: 2026-09-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_structure_set_table"
down_revision = "0008_structure_set"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "structure_set",
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("structure_set_id", sa.String(160), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False, server_default="work"),
        sa.Column("label", sa.Text(), nullable=False, server_default=""),
        sa.Column("owner", sa.String(64), nullable=False, server_default=""),
        sa.Column("frame_of_reference_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("image_series_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("image_label", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(32), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("structure_set")
