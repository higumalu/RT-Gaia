"""`app_user.must_change_password`、`password_changed_at`（改密碼使既有 token 失效；臨時密碼強制改）。

Revision ID: 0018_user_password_policy
Revises: 0017_structure_interpreted_type
Create Date: 2026-09-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018_user_password_policy"
down_revision = "0017_structure_interpreted_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_user", sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("app_user", sa.Column("password_changed_at", sa.String(32), nullable=True))


def downgrade() -> None:
    op.drop_column("app_user", "password_changed_at")
    op.drop_column("app_user", "must_change_password")
