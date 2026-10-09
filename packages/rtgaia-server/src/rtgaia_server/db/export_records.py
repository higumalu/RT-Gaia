"""匯出紀錄的 Postgres 實作（`export_record`，migration 0019）。

介面同 `rtgaia_core.export_records.MemoryExportRecords`。
"""

from __future__ import annotations

from dataclasses import fields
from typing import Any

from rtgaia_core.export_records import ExportRecord

_FIELDS = [f.name for f in fields(ExportRecord)]


class DbExportRecords:
    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def put(self, rec: ExportRecord) -> ExportRecord:
        from .models import ExportRecordRow

        async with self.sessions() as s:
            async with s.begin():
                row = await s.get(ExportRecordRow, rec.export_id)
                values = {k: getattr(rec, k) for k in _FIELDS}
                if row is None:
                    s.add(ExportRecordRow(**values))
                else:
                    for k, v in values.items():
                        setattr(row, k, v)
        return rec

    async def get(self, export_id: str) -> ExportRecord:
        from .models import ExportRecordRow

        async with self.sessions() as s:
            row = await s.get(ExportRecordRow, export_id)
            if row is None:
                raise KeyError(f"沒有匯出紀錄 {export_id}")
            return _record(row)

    async def list(
        self,
        *,
        case_id: str | None = None,
        patient_id: str | None = None,
        requested_by: str | None = None,
        kind: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[ExportRecord]:
        from sqlalchemy import select

        from .models import ExportRecordRow

        q = select(ExportRecordRow)
        if case_id is not None:
            q = q.where(ExportRecordRow.case_id == case_id)
        if patient_id is not None:
            q = q.where(ExportRecordRow.patient_ids.contains([patient_id]))
        if requested_by is not None:
            q = q.where(ExportRecordRow.requested_by == requested_by)
        if kind is not None:
            q = q.where(ExportRecordRow.kind == kind)
        if status is not None:
            q = q.where(ExportRecordRow.status == status)
        q = q.order_by(ExportRecordRow.requested_at.desc()).limit(limit)
        async with self.sessions() as s:
            return [_record(r) for r in (await s.execute(q)).scalars().all()]


def _record(row: Any) -> ExportRecord:
    return ExportRecord(**{k: getattr(row, k) for k in _FIELDS})
