"""服務設定表與節點角色

Revision ID: 0007_settings_node_roles
Revises: 0006_dicom_nodes
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007_settings_node_roles"
down_revision = "0006_dicom_nodes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_setting",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("updated_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    # 既有節點：兩個角色都開（升級前本來就都接受）
    op.add_column("dicom_node", sa.Column("role_send", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("dicom_node", sa.Column("role_receive", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("dicom_node", sa.Column("inbound_ip", sa.String(64), nullable=True))
    op.add_column("dicom_node", sa.Column("description", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("dicom_node", "description")
    op.drop_column("dicom_node", "inbound_ip")
    op.drop_column("dicom_node", "role_receive")
    op.drop_column("dicom_node", "role_send")
    op.drop_table("app_setting")
