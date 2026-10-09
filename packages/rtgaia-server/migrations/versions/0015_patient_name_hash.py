"""PatientName 不以明文持久化 —— `patient.patient_name` → `patient_name_hash`（HMAC），
`instance.header` JSON 的 `patient_name` 換成 `patient_name_hash`。鍵見 `rtgaia_core.phi.phi_key()`。

Revision ID: 0015_patient_name_hash
Revises: 0014_structure_set_description
Create Date: 2026-09-24
"""

from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0015_patient_name_hash"
down_revision = "0014_structure_set_description"
branch_labels = None
depends_on = None

BATCH = 500


def upgrade() -> None:
    from rtgaia_core.phi import hash_patient_name

    bind = op.get_bind()
    op.alter_column("patient", "patient_name", new_column_name="patient_name_hash")
    rows = bind.execute(sa.text("SELECT patient_id, patient_name_hash FROM patient")).fetchall()
    for pid, name in rows:
        bind.execute(
            sa.text("UPDATE patient SET patient_name_hash = :h WHERE patient_id = :p"),
            {"h": hash_patient_name(name), "p": pid},
        )
    # instance.header：一批一批換（大目錄可能十幾萬列）
    while True:
        batch = bind.execute(
            sa.text("SELECT path, header->>'patient_name' FROM instance WHERE header ? 'patient_name' LIMIT :n"),
            {"n": BATCH},
        ).fetchall()
        if not batch:
            break
        for path, name in batch:
            bind.execute(
                sa.text(
                    "UPDATE instance SET header = (header - 'patient_name') || CAST(:patch AS jsonb) WHERE path = :path"
                ),
                {"patch": json.dumps({"patient_name_hash": hash_patient_name(name)}), "path": path},
            )


def downgrade() -> None:
    # 雜湊不可逆：回退後名字是空的（重掃目錄會從檔案重讀）
    bind = op.get_bind()
    bind.execute(sa.text("UPDATE patient SET patient_name_hash = ''"))
    op.alter_column("patient", "patient_name_hash", new_column_name="patient_name")
    bind.execute(
        sa.text(
            "UPDATE instance SET header = (header - 'patient_name_hash') || '{\"patient_name\": \"\"}'::jsonb "
            "WHERE header ? 'patient_name_hash'"
        )
    )
