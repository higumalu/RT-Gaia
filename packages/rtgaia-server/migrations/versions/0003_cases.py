"""病例工作狀態：case／case_frame_group／structure／structure_version／review_event／
case_transform／case_measurement

Revision ID: 0003_cases
Revises: 0002_users
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_cases"
down_revision = "0002_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rt_case",
        sa.Column("case_id", sa.String(32), primary_key=True),
        sa.Column("study_id", sa.String(128), nullable=False),
        sa.Column("source", sa.Text(), nullable=False, server_default=""),
        sa.Column("selection_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("selection", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    op.create_index("ix_rt_case_study_id", "rt_case", ["study_id"])
    op.create_table(
        "case_frame_group",
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("frame_of_reference_uid", sa.String(128), primary_key=True),
        sa.Column("frame_group", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "structure",
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("structure_id", sa.String(128), primary_key=True),
        sa.Column("frame_key", sa.Integer(), primary_key=True),  # frame_index；靜態結構 -1
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("color_rgb", postgresql.JSONB(), nullable=False),
        sa.Column("frame_of_reference_uid", sa.String(128), nullable=False),
        sa.Column("tg263_code", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("default_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("temporal_group_id", sa.String(128), nullable=True),
        sa.Column("head_version_id", sa.String(32), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.Column("deleted_at", sa.String(32), nullable=True),
    )
    op.create_table(
        "structure_version",
        sa.Column("version_id", sa.String(32), primary_key=True),
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), nullable=False),
        sa.Column("structure_id", sa.String(128), nullable=False),
        sa.Column("frame_key", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),  # 在該結構鏈裡的順序
        sa.Column("parent_version_id", sa.String(32), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),  # ＝ blob key
        sa.Column("offset_ijk", postgresql.JSONB(), nullable=False),
        sa.Column("size_ijk", postgresql.JSONB(), nullable=False),
        sa.Column("voxel_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("provenance", postgresql.JSONB(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("client_seq", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index(
        "ix_structure_version_structure", "structure_version", ["case_id", "structure_id", "frame_key", "seq"]
    )
    op.create_table(
        "review_event",
        sa.Column("event_id", sa.String(32), primary_key=True),
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_review_event_case", "review_event", ["case_id", "seq"])
    op.create_table(
        "case_transform",
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("transform_id", sa.String(32), primary_key=True),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "case_measurement",
        sa.Column("case_id", sa.String(32), sa.ForeignKey("rt_case.case_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("measurement_id", sa.String(64), primary_key=True),
        sa.Column("body", postgresql.JSONB(), nullable=False),
    )


def downgrade() -> None:
    for t in (
        "case_measurement",
        "case_transform",
        "review_event",
        "structure_version",
        "structure",
        "case_frame_group",
        "rt_case",
    ):
        op.drop_table(t)
