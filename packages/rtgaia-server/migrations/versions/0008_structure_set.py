"""結構的來源結構集

Revision ID: 0008_structure_set
Revises: 0007_settings_node_roles
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_structure_set"
down_revision = "0007_settings_node_roles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("structure", sa.Column("structure_set_id", sa.String(160), nullable=True))


def downgrade() -> None:
    op.drop_column("structure", "structure_set_id")
