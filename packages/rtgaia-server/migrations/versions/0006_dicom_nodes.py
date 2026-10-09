"""DIMSE 節點登錄

Revision ID: 0006_dicom_nodes
Revises: 0005_push_outbox
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006_dicom_nodes"
down_revision = "0005_push_outbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dicom_node",
        sa.Column("node_id", sa.String(32), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("ae_title", sa.String(16), nullable=False),
        sa.Column("host", sa.String(255), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("our_calling_aet", sa.String(16), nullable=True),
        sa.Column("move_destination_aet", sa.String(16), nullable=True),
        sa.Column("tls", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("supports", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("last_echo_at", sa.String(32), nullable=True),
        sa.Column("last_echo_ok", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("dicom_node")
