"""結構版本序號不再重複。

`structure_version.seq` 以前是版本在記憶體列表裡的位置；列表最多留 200 版，滿了之後每個新版都記成 199，
重新載入時排序不定，舊版可能排到最後 —— 下一次寫回就把 head 換成那一版。這裡把每個結構的版本沿著父版本鏈
（每一版的 parent 就是它取代的 head）從 head 往回重新編號 0..n-1，再讓 (case, structure, frame, seq) 唯一。

head 不是鏈的末端（舊問題已經發生過）時，從最新的末端往回編；鏈外的版本依舊序號與時間排在前面。
head 本身不改：內容以 DB 記的 head 為準，載入時 `rebuild_structures` 會把它放到最後並記警告。

Revision ID: 0024_version_seq
Revises: 0023_job_lease
Create Date: 2026-10-09
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "0024_version_seq"
down_revision = "0023_job_lease"
branch_labels = None
depends_on = None

_INDEX = "ix_structure_version_structure"
_COLUMNS = ["case_id", "structure_id", "frame_key", "seq"]


def _chain_order(rows: list[Any], head_id: str | None) -> list[str]:
    by_id = {r.version_id: r for r in rows}
    parents = {r.parent_version_id for r in rows if r.parent_version_id}

    def legacy(r: Any) -> tuple[int, str, str]:
        return (r.seq, r.created_at or "", r.version_id)

    tip = by_id.get(head_id) if head_id is not None and head_id not in parents else None
    if tip is None:
        tip = max((r for r in rows if r.version_id not in parents), key=legacy, default=None) or max(rows, key=legacy)
    chain: list[str] = []
    seen: set[str] = set()
    cur = tip
    while cur is not None and cur.version_id not in seen:
        chain.append(cur.version_id)
        seen.add(cur.version_id)
        cur = by_id.get(cur.parent_version_id) if cur.parent_version_id else None
    chain.reverse()
    rest = sorted((r for r in rows if r.version_id not in seen), key=legacy)
    return [r.version_id for r in rest] + chain


def upgrade() -> None:
    bind = op.get_bind()
    heads = {
        (r.case_id, r.structure_id, r.frame_key): r.head_version_id
        for r in bind.execute(sa.text("SELECT case_id, structure_id, frame_key, head_version_id FROM structure"))
    }
    groups: dict[tuple[str, str, int], list[Any]] = {}
    for r in bind.execute(
        sa.text(
            "SELECT version_id, case_id, structure_id, frame_key, seq, parent_version_id, created_at "
            "FROM structure_version"
        )
    ):
        groups.setdefault((r.case_id, r.structure_id, r.frame_key), []).append(r)
    changes: list[dict[str, Any]] = []
    for key, rows in groups.items():
        current = {r.version_id: r.seq for r in rows}
        for seq, version_id in enumerate(_chain_order(rows, heads.get(key))):
            if current[version_id] != seq:
                changes.append({"v": version_id, "s": seq})
    for i in range(0, len(changes), 1000):
        bind.execute(sa.text("UPDATE structure_version SET seq = :s WHERE version_id = :v"), changes[i : i + 1000])
    op.drop_index(_INDEX, table_name="structure_version")
    op.create_index(_INDEX, "structure_version", _COLUMNS, unique=True)


def downgrade() -> None:
    op.drop_index(_INDEX, table_name="structure_version")
    op.create_index(_INDEX, "structure_version", _COLUMNS)
