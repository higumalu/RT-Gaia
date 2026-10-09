"""目錄表：patient／study／series／instance／series_ref

Revision ID: 0001_catalog
Revises:
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_catalog"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "patient",
        sa.Column("patient_id", sa.String(64), primary_key=True),
        sa.Column("patient_name", sa.Text(), nullable=False, server_default=""),
    )
    op.create_table(
        "study",
        sa.Column("study_uid", sa.String(128), primary_key=True),
        sa.Column("patient_id", sa.String(64), sa.ForeignKey("patient.patient_id", ondelete="CASCADE"), nullable=False),
        sa.Column("study_date", sa.String(8), nullable=False, server_default=""),
        sa.Column("study_description", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_study_patient_id", "study", ["patient_id"])
    op.create_table(
        "series",
        sa.Column("series_uid", sa.String(128), primary_key=True),
        sa.Column("study_uid", sa.String(128), sa.ForeignKey("study.study_uid", ondelete="CASCADE"), nullable=False),
        sa.Column("patient_id", sa.String(64), nullable=False),
        sa.Column("modality", sa.String(16), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("frame_of_reference_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("series_date", sa.String(8), nullable=False, server_default=""),
        sa.Column("series_time", sa.String(16), nullable=False, server_default=""),
        sa.Column("series_description", sa.Text(), nullable=False, server_default=""),
        sa.Column("series_number", sa.String(16), nullable=False, server_default=""),
        sa.Column("sop_class_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("manufacturer", sa.Text(), nullable=False, server_default=""),
        sa.Column("manufacturer_model_name", sa.Text(), nullable=False, server_default=""),
        sa.Column("instance_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("refs", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("links", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("structure_set_label", sa.Text(), nullable=False, server_default=""),
        sa.Column("plan_label", sa.Text(), nullable=False, server_default=""),
        sa.Column("roi_names", postgresql.ARRAY(sa.Text()), nullable=False, server_default="{}"),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_series_study_uid", "series", ["study_uid"])
    op.create_index("ix_series_patient_id", "series", ["patient_id"])
    op.create_index("ix_series_modality", "series", ["modality"])
    op.create_index("ix_series_frame_of_reference_uid", "series", ["frame_of_reference_uid"])
    op.create_index(
        "ix_series_search_text",
        "series",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    op.create_table(
        "instance",
        sa.Column("path", sa.Text(), primary_key=True),
        sa.Column("series_uid", sa.String(128), nullable=False),
        sa.Column("sop_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("mtime_ns", sa.BigInteger(), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("instance_number", sa.Integer(), nullable=True),
        sa.Column("header", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_instance_series_uid", "instance", ["series_uid"])
    op.create_index("ix_instance_sop_uid", "instance", ["sop_uid"])
    op.create_table(
        "series_ref",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("from_series_uid", sa.String(128), nullable=False),
        sa.Column("to_series_uid", sa.String(128), nullable=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("to_frame_of_reference_uid", sa.String(128), nullable=False, server_default=""),
    )
    op.create_index("ix_series_ref_from_series_uid", "series_ref", ["from_series_uid"])
    op.create_index("ix_series_ref_to_series_uid", "series_ref", ["to_series_uid"])


def downgrade() -> None:
    op.drop_table("series_ref")
    op.drop_table("instance")
    op.drop_table("series")
    op.drop_table("study")
    op.drop_table("patient")
