"""使用者表

Revision ID: 0002_users
Revises: 0001_catalog
Create Date: 2026-09-14
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_users"
down_revision = "0001_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_user",
        sa.Column("user_id", sa.String(32), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.Text(), nullable=False, server_default=""),
        sa.Column("role", sa.String(16), nullable=False, server_default="contourer"),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("last_login_at", sa.String(32), nullable=True),
        sa.Column("failed_logins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_until", sa.String(32), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("app_user")
