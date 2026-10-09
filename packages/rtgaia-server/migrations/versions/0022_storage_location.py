"""`storage_location`（每個 DICOM 檔在哪一層、sha256 基準、最後驗證）。

Revision ID: 0022_storage_location
Revises: 0021_node_pdu_ts
Create Date: 2026-09-29
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0022_storage_location"
down_revision = "0021_node_pdu_ts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "storage_location",
        sa.Column("path", sa.Text(), primary_key=True),
        sa.Column("sop_instance_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("tier", sa.String(16), nullable=False, server_default="hot"),
        sa.Column("sha256", sa.String(64), nullable=False, server_default=""),
        sa.Column("size", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("stored_at", sa.String(32), nullable=False, server_default=""),
        sa.Column("verified_at", sa.String(32), nullable=True),
        sa.Column("verify_status", sa.String(16), nullable=True),
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_storage_location_sop", "storage_location", ["sop_instance_uid"])
    op.create_index("ix_storage_location_status", "storage_location", ["verify_status"])


def downgrade() -> None:
    op.drop_index("ix_storage_location_status", table_name="storage_location")
    op.drop_index("ix_storage_location_sop", table_name="storage_location")
    op.drop_table("storage_location")
