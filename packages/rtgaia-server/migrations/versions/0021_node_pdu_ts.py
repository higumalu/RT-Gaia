"""DIMSE 節點層級的 PDU 上限與 Transfer Syntax 偏好（`dicom_node.max_pdu`、`dicom_node.transfer_syntaxes`）。

Revision ID: 0021_node_pdu_ts
Revises: 0020_user_preferences
Create Date: 2026-09-29
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0021_node_pdu_ts"
down_revision = "0020_user_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dicom_node", sa.Column("max_pdu", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("dicom_node", sa.Column("transfer_syntaxes", JSONB, nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("dicom_node", "transfer_syntaxes")
    op.drop_column("dicom_node", "max_pdu")
