"""plugin 登錄的儲存：記憶體與 Postgres 同介面（與 `db/nodes.py` 同模式）。"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from rtgaia_core.plugin_store import MemoryPlugins, PluginRecord  # noqa: F401  舊路徑仍有效


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class DbPlugins:
    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def list(self) -> list[PluginRecord]:
        from sqlalchemy import select

        from .models import PluginRow

        async with self.sessions() as s:
            rows = (await s.execute(select(PluginRow).order_by(PluginRow.created_at))).scalars().all()
            return [_from_row(r) for r in rows]

    async def get(self, plugin_id: str) -> PluginRecord | None:
        from .models import PluginRow

        async with self.sessions() as s:
            row = await s.get(PluginRow, plugin_id)
            return _from_row(row) if row else None

    async def put(self, rec: PluginRecord) -> PluginRecord:
        from .models import PluginRow

        rec.updated_at = _now()
        async with self.sessions() as s:
            row = await s.get(PluginRow, rec.plugin_id)
            data = asdict(rec)
            if row is None:
                s.add(PluginRow(**data))
            else:
                for k, v in data.items():
                    setattr(row, k, v)
            await s.commit()
        return rec

    async def delete(self, plugin_id: str) -> None:
        from .models import PluginRow

        async with self.sessions() as s:
            row = await s.get(PluginRow, plugin_id)
            if row is not None:
                await s.delete(row)
                await s.commit()


def _from_row(r: Any) -> PluginRecord:
    return PluginRecord(
        plugin_id=r.plugin_id,
        endpoint=r.endpoint,
        token=r.token or "",
        manifest=dict(r.manifest or {}),
        enabled=bool(r.enabled),
        status=r.status,
        error=r.error,
        allow_licenses=list(r.allow_licenses or []),
        registered_by=r.registered_by or "",
        created_at=r.created_at,
        updated_at=r.updated_at,
        last_seen_at=r.last_seen_at,
        health_failures=int(r.health_failures or 0),
        artifact_origins=list(getattr(r, "artifact_origins", None) or []),
        ui_digest=getattr(r, "ui_digest", None),
    )
