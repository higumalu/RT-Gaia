"""`app_setting` 鍵值表的記憶體實作（從 `db/settings.py` 抽出）。

Postgres 實作在 `rtgaia_server.db.settings.DbSettings`。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class MemorySettings:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    async def get(self, key: str) -> dict[str, Any] | None:
        row = self.rows.get(key)
        return dict(row["value"]) if row else None

    async def meta(self, key: str) -> dict[str, Any] | None:
        row = self.rows.get(key)
        return {"updated_by": row["updated_by"], "updated_at": row["updated_at"]} if row else None

    async def put(self, key: str, value: dict[str, Any], *, updated_by: str) -> None:
        self.rows[key] = {"value": dict(value), "updated_by": updated_by, "updated_at": _now()}
