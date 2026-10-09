"""`app_setting` 鍵值表：DB 與記憶體兩種實作，同一介面。值是 JSON 物件。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from rtgaia_core.settings_store import MemorySettings  # noqa: F401  舊路徑仍有效


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class DbSettings:
    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def get(self, key: str) -> dict[str, Any] | None:
        from .models import AppSettingRow

        async with self.sessions() as s:
            r = await s.get(AppSettingRow, key)
            return dict(r.value) if r is not None else None

    async def meta(self, key: str) -> dict[str, Any] | None:
        from .models import AppSettingRow

        async with self.sessions() as s:
            r = await s.get(AppSettingRow, key)
            return {"updated_by": r.updated_by, "updated_at": r.updated_at} if r is not None else None

    async def put(self, key: str, value: dict[str, Any], *, updated_by: str) -> None:
        from .models import AppSettingRow

        async with self.sessions() as s:
            async with s.begin():
                r = await s.get(AppSettingRow, key)
                if r is None:
                    s.add(AppSettingRow(key=key, value=dict(value), updated_by=updated_by, updated_at=_now()))
                else:
                    r.value, r.updated_by, r.updated_at = dict(value), updated_by, _now()
