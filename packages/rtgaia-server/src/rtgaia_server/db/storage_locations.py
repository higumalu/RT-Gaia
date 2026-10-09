"""`storage_location` 的 Postgres 實作（記憶體實作 `rtgaia_core.storage.MemoryLocations`）。"""

from __future__ import annotations

from typing import Any

from rtgaia_core.storage import Location


class DbLocations:
    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def get_many(self, paths: list[str]) -> dict[str, Location]:
        from sqlalchemy import select

        from .models import StorageLocationRow

        if not paths:
            return {}
        async with self.sessions() as s:
            rows = (await s.execute(select(StorageLocationRow).where(StorageLocationRow.path.in_(paths)))).scalars()
            return {r.path: _loc(r) for r in rows}

    async def put_many(self, rows: list[Location]) -> None:
        from sqlalchemy.dialects.postgresql import insert

        from .models import StorageLocationRow

        if not rows:
            return
        async with self.sessions() as s:
            async with s.begin():
                for i in range(0, len(rows), 500):
                    values = [r.to_wire() for r in rows[i : i + 500]]
                    stmt = insert(StorageLocationRow).values(values)
                    cols = {c: stmt.excluded[c] for c in values[0] if c != "path"}
                    await s.execute(stmt.on_conflict_do_update(index_elements=["path"], set_=cols))

    async def all(self) -> list[Location]:
        from sqlalchemy import select

        from .models import StorageLocationRow

        async with self.sessions() as s:
            return [_loc(r) for r in (await s.execute(select(StorageLocationRow))).scalars()]


def _loc(r: Any) -> Location:
    return Location(
        path=r.path,
        sop_instance_uid=r.sop_instance_uid,
        tier=r.tier,
        sha256=r.sha256,
        size=int(r.size or 0),
        stored_at=r.stored_at,
        verified_at=r.verified_at,
        verify_status=r.verify_status,
        detail=r.detail or "",
    )
