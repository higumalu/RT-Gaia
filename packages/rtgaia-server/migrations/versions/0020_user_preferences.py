"""`app_user.preferences`（介面偏好跨電腦跟著帳號：版面、側欄、密度、語言…）。

Revision ID: 0020_user_preferences
Revises: 0019_export_record
Create Date: 2026-09-29
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0020_user_preferences"
down_revision = "0019_export_record"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_user", sa.Column("preferences", JSONB, nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("app_user", "preferences")
